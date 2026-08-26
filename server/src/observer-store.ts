import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ObservedRoom } from './observer-types.js'
import { canonicalRoomId, validateRoom } from './observer-validate.js'

/**
 * Concurrent `/stream` connections one room may fan out to. Each is a held-open
 * socket plus an EventEmitter listener; without a bound an anonymous client
 * could accumulate both without limit.
 */
export const MAX_STREAM_SUBSCRIBERS_PER_ROOM = 64

/**
 * Raised when a compare-and-set `put` observes a document that changed since
 * the caller read it. Named so callers can report a retryable conflict instead
 * of a generic validation failure.
 */
export class ObserverRevisionConflictError extends Error {}

/**
 * Raised when `mergeFreshness` is asked to move `latestObservedL1Block`
 * backwards or nowhere. A decrease is only legal through the full write path
 * with a corroborated reorg declaration, never through the heartbeat merge.
 */
export class ObserverFreshnessRegressionError extends Error {}

export interface ObserverPutOptions {
  /**
   * Compare-and-set revision the caller read; `null` means "no revision
   * observed". Omit the field for an unconditional replace.
   */
  expectedRevision?: string | null
  /**
   * Permits `latestObservedL1Block` to move backwards. Only the observer
   * write route sets this, and only after corroborating a declared reorg fork
   * point against the coordinator's own quorum L1 read.
   */
  allowFreshnessRegression?: boolean
}

/**
 * Crash-safe public observation archive.
 *
 * This is not settlement authority. Every stored batch is expected to have
 * already passed the pinned L1 verifier. Consumers can compare the returned
 * commitments with RoomManager; missing public batch data is reported as
 * commitments-only instead of fabricating transactions from L1 events.
 */
export class ObserverStore {
  private readonly events = new EventEmitter()
  /**
   * Parsed + validated rooms keyed on the archive path, invalidated by file
   * identity (mtime/size). Every observer route revalidated the whole archive
   * synchronously on every unauthenticated request, so cost grew with room age
   * and a read loop starved the event loop. Bounded in insertion order so a
   * stream of distinct room ids cannot grow the map.
   */
  private readonly cache = new Map<string, { mtimeMs: number; size: number; room: ObservedRoom }>()

  constructor(
    private readonly directory: string,
    private readonly maxCachedRooms = 256,
  ) {
    mkdirSync(directory, { recursive: true })
  }

  private path(id: string): string {
    const canonical = canonicalRoomId(id)
    if (!canonical) throw new Error('invalid room id')
    return join(this.directory, `${canonical}.json`)
  }

