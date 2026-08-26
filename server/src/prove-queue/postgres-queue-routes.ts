import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HostedRuntime } from '../hosted-runtime.js'
import { hasHostedRole, type HostedPrincipal, type HostedRole } from '../hosted-types.js'
import { HostedAuthError, HostedFenceError } from '../postgres-hosted-store.js'
import { isProveEndpoint } from './queue-types.js'
import { emitHostedTrace } from '../structured-log.js'
import { requestCorrelationId } from '../correlation.js'

const BODY_LIMIT = 64 * 1024 * 1024
const SWEEP_MS = 30_000

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function queueError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof HostedAuthError) return reply.code(403).send({ error: error.message })
  if (error instanceof HostedFenceError) return reply.code(503).send({ error: 'coordinator writer is fenced' })
  const message = error instanceof Error ? error.message : 'queue request failed'
  if (/cap reached|capacity reached/.test(message)) return reply.code(429).send({ error: message })
  if (/idempotency|different request|immutable/.test(message)) return reply.code(409).send({ error: message })
  if (/invalid|required|must|unknown|no verified/.test(message)) return reply.code(400).send({ error: message })
  throw error
}

/**
 * PostgreSQL/ObjectStore queue surface used whenever hosted mode is enabled.
 * The older file queue is deliberately registered only for explicit local
 * standalone mode; there is no hosted fallback if either authority is down.
 */
