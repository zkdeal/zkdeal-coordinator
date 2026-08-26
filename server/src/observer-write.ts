import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Hex } from 'viem'
import { RateLimiter } from './quota.js'
import type { ServerConfig } from './config.js'
import {
  createL1BlockHashReader,
  createL1FinalizedBlockReader,
} from './admission.js'
import { FinalizedAnchorStore } from './finalized-anchor-store.js'
import {
  ObserverFreshnessRegressionError,
  ObserverRevisionConflictError,
  ObserverStore,
} from './observer-store.js'
import type { ObservedRoom } from './observer-types.js'
import { canonicalRoomId, validateRoomV2 } from './observer-validate.js'

/**
 * A full v2 archive for a long-lived room, with headroom. Bounded so a single
 * PUT cannot hold the JSON parser on an arbitrarily large body.
 */
const MAX_ARCHIVE_PUT_BYTES = 8 * 1024 * 1024

/** Full-document rewrites are per accepted batch or reorg, not per block. */
const INDEXER_PUT_BURST = 60
const INDEXER_PUT_PER_SEC = 2

/**
 * Heartbeats arrive per room roughly every 96 s; the budget fits a fleet of
 * rooms behind one indexer address without admitting an anonymous flood.
 */
const INDEXER_FRESHNESS_BURST = 600
const INDEXER_FRESHNESS_PER_SEC = 20

export interface ObserverWriteReaders {
  /** Two-RPC agreed canonical hash for one block number; null when unknown. */
  getBlockHash: (blockNumber: bigint) => Promise<Hex | null>
  /** Two-RPC agreed finalized-tag head. */
  getFinalized: () => Promise<{ number: bigint; hash: Hex }>
}

export interface ObserverWriteOptions {
  store: ObserverStore
  config: Pick<ServerConfig, 'indexerToken' | 'dataDir' | 'l1RpcUrls'>
  /** Injectable for tests; defaults to the quorum readers over `l1RpcUrls`. */
  readers?: ObserverWriteReaders
  /** Injectable for tests; defaults to a JSON file under `dataDir`. */
  anchors?: FinalizedAnchorStore
}

/**
 * PENDING facts may leave the archive only by becoming terminal. The
 * coordinator itself wrote the pending admissions (each one a signed,
 * slashable receipt) and users rely on the pending deposits, so an indexer
 * that simply omits either would un-commit a receipt - over-committing the
 * bond - or censor a depositor. Presence-with-identity-or-terminal-status is
 * decidable from the two documents alone; no "observed on chain" clause that
 * this server cannot check.
 */
function droppedPendingKeys(stored: ObservedRoom, incoming: ObservedRoom): string[] {
  const dropped: string[] = []
  const incomingLatest = BigInt(incoming.latestObservedL1Block)
  const admissionWindow = BigInt(stored.maximumAdmissionWindow)
  const admissions = new Map(incoming.admissions.map((entry) => [entry.admissionId, entry]))
  for (const entry of stored.admissions) {
    if (entry.status !== 'PENDING') continue
    // Past deadline + window the receipt can no longer be included or
    // challenged into the bond, so the indexer may age it out.
    if (incomingLatest > BigInt(entry.deadlineBlock) + admissionWindow) continue
    const next = admissions.get(entry.admissionId)
    const identical =
      next !== undefined &&
      next.transactionHash === entry.transactionHash &&
      next.depositInboxId === entry.depositInboxId &&
      next.depositContentHash === entry.depositContentHash &&
      next.deadlineBlock === entry.deadlineBlock &&
      next.maximumBatchIndex === entry.maximumBatchIndex
    if (!identical) dropped.push(`admission:${entry.admissionId}`)
  }
  const deposits = new Map(incoming.deposits.map((entry) => [entry.inboxId, entry]))
  for (const entry of stored.deposits) {
    if (entry.status !== 'PENDING') continue
    const next = deposits.get(entry.inboxId)
    const identical =
      next !== undefined &&
      next.depositor === entry.depositor &&
      next.beneficiary === entry.beneficiary &&
      next.asset === entry.asset &&
      next.amount === entry.amount &&
      next.queuedAtBlock === entry.queuedAtBlock &&
      next.queuedAtBlockHash === entry.queuedAtBlockHash
    if (!identical) dropped.push(`deposit:${entry.inboxId}`)
  }
  return dropped
}