  private remember(path: string, room: ObservedRoom): void {
    let stats
    try {
      stats = statSync(path)
    } catch {
      // Without a stable identity the entry can never be invalidated safely.
      this.cache.delete(path)
      return
    }
    if (!this.cache.has(path) && this.cache.size >= this.maxCachedRooms) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    this.cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, room })
  }

  get(id: string): ObservedRoom | null {
    const path = this.path(id)
    try {
      const stats = statSync(path)
      const cached = this.cache.get(path)
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.room
      }
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ObservedRoom
      validateRoom(parsed)
      this.remember(path, parsed)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.delete(path)
        return null
      }
      throw error
    }
  }

  /** Durable temp+fsync+rename write shared by every mutation path. */
  private persist(path: string, next: ObservedRoom): void {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(next)}\n`, 'utf8')
      const descriptor = openSync(temporary, 'r+')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, path)
      this.remember(path, next)
    } catch (error) {
      this.cache.delete(path)
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary file may not exist; preserve the original failure.
      }
      throw error
    }
  }

  /**
   * Durable replace of a room archive.
   *
   * `expectedRevision` (or `options.expectedRevision`) opts into
   * compare-and-set: the write is refused unless the stored document still
   * carries the revision the caller read. Writers that hold the document
   * across an `await` (the admission path signs a receipt between read and
   * write) must pass it, otherwise a concurrent indexer write is silently
   * overwritten with a stale snapshot. Pass `undefined` for an unconditional
   * replace. Returns the document as persisted.
   */
  put(room: ObservedRoom, revisionOrOptions?: string | null | ObserverPutOptions): ObservedRoom {
    validateRoom(room)
    const options: ObserverPutOptions =
      revisionOrOptions !== null && typeof revisionOrOptions === 'object'
        ? revisionOrOptions
        : { expectedRevision: revisionOrOptions }
    const path = this.path(room.roomId)
    let stored: ObservedRoom | null
    if (options.expectedRevision !== undefined) {
      stored = this.get(room.roomId)
      if ((stored?.revision ?? null) !== options.expectedRevision) {
        throw new ObserverRevisionConflictError('the observed room changed since it was read')
      }
    } else {
      // An unconditional replace stays usable against an unreadable archive:
      // it is the only path that can overwrite a corrupt file.
      try {
        stored = this.get(room.roomId)
      } catch {
        stored = null
      }
    }
    let next =
      options.expectedRevision !== undefined
        ? { ...room, revision: (BigInt(stored?.revision ?? '0') + 1n).toString() }
        : room
    // Freshness is advance-only: the admission path reads the document, then
    // awaits recovery and signing before writing it back, so a heartbeat merge
    // that advanced `latestObservedL1Block` in between must survive the stale
    // write-back. Regression is reserved for the write route's corroborated
    // reorg.
    if (
      stored &&
      options.allowFreshnessRegression !== true &&
      BigInt(next.latestObservedL1Block) < BigInt(stored.latestObservedL1Block)
    ) {
      next = {
        ...next,
        latestObservedL1Block: stored.latestObservedL1Block,
        headBlockHash: stored.headBlockHash,
      }
    }
    this.persist(path, next)
    // Notified only after the durable rename, and outside the try: a listener
    // that throws used to propagate out of `put()` with the archive already
    // written, so the caller saw a rejection for a write that had succeeded.
    this.events.emit(`room:${next.roomId}`, next)
    return next
  }

  /**
   * Field-scoped freshness merge against the CURRENT stored document.
   *
   * A whole-document CAS heartbeat every ~96 s per room would either starve
   * admission writes with revision conflicts or be clobbered by them, so only
   * the two freshness fields are patched and the revision is deliberately NOT
   * bumped: a CAS writer that read the document before this merge must still
   * win its write (the advance-only clamp in `put` preserves what this merge
   * moved forward). Advance is required; a decrease takes the full write path
   * with a corroborated reorg.
   */
  mergeFreshness(
    roomId: string,
    patch: { latestObservedL1Block: string; headBlockHash: `0x${string}` },
  ): ObservedRoom {
    const current = this.get(roomId)
    if (!current) throw new Error('no observed room to merge freshness into')
    if (!/^(0|[1-9][0-9]*)$/.test(patch.latestObservedL1Block)) {
      throw new Error('latest observed L1 block must be a canonical uint')
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(patch.headBlockHash)) {
      throw new Error('head block hash must be a 32-byte hexadecimal identifier')
    }
    if (BigInt(patch.latestObservedL1Block) <= BigInt(current.latestObservedL1Block)) {
      throw new ObserverFreshnessRegressionError(
        'a freshness merge may only advance the observed L1 block',
      )
    }
    const next = {
      ...current,
      latestObservedL1Block: patch.latestObservedL1Block,
      headBlockHash: patch.headBlockHash,
    }
    this.persist(this.path(roomId), next)
    this.events.emit(`room:${next.roomId}`, next)
    return next
  }

  /** Live subscribers per room, so the stream route can refuse a fan-out. */
  subscriberCount(id: string): number {
    const canonical = canonicalRoomId(id)
    if (!canonical) return 0
    return this.events.listenerCount(`room:${canonical}`)
  }

  subscribe(id: string, listener: (room: ObservedRoom) => void): () => void {
    const canonical = canonicalRoomId(id)
    if (!canonical) throw new Error('invalid room id')
    const event = `room:${canonical}`
    // One listener per live SSE connection. The default ceiling of 10 emitted
    // a MaxListenersExceededWarning per subscriber past the tenth; the real
    // bound is MAX_STREAM_SUBSCRIBERS_PER_ROOM, enforced by the route.
    this.events.setMaxListeners(MAX_STREAM_SUBSCRIBERS_PER_ROOM * 2)
    // A throwing listener must not take down the write that notified it, nor
    // starve the listeners registered after it.
    const guarded = (room: ObservedRoom) => {
      try {
        listener(room)
      } catch {
        // Detaching is the subscriber's job (the stream route drops itself on
        // the first write failure); a dead socket must not fail the writer.
      }
    }
    this.events.on(event, guarded)
    return () => this.events.off(event, guarded)
  }
}