export function registerPostgresProveQueueRoutes(
  app: FastifyInstance,
  runtime: HostedRuntime,
  chainId: number,
): void {
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'api-key' | 'node',
    role: HostedRole,
  ): Promise<HostedPrincipal | null> => {
    const token = bearer(request)
    if (!token) {
      void reply.code(401).send({ error: 'bearer credential required' })
      return null
    }
    const principal = await runtime.store.authenticate(token, kind)
    if (!principal) {
      void reply.code(401).send({ error: 'credential is invalid, expired, or revoked' })
      return null
    }
    if (!hasHostedRole(principal, role)) {
      void reply.code(403).send({ error: `role ${role} required` })
      return null
    }
    if (!await runtime.store.consumePrincipalRate(principal.principalId, principal.limits.requestsPerMinute)) {
      void reply.code(429).send({ error: 'tenant request rate exceeded' })
      return null
    }
    return principal
  }

  const sweeper = setInterval(() => {
    try {
      void runtime.store.sweepProveLeases(runtime.writableFence()).catch(() => {})
    } catch {
      // Standby/fenced replicas never mutate the shared queue.
    }
  }, SWEEP_MS)
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  app.post<{ Body: Record<string, unknown> }>(
    '/queue/v1/jobs',
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const principal = await authenticate(request, reply, 'api-key', 'job-submit')
      if (!principal) return reply
      try {
        const body = bodyObject(request.body)
        if (!isProveEndpoint(body.endpoint)) return reply.code(400).send({ error: 'invalid prover endpoint' })
        if (body.request === undefined) return reply.code(400).send({ error: 'request is required' })
        const idempotencyHeader = request.headers['idempotency-key']
        const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader
        if (!idempotencyKey || idempotencyKey.length > 200) {
          return reply.code(400).send({ error: 'Idempotency-Key is required and must not exceed 200 characters' })
        }
        const proofClass = typeof body.proofClass === 'string' ? body.proofClass : ''
        const serviceClass = body.serviceClass ?? 'standard'
        if (!['standard', 'latency', 'batch'].includes(String(serviceClass))) {
          return reply.code(400).send({ error: 'invalid serviceClass' })
        }
        const partition = body.partition ?? 'shared'
        if (!['shared', 'reserved', 'dedicated'].includes(String(partition))) {
          return reply.code(400).send({ error: 'invalid partition' })
        }
        if (partition !== 'shared' && !hasHostedRole(principal, 'capacity-manage')) {
          return reply.code(403).send({ error: 'capacity-manage role required for non-shared jobs' })
        }
        const deadlineAt = body.deadlineAt === undefined || body.deadlineAt === null
          ? null
          : String(body.deadlineAt)
        if (deadlineAt !== null && !Number.isFinite(Date.parse(deadlineAt))) {
          return reply.code(400).send({ error: 'deadlineAt must be an ISO timestamp' })
        }
        const priority = body.priority === undefined ? 0 : Number(body.priority)
        if (principal.walletSession && (
          Number(principal.walletSession.chainId)!==chainId
          || String(body.allocationId ?? '').toLowerCase()!==principal.walletSession.allocationId
          || String(body.roomId ?? '')!==principal.walletSession.roomId
        )) return reply.code(403).send({ error:'wallet session is scoped to another room or allocation' })
        if (body.billingMode !== 'quoted') {
          return reply.code(400).send({
            error: 'tenant queue submissions require billingMode=quoted and an accepted maximum charge',
          })
        }
        const maximumChargeAmount = body.maximumChargeAmount === undefined || body.maximumChargeAmount === null
          ? null : String(body.maximumChargeAmount)
        const maximumChargeCurrency = body.maximumChargeCurrency === undefined || body.maximumChargeCurrency === null
          ? null : String(body.maximumChargeCurrency)
        if ((maximumChargeAmount === null) !== (maximumChargeCurrency === null)) {
          return reply.code(400).send({ error: 'maximumChargeAmount and maximumChargeCurrency must be supplied together' })
        }
        if (maximumChargeAmount === null) {
          return reply.code(400).send({ error: 'quoted work requires maximumChargeAmount and maximumChargeCurrency' })
        }
        const canonical = canonicalJson({
          endpoint: body.endpoint,
          proofClass,
          request: body.request,
          roomId: body.roomId ?? null,
          allocationId: body.allocationId ?? null,
          sponsorshipId: body.sponsorshipId ?? null,
          serviceClass,
          partition,
          correlationId: body.correlationId ?? null,
          retryOfJobId: body.retryOfJobId ?? null,
          deadlineAt,
          priority,
          billingMode: 'quoted',
          maximumChargeAmount,
          maximumChargeCurrency,
        })
        const bytes = new TextEncoder().encode(JSON.stringify(body.request))
        const requestHash = createHash('sha256').update(canonical).digest('hex')
        const stored = await runtime.objects.putContent(bytes, 'application/json')
        const jobId = `pj-${createHash('sha256')
          .update(`${principal.tenantId}\0${idempotencyKey}`)
          .digest('hex')
          .slice(0, 20)}`
        const submitted = await runtime.store.submitProveJob(runtime.writableFence(), {
          jobId,
          retryOfJobId: body.retryOfJobId === undefined || body.retryOfJobId === null
            ? null : String(body.retryOfJobId),
          chainId,
          tenantId: principal.tenantId,
          roomId: body.roomId === undefined || body.roomId === null ? null : String(body.roomId),
          allocationId: body.allocationId === undefined || body.allocationId === null ? null : String(body.allocationId),
          sponsorshipId: body.sponsorshipId === undefined || body.sponsorshipId === null ? null : String(body.sponsorshipId),
          serviceClass: serviceClass as 'standard' | 'latency' | 'batch',
          correlationId: body.correlationId === undefined || body.correlationId === null ? null : String(body.correlationId),
          partition: partition as 'shared' | 'reserved' | 'dedicated',
          proofClass,
          endpoint: body.endpoint,
          idempotencyKey,
          requestHash,
          requestObjectKey: stored.key,
          requestBytes: stored.bytes,
          deadlineAt,
          priority,
          billingMode: 'quoted',
          maximumChargeAmount,
          maximumChargeCurrency,
        })
        emitHostedTrace({
          correlationId:submitted.job.correlationId ?? requestCorrelationId(request),
          tenantId:submitted.job.tenantId,roomId:submitted.job.roomId,jobId:submitted.job.jobId,
          component:'queue',event:'job.submit',outcome:'succeeded',
        })
        return reply.code(submitted.already ? 200 : 202).send({
          jobId: submitted.job.jobId,
          status: submitted.job.status,
          already: submitted.already,
        })
      } catch (error) {
        return queueError(reply, error)
      }
    },
  )

  app.get<{ Params: { id: string } }>('/queue/v1/jobs/:id', async (request, reply) => {
    const principal = await authenticate(request, reply, 'api-key', 'job-read')
    if (!principal) return reply
    const job = await runtime.store.getProveJob(request.params.id, principal.tenantId)
    if (!job) return reply.code(404).send({ error: 'job not found' })
    if (principal.walletSession && (
      job.allocationId?.toLowerCase()!==principal.walletSession.allocationId
      || job.roomId!==principal.walletSession.roomId
    )) return reply.code(404).send({ error:'job not found' })
    return job
  })

  app.get<{ Params: { id: string } }>('/queue/v1/jobs/:id/result', async (request, reply) => {
    const principal = await authenticate(request, reply, 'api-key', 'job-read')
    if (!principal) return reply
    const job = await runtime.store.getProveJob(request.params.id, principal.tenantId)
    if (principal.walletSession && job && (
      job.allocationId?.toLowerCase()!==principal.walletSession.allocationId
      || job.roomId!==principal.walletSession.roomId
    )) return reply.code(404).send({ error:'no result is available' })
    if (!job?.resultObjectKey || job.status !== 'DONE') {
      return reply.code(404).send({ error: 'no result is available' })
    }
    const bytes = await runtime.objects.get(job.resultObjectKey)
    if (!bytes) return reply.code(503).send({ error: 'durable result object is unavailable' })
    return reply.type('application/json').send(Buffer.from(bytes))
  })

  app.post('/queue/v1/lease', async (request, reply) => {
    const principal = await authenticate(request, reply, 'node', 'prove-node')
    if (!principal) return reply
    try {
      const job = await runtime.store.leaseProveJob(runtime.writableFence(), principal.principalId)
      if (!job) return reply.code(204).send()
      emitHostedTrace({
        correlationId:job.correlationId ?? requestCorrelationId(request),tenantId:job.tenantId,
        roomId:job.roomId,jobId:job.jobId,component:'queue',event:'job.lease',outcome:'started',
      })
      const bytes = await runtime.objects.get(job.requestObjectKey)
      if (!bytes) {
        await runtime.store.failProveJob(
          runtime.writableFence(), job.jobId, principal.principalId,
          'REQUEST_OBJECT_MISSING', false,
        )
        return reply.code(503).send({ error: 'durable request object is unavailable' })
      }
      let requestBody: unknown
      try {
        requestBody = JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        await runtime.store.failProveJob(
          runtime.writableFence(), job.jobId, principal.principalId,
          'REQUEST_OBJECT_MALFORMED', false,
        )
        return reply.code(503).send({ error: 'durable request object is malformed' })
      }
      return {
        jobId: job.jobId,
        endpoint: job.endpoint,
        proofClass: job.proofClass,
        needsGpu: job.needsGpu,
        attempts: job.attempts,
        leaseExpiresAt: job.leaseExpiresAt,
        // A null correlation id would make the agent's `parseLeasedJob`
        // refuse the lease outright; submitters may omit it, so the job id
        // stands in as the correlation join key.
        correlationId: job.correlationId ?? job.jobId,
        tenantId: job.tenantId,
        roomId: job.roomId,
        request: requestBody,
      }
    } catch (error) {
      return queueError(reply, error)
    }
  })

  app.post<{ Params: { id: string } }>('/queue/v1/jobs/:id/heartbeat', async (request, reply) => {
    const principal = await authenticate(request, reply, 'node', 'prove-node')
    if (!principal) return reply
    try {
      const job = await runtime.store.heartbeatProveJob(
        runtime.writableFence(), request.params.id, principal.principalId,
      )
      return { jobId: job.jobId, leaseExpiresAt: job.leaseExpiresAt }
    } catch (error) {
      return queueError(reply, error)
    }
  })

  app.post<{ Params: { id: string }; Body: { result?: unknown } }>(
    '/queue/v1/jobs/:id/complete',
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const principal = await authenticate(request, reply, 'node', 'prove-node')
      if (!principal) return reply
      if (request.body?.result === undefined) return reply.code(400).send({ error: 'result is required' })
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(request.body.result))
        const stored = await runtime.objects.putContent(bytes, 'application/json')
        // HEAD after PUT is intentional: DONE is gated on an independently
        // retrievable immutable object, not only a successful upload response.
        const verified = await runtime.objects.head(stored.key)
        if (!verified || verified.sha256 !== stored.sha256 || verified.bytes !== stored.bytes) {
          return reply.code(503).send({ error: 'result object archive verification failed' })
        }
        const roundTrip = await runtime.objects.get(verified.key)
        if (
          !roundTrip
          || roundTrip.byteLength !== bytes.byteLength
          || createHash('sha256').update(roundTrip).digest('hex') !== verified.sha256
          || !Buffer.from(roundTrip).equals(Buffer.from(bytes))
        ) return reply.code(503).send({ error: 'result object archive retrieval verification failed' })
        const completed = await runtime.store.completeProveJob(
          runtime.writableFence(), request.params.id, principal.principalId,
          verified.key, verified.sha256,
        )
        emitHostedTrace({
          correlationId:completed.job.correlationId ?? requestCorrelationId(request),
          tenantId:completed.job.tenantId,roomId:completed.job.roomId,jobId:completed.job.jobId,
          component:'queue',event:'job.complete',outcome:'succeeded',
        })
        return { jobId: completed.job.jobId, status: completed.job.status, already: completed.already }
      } catch (error) {
        return queueError(reply, error)
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { code?: unknown; retryable?: unknown } }>(
    '/queue/v1/jobs/:id/fail',
    async (request, reply) => {
      const principal = await authenticate(request, reply, 'node', 'prove-node')
      if (!principal) return reply
      try {
        const code = typeof request.body?.code === 'string' && request.body.code
          ? request.body.code
          : 'PROVER_REPORTED_FAILURE'
        const job = await runtime.store.failProveJob(
          runtime.writableFence(), request.params.id, principal.principalId,
          code, request.body?.retryable === true,
        )
        emitHostedTrace({
          correlationId:job.correlationId ?? requestCorrelationId(request),tenantId:job.tenantId,
          roomId:job.roomId,jobId:job.jobId,component:'queue',event:'job.complete',
          outcome:request.body?.retryable===true ? 'retrying' : 'failed',
        })
        return { jobId: job.jobId, status: job.status, attempts: job.attempts }
      } catch (error) {
        return queueError(reply, error)
      }
    },
  )

  app.get('/queue/v1/status', async (request, reply) => {
    const principal = await authenticate(request, reply, 'api-key', 'job-read')
    if (!principal) return reply
    const jobs=await runtime.store.listProveJobs(principal.tenantId,500)
    return { jobs:principal.walletSession ? jobs.filter((job) =>
      job.allocationId?.toLowerCase()===principal.walletSession!.allocationId
      && job.roomId===principal.walletSession!.roomId) : jobs }
  })
}