/** Key order is serializer-dependent, so identity is compared key-sorted. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Below the finalized anchor L1 cannot reorg, so an archived fact anchored
 * there may never change. Batches are immutable wholesale (every field is
 * fixed at acceptance); only the stored batch's own fields are compared, so
 * the first v2 write may still ADD `acceptedL1BlockHash` to a grandfathered
 * v1 batch. Deposits pin their queue-time identity while status and
 * consumedBatch stay mutable - consumption happens at a later block.
 */
function finalizedFactViolation(
  stored: ObservedRoom,
  incoming: ObservedRoom,
  anchorBlock: bigint,
): string | null {
  const floor = incoming.archiveFloor ? BigInt(incoming.archiveFloor.batchIndex) : null
  const batches = new Map(incoming.batches.map((entry) => [entry.batchIndex, entry]))
  for (const entry of stored.batches) {
    if (BigInt(entry.acceptedL1Block) > anchorBlock) continue
    const next = batches.get(entry.batchIndex)
    if (!next) {
      // Trimming a finalized batch is legitimate retention, but only when the
      // incoming document declares a floor above it.
      if (floor !== null && BigInt(entry.batchIndex) < floor) continue
      return `finalized batch ${entry.batchIndex} was dropped`
    }
    const storedRecord = entry as unknown as Record<string, unknown>
    const nextRecord = next as unknown as Record<string, unknown>
    for (const key of Object.keys(storedRecord)) {
      if (canonicalJson(storedRecord[key]) !== canonicalJson(nextRecord[key])) {
        return `finalized batch ${entry.batchIndex} was rewritten`
      }
    }
  }
  const deposits = new Map(incoming.deposits.map((entry) => [entry.inboxId, entry]))
  for (const entry of stored.deposits) {
    if (BigInt(entry.queuedAtBlock) > anchorBlock) continue
    const next = deposits.get(entry.inboxId)
    if (
      !next ||
      next.depositor !== entry.depositor ||
      next.beneficiary !== entry.beneficiary ||
      next.asset !== entry.asset ||
      next.amount !== entry.amount ||
      next.queuedAtBlock !== entry.queuedAtBlock ||
      next.queuedAtBlockHash !== entry.queuedAtBlockHash
    ) {
      return `finalized deposit ${entry.inboxId} was dropped or rewritten`
    }
  }
  return null
}

/**
 * Authenticated indexer write surface. The coordinator is the only disk
 * writer: the external indexer PUTs through here so single-writer semantics,
 * SSE notification and the cache stay intact - and so every rule below still
 * holds when the INDEXER_TOKEN itself is compromised, which is the threat
 * model this surface is designed against.
 */
export function registerObserverWriteRoutes(
  app: FastifyInstance,
  options: ObserverWriteOptions,
): void {
  const { store, config } = options
  const token = config.indexerToken ? Buffer.from(config.indexerToken) : null
  // Readers are built lazily behind the credential: a coordinator with no
  // indexer never needs the quorum (and may carry a single RPC endpoint).
  const readers =
    options.readers ??
    (token
      ? {
          getBlockHash: createL1BlockHashReader(config.l1RpcUrls),
          getFinalized: createL1FinalizedBlockReader(config.l1RpcUrls),
        }
      : null)
  const anchors =
    options.anchors ??
    new FinalizedAnchorStore(join(config.dataDir, 'observer-finalized-anchor.json'))
  const putLimiter = new RateLimiter(INDEXER_PUT_BURST, INDEXER_PUT_PER_SEC)
  const freshnessLimiter = new RateLimiter(INDEXER_FRESHNESS_BURST, INDEXER_FRESHNESS_PER_SEC)

  /**
   * Shared gate for both write routes: availability, per-IP burst, then the
   * constant-time credential (mirroring AdmissionService.authorizedOperator),
   * then the canonical room id. Returns null after sending the response.
   */
  const authorized = (
    request: FastifyRequest,
    reply: FastifyReply,
    limiter: RateLimiter,
  ): string | null => {
    if (!token) {
      void reply.code(503).send({
        decision: 'INDEXER_WRITES_UNAVAILABLE',
        reason: 'This coordinator has no configured indexer credential.',
        nextAction: 'Configure INDEXER_TOKEN on the coordinator that owns this archive.',
      })
      return null
    }
    if (!limiter.take(request.ip)) {
      void reply.code(429).send({
        decision: 'RATE_LIMITED',
        reason: 'This client exceeded the coordinator indexer write rate.',
      })
      return null
    }
    const authorization = request.headers.authorization
    const supplied = authorization?.startsWith('Bearer ')
      ? Buffer.from(authorization.slice('Bearer '.length))
      : null
    if (!supplied || supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      void reply.header('www-authenticate', 'Bearer realm="zkdeal-indexer"')
      void reply.code(401).send({
        decision: 'NOT_AUTHORIZED',
        reason: 'This route requires the coordinator indexer credential.',
      })
      return null
    }
    const roomId = canonicalRoomId((request.params as { id?: string }).id)
    if (!roomId) {
      void reply.code(400).send({
        decision: 'INVALID_ROOM',
        reason: 'Use a positive room number.',
      })
      return null
    }
    return roomId
  }

  app.put<{ Params: { id: string }; Body: ObservedRoom }>(
    '/observer/v1/rooms/:id',
    { bodyLimit: MAX_ARCHIVE_PUT_BYTES },
    async (request, reply) => {
      const roomId = authorized(request, reply, putLimiter)
      if (!roomId || !readers) return reply
      const ifMatch =
        typeof request.headers['if-match'] === 'string'
          ? request.headers['if-match'].trim()
          : undefined
      if (ifMatch === undefined || !/^(0|[1-9][0-9]*)$/.test(ifMatch)) {
        return reply.code(428).send({
          decision: 'PRECONDITION_REQUIRED',
          reason:
            'Send If-Match with the revision this document was read at (0 before the first write).',
        })
      }
      // Revision numbering starts at 1, so 0 is unambiguously "nothing stored".
      const expectedRevision = ifMatch === '0' ? null : ifMatch
      const body = request.body
      try {
        if (typeof body !== 'object' || body === null) {
          throw new Error('the archive document must be a JSON object')
        }
        if (body.roomId !== roomId) throw new Error('the archive room id must match the route')
        validateRoomV2(body)
      } catch (error) {
        return reply.code(422).send({
          decision: 'INVALID_ARCHIVE',
          reason: error instanceof Error ? error.message : 'archive validation failed',
        })
      }
      let stored: ObservedRoom | null
      try {
        stored = store.get(roomId)
      } catch {
        return reply.code(503).send({
          decision: 'ARCHIVE_UNAVAILABLE',
          reason: 'The observation archive for this room cannot currently be read.',
        })
      }
      const anchor = anchors.current()
      if (stored) {
        const droppedKeys = droppedPendingKeys(stored, body)
        if (droppedKeys.length > 0) {
          return reply.code(409).send({ error: 'MERGE_CONFLICT', droppedKeys })
        }
        if (
          BigInt(body.latestObservedL1Block) < BigInt(stored.latestObservedL1Block) &&
          !body.reorg
        ) {
          return reply.code(409).send({
            error: 'REORG_UNCORROBORATED',
            reason: 'latestObservedL1Block may only decrease with a declared, corroborated reorg',
          })
        }
      }
      let corroboratedReorg = false
      if (body.reorg) {
        const forkPointBlock = BigInt(body.reorg.forkPointBlock)
        let canonical: Hex | null
        try {
          canonical = await readers.getBlockHash(forkPointBlock)
        } catch {
          // Provider disagreement is not corroboration.
          canonical = null
        }
        if (!canonical || canonical.toLowerCase() !== body.reorg.forkPointHash.toLowerCase()) {
          return reply.code(409).send({
            error: 'REORG_UNCORROBORATED',
            reason: 'the declared fork point is not canonical on this coordinator L1 quorum',
          })
        }
        if (anchor && forkPointBlock < anchor.block) {
          // Alert-shaped: finality undercuts ride a distinct channel from
          // routine reorg notices.
          request.log.error(
            {
              alert: 'FINALITY_UNDERCUT',
              roomId,
              forkPointBlock: body.reorg.forkPointBlock,
              anchorBlock: anchor.block.toString(),
            },
            'indexer declared a reorg fork point below the finalized anchor',
          )
          return reply.code(409).send({
            error: 'FINALITY_VIOLATION',
            reason: 'the declared fork point undercuts the finalized anchor',
          })
        }
        corroboratedReorg = true
      }
      if (stored && anchor) {
        const violation = finalizedFactViolation(stored, body, anchor.block)
        if (violation) {
          request.log.error(
            { alert: 'FINALITY_UNDERCUT', roomId, violation },
            'indexer attempted to rewrite a fact below the finalized anchor',
          )
          return reply.code(409).send({ error: 'FINALITY_VIOLATION', reason: violation })
        }
      }
      // The anchor advances only from this coordinator's own finalized-tag
      // reads, never from the PUT body; an unreadable tag leaves it in place.
      try {
        const finalized = await readers.getFinalized()
        anchors.advance(finalized.number, finalized.hash)
      } catch {
        request.log.warn({ roomId }, 'finalized anchor not advanced: quorum read unavailable')
      }
      try {
        const written = store.put(body, {
          expectedRevision,
          allowFreshnessRegression: corroboratedReorg,
        })
        return { revision: written.revision }
      } catch (error) {
        if (error instanceof ObserverRevisionConflictError) {
          return reply.code(409).send({
            error: 'REVISION_CONFLICT',
            reason: 'the observed room changed since it was read',
          })
        }
        // Node filesystem messages carry the archive path and pid; keep the
        // raw error server-side and answer with a fixed reason.
        request.log.error({ error, roomId }, 'observer write failed internally')
        return reply.code(503).send({
          decision: 'ARCHIVE_UNAVAILABLE',
          reason: 'The observation archive for this room cannot currently be written.',
        })
      }
    },
  )

  app.patch<{
    Params: { id: string }
    Body: { latestObservedL1Block?: string; headBlockHash?: string }
  }>('/observer/v1/rooms/:id/freshness', { bodyLimit: 4096 }, async (request, reply) => {
    const roomId = authorized(request, reply, freshnessLimiter)
    if (!roomId) return reply
    const latest = request.body?.latestObservedL1Block
    const head = request.body?.headBlockHash
    if (
      typeof latest !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(latest) ||
      typeof head !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(head)
    ) {
      return reply.code(400).send({
        decision: 'INVALID_FRESHNESS',
        reason: 'Send latestObservedL1Block (decimal) and headBlockHash (32-byte hexadecimal).',
      })
    }
    let stored: ObservedRoom | null
    try {
      stored = store.get(roomId)
    } catch {
      return reply.code(503).send({
        decision: 'ARCHIVE_UNAVAILABLE',
        reason: 'The observation archive for this room cannot currently be read.',
      })
    }
    if (!stored) {
      return reply.code(404).send({
        decision: 'ROOM_NOT_OBSERVED',
        reason: 'No accepted batch has been indexed for this room.',
      })
    }
    try {
      const merged = store.mergeFreshness(roomId, {
        latestObservedL1Block: latest,
        headBlockHash: head as Hex,
      })
      return { latestObservedL1Block: merged.latestObservedL1Block }
    } catch (error) {
      if (error instanceof ObserverFreshnessRegressionError) {
        return reply.code(409).send({
          error: 'FRESHNESS_CONFLICT',
          reason: 'a freshness merge may only advance the observed L1 block',
        })
      }
      request.log.error({ error, roomId }, 'freshness merge failed internally')
      return reply.code(503).send({
        decision: 'ARCHIVE_UNAVAILABLE',
        reason: 'The observation archive for this room cannot currently be written.',
      })
    }
  })
}
