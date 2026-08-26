import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  recoverMessageAddress,
  type Abi,
  type AbiParameter,
  type Hex,
} from 'viem'
import type { ServerConfig } from './config.js'
import {
  hasHostedRole,
  validatePrincipalRoles,
  type HostedPrincipal,
  type HostedPrincipalKind,
  type HostedRole,
} from './hosted-types.js'
import type { HostedRuntime } from './hosted-runtime.js'
import type { AdmissionService } from './admission.js'
import type { BlobPublisher } from './blob-publisher.js'
import type { WithdrawalProofService } from './withdrawal-service.js'
import type { WithdrawalWitness } from './withdrawal-proofs.js'
import type { ManagedL1Publisher } from './managed-l1-publisher.js'
import type { ManagedBlobPublisher } from './managed-blob-publisher.js'
import { buildBlobBundleFromBlobs,encodeBlobBundle } from './blob-archive.js'
import { loadContractAbi } from './hosted-indexer.js'
import {
  canonicalExecutionPolicyV5,
  executionPolicyHashV5,
  liabilitiesHashV5,
} from './execution-policy-v5.js'
import {
  HOSTED_L1_BINDING_ROLE,
  HostedAuthError,
  HostedFenceError,
  HostedPromotionError,
} from './postgres-hosted-store.js'
import {
  HOSTING_API_SCHEMA,
  HOSTING_OPENAPI,
  hostingCapabilities,
} from './hosting-capabilities.js'

const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/
const PRINCIPAL_ID = /^(?:key|node|svc)_[0-9a-f]{20}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const QUANTITY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/
const HEX_32 = /^0x[0-9a-fA-F]{64}$/
const RESOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const MAX_GLOBAL_SSE_CONNECTIONS = 2_048
const MAX_SSE_BUFFERED_BYTES = 1024 * 1024
const SSE_POLL_MS = 500
const SSE_SLOT_TTL_MS = 30_000
const NODE_HEARTBEAT_ABI = [{
  type: 'function',name: 'reportNodeHeartbeat',stateMutability: 'nonpayable',
  inputs: [{ name: 'nodeId',type: 'bytes32' },{ name: 'profileHash',type: 'bytes32' }],outputs: [],
}] as const
const NODE_HEARTBEAT_SELECTOR = '0x7cd0e630'

interface HostingRouteOptions {
  config: ServerConfig
  runtime: HostedRuntime | null
  admission?: AdmissionService | null
  publisher?: BlobPublisher | null
  nodeHeartbeatPublisher?: ManagedL1Publisher | null
  roomBatchPublisher?: ManagedL1Publisher | null
  roomAggregatePublisher?: ManagedBlobPublisher | null
  poolSponsorPublisher?: ManagedL1Publisher | null
  poolFinalityPublisher?: ManagedL1Publisher | null
  poolBeneficiaryPublisher?: ManagedL1Publisher | null
  /** Test-only acceptance switch. Production callers must leave this unset. */
  roomBatchCapabilityOverride?: boolean
  withdrawals?: WithdrawalProofService | null
}

interface Authenticated {
  admin: boolean
  principal: HostedPrincipal | null
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

function constantTimeTokenEqual(left: string | null, right: string | null): boolean {
  if (!left || !right) return false
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function positiveInt(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`value must be an integer from 1 through ${maximum}`)
  }
  return parsed
}

function nonnegativeInt(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`value must be an integer from 0 through ${maximum}`)
  }
  return parsed
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('string array required')
  }
  return value
}

function cleanTenantId(value: unknown): string {
  if (typeof value !== 'string' || !TENANT_ID.test(value)) throw new Error('invalid tenant id')
  return value
}

function cleanDecimal(value: unknown, name: string): string {
  const text = String(value ?? '')
  if (!DECIMAL.test(text)) throw new Error(`${name} must be an unsigned decimal integer`)
  return text
}

function cleanHash(value: unknown, name: string): `0x${string}` {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw new Error(`${name} must be 32-byte hex`)
  return value.toLowerCase() as `0x${string}`
}

function cleanAddress(value: unknown, name: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hexadecimal address`)
  }
  return value.toLowerCase() as `0x${string}`
}

function cleanWalletOrigin(domainValue:unknown,uriValue:unknown):{ domain:string;uri:string } {
  if (typeof domainValue!=='string' || domainValue.length<1 || domainValue.length>253
    || domainValue!==domainValue.toLowerCase() || /[\s/@]/.test(domainValue)) {
    throw new Error('domain must be a lowercase DNS authority')
  }
  if (typeof uriValue!=='string' || uriValue.length>2_048) throw new Error('uri is invalid')
  let parsed:URL
  try { parsed=new URL(uriValue) } catch { throw new Error('uri is invalid') }
  if (parsed.protocol!=='https:' || parsed.host.toLowerCase()!==domainValue
    || parsed.username || parsed.password || parsed.hash) {
    throw new Error('uri must be an HTTPS origin on the exact challenge domain')
  }
  return { domain:domainValue,uri:parsed.toString() }
}

function cleanHexData(value: unknown, name: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${name} must be even-length hexadecimal data`)
  }
  return value.toLowerCase() as `0x${string}`
}

function cleanQuantity(value: unknown, name: string, allowZero = false): string {
  const text = String(value ?? '')
  if (!QUANTITY.test(text) || (!allowZero && Number(text) <= 0)) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} decimal with at most 18 fractional digits`)
  }
  return text
}

function cleanResourceId(value: unknown, name: string): string {
  const text = String(value ?? '')
  if (!RESOURCE_ID.test(text)) throw new Error(`${name} is invalid`)
  return text
}

function cleanTimestamp(value: unknown, name: string, nullable = false): string | null {
  if ((value === null || value === undefined) && nullable) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`)
  }
  return new Date(Date.parse(value)).toISOString()
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new Error('Idempotency-Key header is required and must contain 8 through 200 characters')
  }
  return value
}

function requireCorrelationId(request: FastifyRequest): string {
  const value=request.headers['x-correlation-id']
  if (typeof value!=='string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new Error('X-Correlation-Id header is required and must contain 8 through 200 safe characters')
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value==='object') {
    return `{${Object.entries(value as Record<string,unknown>)
      .filter(([,item]) => item!==undefined)
      .sort(([left],[right]) => left.localeCompare(right))
      .map(([key,item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function cleanDigest(value: unknown,name: string): string {
  const digest=String(value ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 digest`)
  return digest
}

function jsonObject(bytes: Uint8Array | null,name: string): Record<string,unknown> {
  if (!bytes) throw new Error(`${name} object is unavailable`)
  let value:unknown
  try { value=JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new Error(`${name} object is malformed`) }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${name} object must be JSON object`)
  return value as Record<string,unknown>
}

function base64Hex(value: unknown,name: string): Hex {
  if (typeof value!=='string' || value.length===0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${name} must be canonical base64`)
  }
  const bytes=Buffer.from(value,'base64')
  if (bytes.length===0 || bytes.toString('base64').replace(/=+$/,'')!==value.replace(/=+$/,'')) {
    throw new Error(`${name} must be canonical base64`)
  }
  return `0x${bytes.toString('hex')}` as Hex
}

function base64Blob(value:unknown,name:string):Hex {
  const encoded=base64Hex(value,name)
  if ((encoded.length-2)/2!==131_072) throw new Error(`${name} must encode exactly one 128 KiB EIP-4844 blob`)
  return encoded
}

function coerceAbiValue(parameter: AbiParameter,value: unknown,path: string): unknown {
  const array=/^(.*)\[([0-9]*)\]$/.exec(parameter.type)
  if (array) {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
    if (array[2] && value.length!==Number(array[2])) throw new Error(`${path} has the wrong fixed length`)
    const element={ ...parameter,type:array[1]! } as AbiParameter
    return value.map((item,index) => coerceAbiValue(element,item,`${path}[${index}]`))
  }
  if (parameter.type==='tuple') {
    const object=record(value)
    const components='components' in parameter ? parameter.components : []
    const names=new Set(components.map((component) => component.name).filter(Boolean))
    if (Object.keys(object).some((key) => !names.has(key))) throw new Error(`${path} has unknown tuple fields`)
    return Object.fromEntries(components.map((component,index) => {
      const name=component.name || String(index)
      if (!(name in object)) throw new Error(`${path}.${name} is required`)
      return [name,coerceAbiValue(component,object[name],`${path}.${name}`)]
    }))
  }
  if (/^u?int[0-9]*$/.test(parameter.type)) {
    return BigInt(cleanDecimal(value,path))
  }
  if (parameter.type==='bool') {
    if (typeof value!=='boolean') throw new Error(`${path} must be boolean`)
    return value
  }
  if (parameter.type==='address') return cleanAddress(value,path)
  if (parameter.type==='bytes') return cleanHexData(value,path)
  const fixed=/^bytes([0-9]+)$/.exec(parameter.type)
  if (fixed) {
    const next=cleanHexData(value,path)
    if ((next.length-2)/2!==Number(fixed[1])) throw new Error(`${path} has the wrong byte length`)
    return next
  }
  if (parameter.type==='string') {
    if (typeof value!=='string') throw new Error(`${path} must be string`)
    return value
  }
  throw new Error(`${path} uses unsupported ABI type ${parameter.type}`)
}

function reconciliationErrors(
  roomId: string,
  headBlock: string,
  headHash: string,
  document: Record<string, unknown>,
): string[] {
  const errors: string[] = []
  if (document.roomId !== undefined && String(document.roomId) !== roomId) errors.push('document.roomId mismatch')
  if (document.headBlock !== undefined && String(document.headBlock) !== headBlock) errors.push('document.headBlock mismatch')
  if (
    document.headHash !== undefined
    && String(document.headHash).toLowerCase() !== headHash.toLowerCase()
  ) errors.push('document.headHash mismatch')
  const latestBatch = document.latestBatch
  if (latestBatch && typeof latestBatch === 'object' && !Array.isArray(latestBatch)) {
    const batch = latestBatch as Record<string, unknown>
    if (batch.batchIndex !== undefined && !DECIMAL.test(String(batch.batchIndex))) {
      errors.push('latestBatch.batchIndex is not an unsigned integer')
    }
    for (const field of ['preStateRoot', 'postStateRoot', 'journalHash']) {
      if (batch[field] !== undefined && !HEX_32.test(String(batch[field]))) {
        errors.push(`latestBatch.${field} is not 32-byte hex`)
      }
    }
  }
  const liabilities = document.liabilities
  if (Array.isArray(liabilities)) {
    for (const [index, item] of liabilities.entries()) {
      const amount = item && typeof item === 'object' ? (item as Record<string, unknown>).amount : undefined
      if (amount !== undefined && !DECIMAL.test(String(amount))) errors.push(`liabilities[${index}].amount is invalid`)
    }
  }
  return errors
}

export function registerHostingRoutes(app: FastifyInstance, options: HostingRouteOptions): void {
  const {
    config,runtime,admission,publisher,withdrawals,nodeHeartbeatPublisher,roomBatchPublisher,
    roomAggregatePublisher,
    poolSponsorPublisher,poolFinalityPublisher,poolBeneficiaryPublisher,
  } = options
  let roomManagerAbi: Abi | null = null
  let roomPoolAbi: Abi | null = null
  let roomPoolHostingAbi: Abi | null = null
  const submitBatchFunction = () => {
    roomManagerAbi ??= loadContractAbi(
      join(config.contractsOut,'IRoomManager.sol','IRoomManager.json'),
    ) as Abi
    const fn=roomManagerAbi.find((item) => item.type==='function' && item.name==='submitBatch')
    if (!fn || fn.type!=='function' || fn.inputs.length!==2) {
      throw new Error('current RoomManager submitBatch ABI is unavailable')
    }
    const submission=fn.inputs[1]
    if (submission?.type!=='tuple' || !('components' in submission) || submission.components[0]?.name!=='journal') {
      throw new Error('current RoomManager BatchSubmission ABI is malformed')
    }
    return fn
  }
  const submitAggregateFunction = () => {
    roomManagerAbi ??= loadContractAbi(
      join(config.contractsOut,'IRoomManager.sol','IRoomManager.json'),
    ) as Abi
    const fn=roomManagerAbi.find((item) => item.type==='function' && item.name==='submitAggregate')
    if (!fn || fn.type!=='function' || fn.inputs.length!==1) {
      throw new Error('current RoomManager submitAggregate ABI is unavailable')
    }
    const aggregate=fn.inputs[0]
    if (aggregate?.type!=='tuple' || !('components' in aggregate)
      || aggregate.components[0]?.name!=='members' || aggregate.components[1]?.name!=='aggregateSeal') {
      throw new Error('current RoomManager AggregateSubmission ABI is malformed')
    }
    return fn
  }
  const depositEntryFunction = () => {
    roomManagerAbi ??= loadContractAbi(
      join(config.contractsOut,'IRoomManager.sol','IRoomManager.json'),
    ) as Abi
    const fn=roomManagerAbi.find((item) => item.type==='function' && item.name==='depositEntry')
    if (!fn || fn.type!=='function' || fn.inputs.length!==2 || fn.outputs.length!==1) {
      throw new Error('current RoomManager depositEntry ABI is unavailable')
    }
    return fn
  }
  const allocationStateFunction = () => {
    roomPoolAbi ??= loadContractAbi(
      join(config.contractsOut,'RoomPoolManager.sol','RoomPoolManager.json'),
    ) as Abi
    const fn=roomPoolAbi.find((item) => item.type==='function' && item.name==='allocationState')
    if (!fn || fn.type!=='function' || fn.inputs.length!==1 || fn.outputs.length!==1) {
      throw new Error('current RoomPool allocationState ABI is unavailable')
    }
    return fn
  }
  const roomPoolFunction=(name:string,inputs:number) => {
    roomPoolAbi ??= loadContractAbi(
      join(config.contractsOut,'RoomPoolManager.sol','RoomPoolManager.json'),
    ) as Abi
    roomPoolHostingAbi ??= loadContractAbi(
      join(config.contractsOut,'RoomPoolHostingFacet.sol','RoomPoolHostingFacet.json'),
    ) as Abi
    const fn=[...roomPoolAbi,...roomPoolHostingAbi]
      .find((item) => item.type==='function' && item.name===name)
    if (!fn || fn.type!=='function' || fn.inputs.length!==inputs) {
      throw new Error(`current RoomPool ${name} ABI is unavailable`)
    }
    return fn
  }

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith('/hosting/')) {
      const message = error instanceof Error ? error.message : 'invalid request'
      if (/idempotency.*different|another immutable request|already bound to different immutable authority|proving policy.*different immutable|does not match the canonical room policyHash/i.test(message)) {
        return reply.code(409).send({ error: message })
      }
      if (/artifact lineage|lineage differs|identity differs|differs from its|differ from the exact|is not a production live|not one production recursive|not the exact completed|not bound to the live|is not bound to its|do not have one exact identity|do not cover its journal cursor|do not share one deploymentDomain|contains an unacknowledged admission|carries DA proof identity|is not aggregate-contiguous|submission cap is six blobs|changed live witness identity|differs from the proved|did not verify the exact|admissionIds do not exactly|differs from the immutable ACKED/i.test(message)) {
        return reply.code(409).send({ error: message })
      }
      if (/object is unavailable|result bytes changed digest/i.test(message)) {
        return reply.code(503).send({ error: message })
      }
      if (/invalid|required|must|JSON object|string array|integer|unsigned|malformed/i.test(message)) {
        return reply.code(400).send({ error: message })
      }
    }
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined
    const status = typeof statusCode === 'number' && statusCode >= 400
      ? statusCode
      : 500
    const message = error instanceof Error ? error.message : 'request failed'
    return reply.code(status).send({ error: status >= 500 ? 'internal service error' : message })
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/hosting/')) return
    const requested = request.headers['accept-schema-version']
    const version = Array.isArray(requested) ? requested[0] : requested
    if (version !== undefined && version !== String(HOSTING_API_SCHEMA)) {
      return reply.code(406).send({
        error: 'unsupported API schema',
        supportedSchemaVersions: [HOSTING_API_SCHEMA],
      })
    }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/hosting/')) {
      reply.header('content-schema-version', String(HOSTING_API_SCHEMA))
    }
    return payload
  })

  const requireRuntime = (reply: FastifyReply): HostedRuntime | null => {
    if (runtime) return runtime
    reply.code(503).send({ error: 'hosted PostgreSQL authority is not configured' })
    return null
  }

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    role?: HostedRole,
    kind?: HostedPrincipalKind,
    allowAdmin = false,
  ): Promise<Authenticated | null> => {
    const hosted = requireRuntime(reply)
    if (!hosted) return null
    const token = bearer(request)
    if (allowAdmin && config.allowDevStaticAdmin && constantTimeTokenEqual(token, config.hostingAdminToken)) {
      return { admin: true, principal: null }
    }
    if (!token) {
      reply.code(401).send({ error: 'bearer credential required' })
      return null
    }
    const principal = await hosted.store.authenticate(token, kind)
    if (!principal) {
      reply.code(401).send({ error: 'credential is invalid, expired, or revoked' })
      return null
    }
    if (!await hosted.store.consumePrincipalRate(principal.principalId, principal.limits.requestsPerMinute)) {
      reply.code(429).send({ error: 'tenant request rate exceeded' })
      return null
    }
    if (allowAdmin && principal.roles.includes('hosting-admin')) {
      return { admin: true, principal }
    }
    if (role && !hasHostedRole(principal, role)) {
      reply.code(403).send({ error: `role ${role} required` })
      return null
    }
    return { admin: false, principal }
  }

  const mutating = async <T>(reply: FastifyReply, fn: (hosted: HostedRuntime) => Promise<T>) => {
    const hosted = requireRuntime(reply)
    if (!hosted) return { ok: false as const }
    try {
      return { ok: true as const, value: await fn(hosted) }
    } catch (error) {
      if (error instanceof HostedFenceError) {
        reply.code(503).send({ error: 'coordinator writer is fenced' })
        return { ok: false as const }
      }
      if (error instanceof HostedAuthError) {
        reply.code(404).send({ error: error.message })
        return { ok: false as const }
      }
      throw error
    }
  }

  const cleanChainId = (value: unknown): number => {
    const chainId = positiveInt(value, config.chainId, Number.MAX_SAFE_INTEGER)
    if (chainId !== config.chainId) {
      throw new Error(`chainId must equal configured chain ${config.chainId}`)
    }
    return chainId
  }

  app.get('/hosting/v1/capabilities', async () => hostingCapabilities(
    config,
    runtime?.status() ?? null,
    { roomBatchAcceptanceOverride: options.roomBatchCapabilityOverride },
  ))
  app.get('/hosting/v1/openapi.json', async () => HOSTING_OPENAPI)
  app.get('/hosting/v1/health', async () => ({ ok: true, runtime: runtime?.status() ?? null }))
  app.get('/hosting/v1/ready', async (_request, reply) => {
    const status = runtime ? await runtime.verifyReady() : null
    if (!status?.ready) return reply.code(503).send({ ready: false, runtime: status })
    return { ready: true, runtime: status }
  })

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/auth/wallet/challenges',
    async (request,reply) => {
      const hosted=requireRuntime(reply)
      if (!hosted) return reply
      const correlationId=requireCorrelationId(request)
      const body=record(request.body)
      const tenantId=cleanTenantId(body.tenantId)
      const chainId=cleanChainId(body.chainId)
      const allocationId=cleanHash(body.allocationId,'allocationId')
      const walletAddress=cleanAddress(body.walletAddress,'walletAddress')
      const origin=cleanWalletOrigin(body.domain,body.uri)
      const sessionTtlSeconds=positiveInt(body.sessionTtlSeconds,900,3_600)
      if (sessionTtlSeconds<600) throw new Error('sessionTtlSeconds must be at least 600')
      const authority=await hosted.store.canonicalAllocationAuthority(chainId,tenantId,allocationId)
      if (!authority) return reply.code(404).send({ error:'canonical tenant allocation was not found' })
      const result=await mutating(reply,(active) => active.store.createWalletChallenge(
        active.writableFence(),{
          tenantId,chainId,allocationId,walletAddress,...origin,sessionTtlSeconds,
          idempotencyKey:requireIdempotencyKey(request),
        },
      ))
      if (!result.ok) return reply
      reply.header('x-correlation-id',correlationId)
      return reply.code(result.value.created ? 201 : 200).send({
        schemaVersion:1,...result.value.challenge,
        signatureScheme:'eip191-eoa',erc1271Supported:false,created:result.value.created,
      })
    },
  )

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/auth/wallet/sessions',
    async (request,reply) => {
      const hosted=requireRuntime(reply)
      if (!hosted) return reply
      const correlationId=requireCorrelationId(request)
      const body=record(request.body)
      const challengeId=String(body.challengeId ?? '')
      if (!/^wch_[0-9a-f]{24}$/.test(challengeId)) throw new Error('challengeId is invalid')
      const signature=cleanHexData(body.signature,'signature')
      if (signature.length!==132) throw new Error('signature must be a 65-byte EOA signature')
      const challenge=await hosted.store.walletChallenge(challengeId)
      if (!challenge) return reply.code(404).send({ error:'wallet challenge was not found' })
      let recovered:`0x${string}`
      try {
        recovered=(await recoverMessageAddress({ message:challenge.message,signature })).toLowerCase() as `0x${string}`
      } catch {
        return reply.code(401).send({ error:'wallet signature is invalid' })
      }
      if (recovered!==challenge.walletAddress) {
        return reply.code(401).send({ error:'wallet signature does not match the challenged account' })
      }
      await hosted.assertCriticalL1Ready()
      const [head,canonicalHead,authority]=await Promise.all([
        hosted.l1.agreedBlock('latest'),
        hosted.store.canonicalHead(challenge.chainId),
        hosted.store.canonicalAllocationAuthority(
          challenge.chainId,challenge.tenantId,challenge.allocationId,
        ),
      ])
      if (!canonicalHead || canonicalHead.number!==head.number
        || canonicalHead.hash.toLowerCase()!==head.hash.toLowerCase()) {
        return reply.code(503).send({ error:'wallet authority requires an exactly indexed canonical head' })
      }
      if (!authority) return reply.code(403).send({ error:'wallet allocation authority is no longer canonical' })
      const fn=allocationStateFunction()
      const call=await hosted.l1.agreedCall({
        to:config.roomPool,
        data:encodeFunctionData({ abi:[fn],functionName:'allocationState',args:[challenge.allocationId] }),
        blockTag:{ blockHash:head.hash,requireCanonical:true },
      })
      const providers=head.verifiedSources.filter((source) => call.verifiedSources.includes(source))
      if (new Set(providers).size<2) {
        return reply.code(503).send({ error:'wallet authority lacks two-provider hash-bound evidence' })
      }
      const allocation=record(decodeFunctionResult({ abi:[fn],functionName:'allocationState',data:call.data }))
      if (cleanAddress(allocation.user,'allocation.user')!==challenge.walletAddress
        || cleanDecimal(allocation.roomId,'allocation.roomId')!==authority.roomId
        || cleanDecimal(allocation.status,'allocation.status')!=='2') {
        return reply.code(403).send({ error:'wallet is not the current used-allocation authority' })
      }
      const issued=await mutating(reply,(active) => active.store.issueWalletSession(
        active.writableFence(),{
          challengeId,signature,idempotencyKey:requireIdempotencyKey(request),authority,
          authorityHead:{ number:head.number,hash:head.hash },
        },
      ))
      if (!issued.ok) return reply
      reply.header('x-correlation-id',correlationId)
      return reply.code(issued.value.already ? 200 : 201).send({
        schemaVersion:1,...issued.value,roles:['job-submit','job-read'],
        scope:{ chainId:issued.value.chainId,allocationId:issued.value.allocationId,roomId:issued.value.roomId },
        receiptSource:{ providerIds:[...new Set(providers)].sort(),observedAt:new Date().toISOString(),canonical:true },
      })
    },
  )

  app.get('/hosting/v1/auth/wallet/session',async (request,reply) => {
    const auth=await authenticate(request,reply,'job-read','api-key')
    if (!auth?.principal) return reply
    const scope=auth.principal.walletSession
    if (!scope) return reply.code(403).send({ error:'wallet allocation session required' })
    return {
      schemaVersion:1,principalId:auth.principal.principalId,tenantId:auth.principal.tenantId,
      walletAddress:scope.walletAddress,roles:auth.principal.roles,scope,
    }
  })

  app.delete('/hosting/v1/auth/wallet/session',async (request,reply) => {
    const auth=await authenticate(request,reply,'job-read','api-key')
    if (!auth?.principal) return reply
    if (!auth.principal.walletSession) return reply.code(403).send({ error:'wallet allocation session required' })
    const result=await mutating(reply,(active) => active.store.revokeWalletSession(
      active.writableFence(),auth.principal!.principalId,requireIdempotencyKey(request),
    ))
    if (!result.ok) return reply
    if (!result.value) return reply.code(404).send({ error:'wallet allocation session is not active' })
    return reply.code(204).send()
  })

  app.post('/hosting/v1/admin/promote', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const idempotencyKey = requireIdempotencyKey(request)
    let promoted: boolean
    try {
      promoted = await runtime!.promote()
    } catch (error) {
      if (error instanceof HostedPromotionError) {
        return reply.code(503).send({
          promoted: false,
          code: error.code,
          error: error.message,
          runtime: runtime!.status(),
        })
      }
      throw error
    }
    if (!promoted) return reply.code(409).send({ promoted: false, runtime: runtime!.status() })
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: auth.principal?.tenantId ?? null,
      principalId: auth.principal?.principalId ?? null,
      action: 'coordinator.promote', target: config.coordinatorId,
      idempotencyKey, details: { runtime: runtime!.status() },
    })
    return { promoted: true, runtime: runtime!.status() }
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/tenants', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const tenantId = cleanTenantId(body.tenantId)
    const updated = await mutating(reply, async (hosted) => hosted.store.upsertTenant(hosted.writableFence(), {
      tenantId,
      displayName: typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim().slice(0, 200)
        : tenantId,
      tier: typeof body.tier === 'string' && body.tier.trim() ? body.tier.trim().slice(0, 64) : 'standard',
      limits: body.limits === undefined ? undefined : record(body.limits),
    }))
    if (!updated.ok) return reply
    return reply.code(201).send({ tenantId })
  })

  app.post<{ Params: { tenantId: string }; Body: Record<string, unknown> }>(
    '/hosting/v1/tenants/:tenantId/principals',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'tenant-admin', undefined, true)
      if (!auth) return reply
      const tenantId = cleanTenantId(request.params.tenantId)
      if (!auth.admin && auth.principal!.tenantId !== tenantId) {
        return reply.code(403).send({ error: 'cross-tenant principal provisioning is forbidden' })
      }
      const body = record(request.body)
      const kind = body.kind
      if (kind !== 'api-key' && kind !== 'node' && kind !== 'service') {
        return reply.code(400).send({ error: 'kind must be api-key, node, or service' })
      }
      const roles = strings(body.roles) as HostedRole[]
      const allowedRoles = new Set<HostedRole>([
        'hosting-admin', 'tenant-admin', 'room-operator', 'job-submit', 'job-read', 'deadline-set',
        'usage-read', 'withdrawal-read', 'withdrawal-claim', 'capacity-manage', 'indexer-write',
        'l1-publish', 'l1-liveness', 'l1-room-submit',
        'l1-aggregate-submit','l1-pool-sponsor','l1-pool-finality-oracle','l1-pool-beneficiary',
        'prove-node',
      ])
      if (roles.length === 0 || roles.some((role) => !allowedRoles.has(role))) {
        return reply.code(400).send({ error: 'one or more roles are invalid' })
      }
      try {
        validatePrincipalRoles(kind, roles)
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message })
      }
      if (!auth.admin && (kind === 'service' || roles.includes('prove-node'))) {
        return reply.code(403).send({
          error: 'service and provider-node principals are issued only by the hosting authority',
        })
      }
      const issued = await mutating(reply, async (hosted) => hosted.store.provisionPrincipal(
        hosted.writableFence(),
        {
          tenantId,
          kind,
          roles,
          limits: body.limits === undefined ? undefined : record(body.limits),
        },
      ))
      if (!issued.ok) return reply
      reply.header('cache-control', 'no-store')
      return reply.code(201).send(issued.value)
    },
  )

  app.post<{ Params: { principalId: string }; Body: { overlapMs?: number } }>(
    '/hosting/v1/principals/:principalId/rotate',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'tenant-admin', undefined, true)
      if (!auth) return reply
      if (!PRINCIPAL_ID.test(request.params.principalId)) return reply.code(400).send({ error: 'invalid principal id' })
      const scope = await runtime!.store.principalScope(request.params.principalId)
      if (!scope) return reply.code(404).send({ error: 'principal not found' })
      if (!auth.admin && auth.principal!.tenantId !== scope.tenantId) {
        return reply.code(403).send({ error: 'cross-tenant principal rotation is forbidden' })
      }
      if (!auth.admin && scope.kind==='service') {
        return reply.code(403).send({ error:'service principal rotation is reserved to the hosting authority' })
      }
      const overlapMs = positiveInt(request.body?.overlapMs, 86_400_000, 86_400_000)
      const issued = await mutating(reply, (hosted) => hosted.store.rotatePrincipal(
        hosted.writableFence(), request.params.principalId, overlapMs,
      ))
      if (!issued.ok) return reply
      reply.header('cache-control', 'no-store')
      return issued.value
    },
  )

  app.delete<{ Params: { principalId: string } }>(
    '/hosting/v1/principals/:principalId',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'tenant-admin', undefined, true)
      if (!auth) return reply
      if (!PRINCIPAL_ID.test(request.params.principalId)) return reply.code(400).send({ error: 'invalid principal id' })
      const scope = await runtime!.store.principalScope(request.params.principalId)
      if (!scope) return reply.code(404).send({ error: 'principal not found' })
      if (!auth.admin && auth.principal!.tenantId !== scope.tenantId) {
        return reply.code(403).send({ error: 'cross-tenant principal revocation is forbidden' })
      }
      if (!auth.admin && scope.kind==='service') {
        return reply.code(403).send({ error:'service principal revocation is reserved to the hosting authority' })
      }
      const revoked = await mutating(reply, (hosted) => hosted.store.revokePrincipal(
        hosted.writableFence(), request.params.principalId,
      ))
      if (!revoked.ok) return reply
      return { revoked: revoked.value }
    },
  )

  app.put<{ Params: { principalId: string }; Body: Record<string,unknown> }>(
    '/hosting/v1/admin/l1-service-bindings/:principalId',
    async (request,reply) => {
      const auth=await authenticate(request,reply,undefined,undefined,true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error:'hosting administrator required' }) : reply
      if (!PRINCIPAL_ID.test(request.params.principalId)) return reply.code(400).send({ error:'invalid principal id' })
      const body=record(request.body)
      const bindingKind=body.bindingKind
      if (typeof bindingKind!=='string' || !(bindingKind in HOSTED_L1_BINDING_ROLE)) {
        return reply.code(400).send({ error:'bindingKind is not a supported scoped L1 authority' })
      }
      const idempotencyKey=requireIdempotencyKey(request)
      const result=await mutating(reply,(hosted) => hosted.store.assignL1ServiceBinding(
        hosted.writableFence(),{
          principalId:request.params.principalId,bindingKind:bindingKind as keyof typeof HOSTED_L1_BINDING_ROLE,
          chainId:cleanChainId(body.chainId),contractAddress:cleanAddress(body.contractAddress,'contractAddress'),
          expectedSender:cleanAddress(body.expectedSender,'expectedSender'),
          nodeId:bindingKind==='node-liveness' ? cleanHash(body.nodeId,'nodeId') : null,
          roomId:bindingKind==='room-submit' || bindingKind==='pool-finality-oracle'
            ? cleanDecimal(body.roomId,'roomId') : null,
          sponsorshipId:bindingKind==='pool-sponsor'
            ? cleanResourceId(body.sponsorshipId,'sponsorshipId') : null,
          allocationId:bindingKind==='pool-beneficiary'
            ? cleanHash(body.allocationId,'allocationId') : null,
        },
      ))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(),{
        tenantId:auth.principal?.tenantId ?? null,principalId:auth.principal?.principalId ?? null,
        action:'l1-service-binding.assign',target:request.params.principalId,idempotencyKey,
        details:{ ...result.value.binding },
      })
      return reply.code(result.value.created ? 201 : 200).send(result.value)
    },
  )

  app.put<{ Params: { proofClass: string }; Body: Record<string, unknown> }>(
    '/hosting/v1/admin/proof-profiles/:proofClass',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      const body = record(request.body)
      const result = await mutating(reply, (hosted) => hosted.store.upsertProofProfile(
        hosted.writableFence(),
        {
          proofClass: request.params.proofClass,
          endpoint: String(body.endpoint ?? ''),
          needsGpu: body.needsGpu === true,
          estimatedWork: String(body.estimatedWork ?? ''),
          estimatedProofTimeMs: positiveInt(body.estimatedProofTimeMs, 0, 86_400_000),
          settlementMarginMs: nonnegativeInt(body.settlementMarginMs, 0, 86_400_000),
          evidence: record(body.evidence),
          verifiedAt: String(body.verifiedAt ?? ''),
        },
      ))
      if (!result.ok) return reply
      return { configured: true, proofClass: request.params.proofClass }
    },
  )

  app.put<{ Params: { principalId: string }; Body: Record<string, unknown> }>(
    '/hosting/v1/admin/provider-nodes/:principalId',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      if (!PRINCIPAL_ID.test(request.params.principalId)) return reply.code(400).send({ error: 'invalid principal id' })
      const body = record(request.body)
      const partitions = strings(body.partitions) as Array<'shared' | 'reserved' | 'dedicated'>
      const result = await mutating(reply, (hosted) => hosted.store.assignProviderNode(
        hosted.writableFence(),
        {
          principalId: request.params.principalId,
          providerId: String(body.providerId ?? ''),
          active: body.active !== false,
          gpu: body.gpu === true,
          gpuResourceId: body.gpuResourceId === null || body.gpuResourceId === undefined
            ? null
            : String(body.gpuResourceId),
          partitions,
          tenantIds: strings(body.tenantIds ?? []),
          allocationIds: strings(body.allocationIds ?? []),
          proofClasses: strings(body.proofClasses),
          maxConcurrentJobs: positiveInt(body.maxConcurrentJobs, 1, 64),
          leaseTtlMs: positiveInt(body.leaseTtlMs, 60_000, 3_600_000),
        },
      ))
      if (!result.ok) return reply
      return { configured: true, principalId: request.params.principalId }
    },
  )

  const registerNodeLifecycleRoute = (state: 'DRAINING' | 'RETIRED',path: string) => {
    app.post<{ Params: { principalId: string }; Body: Record<string, unknown> }>(
      path,
      async (request,reply) => {
        const auth = await authenticate(request,reply,undefined,undefined,true)
        if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
        if (!PRINCIPAL_ID.test(request.params.principalId)) {
          return reply.code(400).send({ error: 'invalid principal id' })
        }
        const body=record(request.body)
        const nodeId=String(body.nodeId ?? '').toLowerCase()
        if (!/^0x[0-9a-f]{64}$/.test(nodeId)) {
          return reply.code(400).send({ error: 'nodeId must be lowercase bytes32' })
        }
        const result=await mutating(reply,(hosted) => hosted.store.requestNodeLifecycle(
          hosted.writableFence(),{
            principalId: request.params.principalId,onchainNodeId: nodeId as `0x${string}`,
            desiredState: state,idempotencyKey: requireIdempotencyKey(request),
            previousIdempotencyKey: body.previousIdempotencyKey === undefined
              || body.previousIdempotencyKey === null ? null : String(body.previousIdempotencyKey),
            maxAttempts: body.maxAttempts === undefined ? undefined : positiveInt(body.maxAttempts,12,100),
            actorPrincipalId: auth.principal?.principalId ?? null,
          },
        ))
        if (!result.ok) return reply
        return reply.code(result.value.created ? 202 : 200).send(result.value)
      },
    )
  }
  registerNodeLifecycleRoute('DRAINING','/hosting/v1/admin/provider-nodes/:principalId/drain')
  registerNodeLifecycleRoute('RETIRED','/hosting/v1/admin/provider-nodes/:principalId/retire')

  app.get<{ Params: { principalId: string }; Querystring: { limit?: string } }>(
    '/hosting/v1/admin/provider-nodes/:principalId/lifecycle',
    async (request,reply) => {
      const auth=await authenticate(request,reply,undefined,undefined,true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      if (!PRINCIPAL_ID.test(request.params.principalId)) {
        return reply.code(400).send({ error: 'invalid principal id' })
      }
      return { operations: await runtime!.store.listNodeLifecycleOperations(
        request.params.principalId,positiveInt(request.query.limit,100,1000),
      ) }
    },
  )

  app.get<{ Querystring: { after?: string; limit?: string; tenantId?: string } }>(
    '/hosting/v1/usage',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'usage-read', undefined, true)
      if (!auth) return reply
      const tenantId = auth.admin
        ? request.query.tenantId
          ? cleanTenantId(request.query.tenantId)
          : null
        : auth.principal!.tenantId
      if (!tenantId) return reply.code(400).send({ error: 'tenantId is required for hosting administrators' })
      const after = cleanDecimal(request.query.after ?? '0', 'after')
      const limit = positiveInt(request.query.limit, 200, 1_000)
      return { entries: await runtime!.store.listUsage(tenantId, after, limit) }
    },
  )

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/capacity/intents', async (request, reply) => {
    const auth = await authenticate(request, reply, 'capacity-manage')
    if (!auth) return reply
    const body = record(request.body)
    const desiredState = body.desiredState
    if (!['RESERVED', 'ACTIVE', 'RENEW', 'HANDOFF', 'RELEASED'].includes(String(desiredState))) {
      return reply.code(400).send({ error: 'invalid desiredState' })
    }
    const idempotencyKey = requireIdempotencyKey(request)
    if (body.idempotencyKey !== undefined && body.idempotencyKey !== idempotencyKey) {
      return reply.code(400).send({ error: 'body idempotencyKey must match Idempotency-Key header' })
    }
    const intent = {
      allocationId: String(body.allocationId ?? ''),
      tenantId: auth.principal!.tenantId,
      roomId: cleanDecimal(body.roomId, 'roomId'),
      desiredState: desiredState as 'RESERVED' | 'ACTIVE' | 'RENEW' | 'HANDOFF' | 'RELEASED',
      providerNodeId: body.providerNodeId === null || body.providerNodeId === undefined
        ? null
        : String(body.providerNodeId),
      deadlineAt: body.deadlineAt === null || body.deadlineAt === undefined ? null : String(body.deadlineAt),
      idempotencyKey,
      previousIdempotencyKey: body.previousIdempotencyKey === null || body.previousIdempotencyKey === undefined
        ? null
        : String(body.previousIdempotencyKey),
      metadata: body.metadata === undefined ? {} : record(body.metadata),
    }
    if (!intent.allocationId) {
      return reply.code(400).send({ error: 'allocationId is required' })
    }
    const result = await mutating(reply, (hosted) => hosted.store.reconcileCapacity(hosted.writableFence(), intent))
    if (!result.ok) return reply
    return reply.code(202).send({ accepted: true, allocationId: intent.allocationId })
  })

  const parseBlocks = (value: unknown) => {
    const list = Array.isArray(value) ? value : [value]
    return list.map((item) => {
      const input = record(item)
      return {
        chainId: cleanChainId(input.chainId),
        number: cleanDecimal(input.number, 'block number'),
        hash: cleanHash(input.hash, 'block hash'),
        parentHash: cleanHash(input.parentHash, 'parent hash'),
        observedAt: typeof input.observedAt === 'string' ? input.observedAt : new Date().toISOString(),
      }
    })
  }

  // Canonical blocks and observations are written only by the owner indexer
  // after two-provider hash-bound agreement. Caller-authored projection APIs
  // are permanently disabled so even a valid service token cannot self-attest.
  app.post('/hosting/v1/indexer/blocks', async (_request, reply) => reply.code(410).send({
    error: 'caller-authored canonical blocks are not accepted; run the fenced owner indexer',
  }))

  app.post<{ Body: { chainId?: number; fromBlock?: string } }>(
    '/hosting/v1/admin/indexer/backfill',
    async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const chainId = cleanChainId(request.body?.chainId)
    const fromBlock = cleanDecimal(request.body?.fromBlock, 'fromBlock')
    const result = await mutating(reply, (hosted) => hosted.store.requestIndexerBackfill(
      hosted.writableFence(), chainId, fromBlock, auth.principal?.principalId ?? null,
      requireIdempotencyKey(request),
    ))
    if (!result.ok) return reply
    return reply.code(202).send(result.value)
  })

  app.put<{
    Params: { roomId: string }
    Body: Record<string, unknown>
  }>('/hosting/v1/indexer/rooms/:roomId', async (request, reply) => {
    void request
    return reply.code(410).send({
      error: 'caller-authored room observations are not accepted; run the fenced owner reconciler',
    })
  })

  app.get('/hosting/v1/indexer/status', async (request, reply) => {
    if (!await authenticate(request, reply, undefined, undefined, true)) return reply
    return runtime!.store.indexerStatus(config.chainId)
  })

  app.get<{ Querystring: { fromBlock?: string; limit?: string } }>(
    '/hosting/v1/indexer/blocks',
    async (request, reply) => {
      if (!await authenticate(request, reply, undefined, undefined, true)) return reply
      return {
        blocks: await runtime!.store.listCanonicalBlocks(
          config.chainId,
          cleanDecimal(request.query.fromBlock ?? '0', 'fromBlock'),
          positiveInt(request.query.limit, 200, 1_000),
        ),
      }
    },
  )

  app.get<{ Querystring: { after?: string; limit?: string; kind?: string; roomId?: string } }>(
    '/hosting/v1/indexer/events',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth) return reply
      const kinds = request.query.kind
        ? request.query.kind.split(',').map((value) => cleanResourceId(value, 'fact kind'))
        : undefined
      return {
        events: await runtime!.store.listIndexerFacts({
          chainId: config.chainId,
          tenantId: auth.admin ? null : auth.principal!.tenantId,
          factKinds: kinds,
          roomId: request.query.roomId === undefined ? null : cleanDecimal(request.query.roomId, 'roomId'),
          afterFactId: cleanDecimal(request.query.after ?? '0', 'after'),
          limit: positiveInt(request.query.limit, 200, 1_000),
        }),
      }
    },
  )

  app.get<{ Params: { transactionHash: string } }>(
    '/hosting/v1/indexer/transactions/:transactionHash',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth) return reply
      const transaction = await runtime!.store.indexedTransaction(
        config.chainId,
        cleanHash(request.params.transactionHash, 'transactionHash'),
        auth.admin ? null : auth.principal!.tenantId,
      )
      if (!transaction) return reply.code(404).send({ error: 'canonical indexed transaction not found' })
      return transaction
    },
  )

  app.get<{ Params: { roomId: string } }>('/hosting/v1/rooms/:roomId', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth) return reply
    const room = await runtime!.store.roomObservation(
      config.chainId,
      cleanDecimal(request.params.roomId, 'roomId'),
      auth.admin ? null : auth.principal!.tenantId,
    )
    if (!room) return reply.code(404).send({ error: 'room observation not found' })
    return room
  })

  app.get<{ Params: { roomId: string } }>(
    '/hosting/v1/rooms/:roomId/reconciliation',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth) return reply
      const status = await runtime!.store.roomReconciliationStatus(
        config.chainId,
        cleanDecimal(request.params.roomId, 'roomId'),
        auth.admin ? null : auth.principal!.tenantId,
      )
      if (!status) return reply.code(404).send({ error: 'room reconciliation status not found' })
      return status
    },
  )

  app.get<{ Querystring: { limit?: string } }>('/hosting/v1/capacity/intents', async (request, reply) => {
    const auth = await authenticate(request, reply, 'capacity-manage')
    if (!auth) return reply
    return {
      intents: await runtime!.store.listCapacityIntents(
        auth.principal!.tenantId,
        positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/rooms/deployments', async (request, reply) => {
    const auth = await authenticate(request, reply, 'capacity-manage')
    if (!auth) return reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const intent = {
      allocationId: cleanResourceId(body.allocationId, 'allocationId'),
      tenantId: auth.principal!.tenantId,
      roomId: cleanDecimal(body.roomId, 'roomId'),
      desiredState: 'RESERVED' as const,
      providerNodeId: body.providerNodeId === undefined || body.providerNodeId === null
        ? null
        : cleanResourceId(body.providerNodeId, 'providerNodeId'),
      deadlineAt: cleanTimestamp(body.deadlineAt, 'deadlineAt', true),
      idempotencyKey,
      // A capacity transition over an allocation that already exists must name
      // the operation it supersedes: reconcileCapacity refuses to lose an
      // operation lineage. Omitting the field here made every deployment after
      // the first for a given allocation unsatisfiable, because no request body
      // could supply it. The generic /capacity/intents route always accepted
      // it; these two routes simply never read it.
      previousIdempotencyKey: body.previousIdempotencyKey === undefined || body.previousIdempotencyKey === null
        ? null
        : cleanResourceId(body.previousIdempotencyKey, 'previousIdempotencyKey'),
      metadata: { operation: 'room-deployment', ...(body.metadata === undefined ? {} : record(body.metadata)) },
    }
    const result = await mutating(reply, (hosted) => hosted.store.reconcileCapacity(hosted.writableFence(), intent))
    if (!result.ok) return reply
    return reply.code(202).send({
      accepted: true,
      state: 'PENDING_CAPACITY_RECONCILIATION',
      allocationId: intent.allocationId,
      roomId: intent.roomId,
    })
  })

  app.post<{ Params: { roomId: string }; Body: Record<string, unknown> }>(
    '/hosting/v1/rooms/:roomId/renewals',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'capacity-manage')
      if (!auth) return reply
      const body = record(request.body)
      const intent = {
        allocationId: cleanResourceId(body.allocationId, 'allocationId'),
        tenantId: auth.principal!.tenantId,
        roomId: cleanDecimal(request.params.roomId, 'roomId'),
        desiredState: 'RENEW' as const,
        providerNodeId: body.providerNodeId === undefined || body.providerNodeId === null
          ? null
          : cleanResourceId(body.providerNodeId, 'providerNodeId'),
        deadlineAt: cleanTimestamp(body.deadlineAt, 'deadlineAt', true),
        idempotencyKey: requireIdempotencyKey(request),
        // A renewal targets an allocation that by definition already exists, so
        // reconcileCapacity always has a prior operation to be named. Without
        // this field the route could not succeed for any input at all.
        previousIdempotencyKey: body.previousIdempotencyKey === undefined || body.previousIdempotencyKey === null
          ? null
          : cleanResourceId(body.previousIdempotencyKey, 'previousIdempotencyKey'),
        metadata: { operation: 'room-renewal', ...(body.metadata === undefined ? {} : record(body.metadata)) },
      }
      const result = await mutating(reply, (hosted) => hosted.store.reconcileCapacity(hosted.writableFence(), intent))
      if (!result.ok) return reply
      return reply.code(202).send({ accepted: true, allocationId: intent.allocationId, roomId: intent.roomId })
    },
  )

  app.get<{ Params: { principalId: string } }>(
    '/hosting/v1/admin/provider-nodes/:principalId',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      const node = await runtime!.store.providerNode(request.params.principalId)
      if (!node) return reply.code(404).send({ error: 'provider node assignment not found' })
      return node
    },
  )

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/entitlements', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const entitlementId = cleanResourceId(body.entitlementId, 'entitlementId')
    const result = await mutating(reply, (hosted) => hosted.store.createEntitlement(hosted.writableFence(), {
      entitlementId,
      tenantId: cleanTenantId(body.tenantId),
      allocationId: body.allocationId === undefined || body.allocationId === null
        ? null
        : cleanResourceId(body.allocationId, 'allocationId'),
      unit: cleanResourceId(body.unit, 'unit'),
      quantity: cleanQuantity(body.quantity, 'quantity'),
      startsAt: cleanTimestamp(body.startsAt, 'startsAt')!,
      expiresAt: cleanTimestamp(body.expiresAt, 'expiresAt', true),
      metadata: body.metadata === undefined ? {} : record(body.metadata),
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: cleanTenantId(body.tenantId), principalId: auth.principal?.principalId ?? null,
      action: 'entitlement.create', target: entitlementId,
      idempotencyKey, details: { entitlementId },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value)
  })

  app.get<{ Querystring: { limit?: string } }>('/hosting/v1/entitlements', async (request, reply) => {
    const auth = await authenticate(request, reply, 'usage-read')
    if (!auth) return reply
    return {
      entitlements: await runtime!.store.listEntitlements(
        auth.principal!.tenantId,
        positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/sponsorships', async (request, reply) => {
    const auth = await authenticate(request, reply, 'tenant-admin')
    if (!auth) return reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const sponsorshipId = cleanResourceId(body.sponsorshipId, 'sponsorshipId')
    const result = await mutating(reply, (hosted) => hosted.store.createSponsorship(hosted.writableFence(), {
      sponsorshipId,
      sponsorTenantId: auth.principal!.tenantId,
      beneficiaryTenantId: cleanTenantId(body.beneficiaryTenantId),
      allocationId: body.allocationId === undefined || body.allocationId === null
        ? null
        : cleanResourceId(body.allocationId, 'allocationId'),
      maximumQuantity: cleanQuantity(body.maximumQuantity, 'maximumQuantity'),
      unit: cleanResourceId(body.unit, 'unit'),
      expiresAt: cleanTimestamp(body.expiresAt, 'expiresAt', true),
      metadata: body.metadata === undefined ? {} : record(body.metadata),
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: auth.principal!.tenantId, principalId: auth.principal!.principalId,
      action: 'sponsorship.create', target: sponsorshipId,
      idempotencyKey, details: { sponsorshipId },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value)
  })

  app.get<{ Querystring: { limit?: string } }>('/hosting/v1/sponsorships', async (request, reply) => {
    const auth = await authenticate(request, reply, 'usage-read')
    if (!auth) return reply
    return {
      sponsorships: await runtime!.store.listSponsorships(
        auth.principal!.tenantId,
        positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.post<{ Body: Record<string, unknown> }>(
    '/hosting/v1/internal/post-finality-recoveries',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'indexer-write', 'service', true)
      if (!auth) return reply
      const body = record(request.body)
      const idempotencyKey = requireIdempotencyKey(request)
      const recoveryId = cleanResourceId(body.recoveryId, 'recoveryId')
      if (idempotencyKey !== recoveryId) {
        return reply.code(400).send({ error: 'Idempotency-Key must equal recoveryId' })
      }
      const operationId = cleanResourceId(body.operationId, 'operationId')
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (reason.length < 8 || reason.length > 1_000) {
        return reply.code(400).send({ error: 'reason must contain 8 through 1000 characters' })
      }
      const existing = await runtime!.store.postFinalityRecovery(recoveryId)
      if (existing) {
        if (existing.operationId !== operationId || existing.reason !== reason) {
          return reply.code(409).send({ error: 'recoveryId is bound to different immutable terms' })
        }
        return reply.send(existing)
      }
      const operation = await runtime!.store.l1Transaction(operationId)
      if (!operation || operation.chainId !== config.chainId || operation.status !== 'RECOVERY_REQUIRED') {
        return reply.code(409).send({ error: 'operation is not awaiting post-finality recovery on this chain' })
      }
      if (!operation.blockNumber) {
        return reply.code(409).send({ error: 'recovering operation has no retained inclusion block' })
      }
      const priorFloor = await runtime!.store.canonicalFloor(config.chainId)
      if (!priorFloor) return reply.code(409).send({ error: 'canonical archive floor is absent' })
      const expected = record(body.expectedPriorFloor)
      const expectedNumber = cleanDecimal(expected.number, 'expectedPriorFloor.number')
      const expectedHash = cleanHash(expected.hash, 'expectedPriorFloor.hash')
      if (expectedNumber !== priorFloor.number || expectedHash !== priorFloor.hash.toLowerCase()) {
        return reply.code(409).send({ error: 'expected prior floor is stale or conflicting', priorFloor })
      }
      const from = BigInt(operation.blockNumber)
      const through = BigInt(priorFloor.number)
      if (through < from || through - from >= 4_096n) {
        return reply.code(409).send({ error: 'replacement branch range is invalid or exceeds 4096 blocks' })
      }
      const blocks = [] as Array<{
        chainId: number
        number: string
        hash: `0x${string}`
        parentHash: `0x${string}`
        observedAt: string
      }>
      let agreeingSources: Set<string> | null = null
      for (let cursor = from; cursor <= through; cursor += 1n) {
        let block: Awaited<ReturnType<HostedRuntime['l1']['agreedBlock']>>
        try {
          block = await runtime!.l1.agreedBlock(`0x${cursor.toString(16)}`)
        } catch {
          return reply.code(503).send({
            error: `independent L1 providers did not agree on replacement block ${cursor}`,
          })
        }
        const blockSources = new Set(block.verifiedSources)
        if (agreeingSources === null) {
          agreeingSources = blockSources
        } else {
          const retained: string[] = []
          for (const source of agreeingSources as Set<string>) {
            if (blockSources.has(source)) retained.push(source)
          }
          agreeingSources = new Set(retained)
        }
        const timestampMs = Number(BigInt(block.timestamp)) * 1_000
        if (!Number.isSafeInteger(timestampMs)) throw new Error('agreed recovery block timestamp is invalid')
        blocks.push({
          chainId: config.chainId,
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
          observedAt: new Date(timestampMs).toISOString(),
        })
      }
      const verifiedSources = [...(agreeingSources ?? [])].sort()
      if (verifiedSources.length < 2) {
        return reply.code(503).send({
          error: 'no two independent providers corroborated every block in the replacement branch',
        })
      }
      const result = await mutating(reply, (hosted) => hosted.store.installPostFinalityRecoveryBranch(
        hosted.writableFence(), {
          recoveryId,operationId,chainId: config.chainId,
          expectedPriorFloor: { number: expectedNumber,hash: expectedHash },
          blocks,requiredIndexerSources: ['room-manager','room-pool'],verifiedSources,reason,
        },
      ))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'post-finality.recovery.install',target: recoveryId,idempotencyKey,
        details: { operationId,priorFloor,branchHead: blocks.at(-1),verifiedSources },
      })
      return reply.code(201).send(result.value)
    },
  )

  app.post<{ Params: { recoveryId: string }; Body: Record<string, unknown> }>(
    '/hosting/v1/internal/post-finality-recoveries/:recoveryId/finalize',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'indexer-write', 'service', true)
      if (!auth) return reply
      const idempotencyKey = requireIdempotencyKey(request)
      const recoveryId = cleanResourceId(request.params.recoveryId, 'recoveryId')
      const recovery = await runtime!.store.postFinalityRecovery(recoveryId)
      if (!recovery) return reply.code(404).send({ error: 'post-finality recovery was not found' })
      if (recovery.status === 'RESOLVED') return reply.send(recovery)
      const branchHead = recovery.branchBlocks.at(-1)
      if (!branchHead) return reply.code(409).send({ error: 'recovery branch has no durable head' })
      let agreed: Awaited<ReturnType<HostedRuntime['l1']['agreedBlock']>>
      try {
        agreed = await runtime!.l1.agreedBlock(`0x${BigInt(branchHead.number).toString(16)}`)
      } catch {
        return reply.code(503).send({ error: 'independent L1 providers did not agree on the recovery head' })
      }
      if (
        agreed.number !== branchHead.number
        || agreed.hash.toLowerCase() !== branchHead.hash.toLowerCase()
        || agreed.parentHash.toLowerCase() !== branchHead.parentHash.toLowerCase()
      ) return reply.code(409).send({ error: 'independently agreed L1 head conflicts with recovery branch' })
      const result = await mutating(reply, (hosted) => hosted.store.finalizePostFinalityRecovery(
        hosted.writableFence(), {
          recoveryId,
          replacementFloor: {
            chainId: config.chainId,number: agreed.number,hash: agreed.hash,
            verifiedSources: agreed.verifiedSources,
          },
        },
      ))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'post-finality.recovery.finalize',target: recoveryId,idempotencyKey,
        details: { replacementFloor: result.value.replacementFloor,verifiedSources: agreed.verifiedSources },
      })
      return reply.send(result.value)
    },
  )

  app.post<{ Body: Record<string, unknown> }>(
    '/hosting/v1/internal/aggregate-billing-manifests',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'l1-publish', 'service', true)
      if (!auth) return reply
      const body = record(request.body)
      const rawMembers = body.members
      if (!Array.isArray(rawMembers)) return reply.code(400).send({ error: 'members array is required' })
      const result = await mutating(reply, (hosted) => hosted.store.registerAggregateBillingManifest(
        hosted.writableFence(), {
          chainId: cleanChainId(body.chainId),
          aggregateHash: cleanHash(body.aggregateHash, 'aggregateHash'),
          operationId: cleanResourceId(body.operationId, 'operationId'),
          idempotencyKey: requireIdempotencyKey(request),
          members: rawMembers.map((value, index) => {
            const member = record(value)
            return {
              memberIndex: nonnegativeInt(member.memberIndex, index, 7),
              jobId: cleanResourceId(member.jobId, 'jobId'),
              roomId: cleanDecimal(member.roomId, 'roomId'),
              batchIndex: cleanDecimal(member.batchIndex, 'batchIndex'),
            }
          }),
        },
      ))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'billing.aggregate-manifest.register',
        target: String(body.aggregateHash),
        idempotencyKey: requireIdempotencyKey(request),
        details: result.value,
      })
      return reply.code(result.value.created ? 201 : 200).send(result.value)
    },
  )

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/admin/billing/prices', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const result = await mutating(reply, (hosted) => hosted.store.publishBillingPrice(hosted.writableFence(), {
      tenantId: cleanTenantId(body.tenantId),
      unit: cleanResourceId(body.unit, 'unit'),
      currency: String(body.currency ?? ''),
      unitPrice: cleanQuantity(body.unitPrice, 'unitPrice', true),
      effectiveFrom: cleanTimestamp(body.effectiveFrom, 'effectiveFrom')!,
      idempotencyKey,
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: cleanTenantId(body.tenantId), principalId: auth.principal?.principalId ?? null,
      action: 'billing.price.publish', target: `${body.tenantId}:${body.unit}`,
      idempotencyKey, details: { currency: body.currency, effectiveFrom: body.effectiveFrom },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value)
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/admin/sla/policies', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const serviceClass = String(body.serviceClass ?? '')
    if (!['standard', 'latency', 'batch'].includes(serviceClass)) throw new Error('serviceClass is invalid')
    const idempotencyKey = requireIdempotencyKey(request)
    const result = await mutating(reply, (hosted) => hosted.store.publishSlaPolicy(hosted.writableFence(), {
      tenantId: cleanTenantId(body.tenantId),
      serviceClass: serviceClass as 'standard' | 'latency' | 'batch',
      maximumQueueMs: nonnegativeInt(body.maximumQueueMs, 0, Number.MAX_SAFE_INTEGER),
      maximumProofMs: nonnegativeInt(body.maximumProofMs, 0, Number.MAX_SAFE_INTEGER),
      creditBasisPoints: nonnegativeInt(body.creditBasisPoints, 0, 9_999),
      effectiveFrom: cleanTimestamp(body.effectiveFrom, 'effectiveFrom')!,
      idempotencyKey,
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: cleanTenantId(body.tenantId), principalId: auth.principal?.principalId ?? null,
      action: 'sla.policy.publish', target: `${body.tenantId}:${serviceClass}`,
      idempotencyKey, details: { effectiveFrom: body.effectiveFrom },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value)
  })

  app.get<{ Querystring: { after?: string; limit?: string } }>('/hosting/v1/billing/ledger', async (request, reply) => {
    const auth = await authenticate(request, reply, 'usage-read')
    if (!auth) return reply
    return {
      entries: await runtime!.store.listBillingLedger(
        auth.principal!.tenantId,
        cleanDecimal(request.query.after ?? '0', 'after'),
        positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/admin/invoices', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const result = await mutating(reply, (hosted) => hosted.store.createInvoiceExport(hosted.writableFence(), {
      invoiceId: cleanResourceId(body.invoiceId, 'invoiceId'),
      supersedesInvoiceId: body.supersedesInvoiceId === undefined || body.supersedesInvoiceId === null
        ? null : cleanResourceId(body.supersedesInvoiceId, 'supersedesInvoiceId'),
      tenantId: cleanTenantId(body.tenantId),
      periodStart: cleanTimestamp(body.periodStart, 'periodStart')!,
      periodEnd: cleanTimestamp(body.periodEnd, 'periodEnd')!,
      currency: String(body.currency ?? ''),
      idempotencyKey,
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: cleanTenantId(body.tenantId), principalId: auth.principal?.principalId ?? null,
      action: 'billing.invoice.finalize', target: String(body.invoiceId),
      idempotencyKey, details: { ledgerHighWater: result.value.invoice.ledgerHighWater },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value.invoice)
  })

  app.get<{ Querystring: { limit?: string } }>('/hosting/v1/invoices', async (request, reply) => {
    const auth = await authenticate(request, reply, 'usage-read')
    if (!auth) return reply
    return {
      invoices: await runtime!.store.listInvoiceExports(
        auth.principal!.tenantId, positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/hosting/v1/admin/refunds', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const body = record(request.body)
    const idempotencyKey = requireIdempotencyKey(request)
    const result = await mutating(reply, (hosted) => hosted.store.issueBillingRefund(hosted.writableFence(), {
      tenantId: cleanTenantId(body.tenantId),
      chargeEntryId: cleanDecimal(body.chargeEntryId, 'chargeEntryId'),
      quantity: cleanQuantity(body.quantity, 'quantity'),
      reason: String(body.reason ?? ''),
      idempotencyKey,
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: cleanTenantId(body.tenantId), principalId: auth.principal?.principalId ?? null,
      action: 'billing.refund.finalize', target: result.value.entry.entryId,
      idempotencyKey, details: { chargeEntryId: body.chargeEntryId },
    })
    return reply.code(result.value.created ? 201 : 200).send(result.value.entry)
  })

  app.get<{ Querystring: { limit?: string } }>('/hosting/v1/refunds', async (request, reply) => {
    const auth = await authenticate(request, reply, 'usage-read')
    if (!auth) return reply
    return {
      refunds: await runtime!.store.listBillingRefunds(
        auth.principal!.tenantId, positiveInt(request.query.limit, 200, 1_000),
      ),
    }
  })

  app.get<{ Querystring: { roomId?: string; status?: string; limit?: string } }>(
    '/hosting/v1/withdrawals',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'withdrawal-read', undefined, true)
      if (!auth) return reply
      return {
        withdrawals: await runtime!.store.listWithdrawals({
          chainId: config.chainId,
          tenantId: auth.admin ? null : auth.principal!.tenantId,
          roomId: request.query.roomId === undefined ? null : cleanDecimal(request.query.roomId, 'roomId'),
          status: request.query.status ?? null,
          limit: positiveInt(request.query.limit, 200, 1_000),
        }),
      }
    },
  )

  app.post<{ Body: Record<string, unknown> }>(
    '/hosting/v1/internal/withdrawal-witnesses',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'indexer-write', 'service', true)
      if (!auth) return reply
      if (!withdrawals) return reply.code(503).send({ error: 'withdrawal proof materializer is not configured' })
      const body = record(request.body)
      const rawWithdrawals = body.withdrawals
      if (!Array.isArray(rawWithdrawals)) return reply.code(400).send({ error: 'withdrawals array is required' })
      if (body.schemaVersion !== 1) return reply.code(400).send({ error: 'withdrawal witness schemaVersion must be 1' })
      if (body.capacity === undefined) return reply.code(400).send({ error: 'withdrawal capacity is required' })
      const witness: WithdrawalWitness = {
        schemaVersion: 1,
        deploymentDomain: cleanHash(body.deploymentDomain, 'deploymentDomain'),
        roomId: cleanDecimal(body.roomId, 'roomId'),
        outboxEpoch: cleanDecimal(body.outboxEpoch, 'outboxEpoch'),
        capacity: positiveInt(body.capacity, 1, 32_768),
        withdrawals: rawWithdrawals.map((value) => {
          const item = record(value)
          return {
            index: cleanDecimal(item.index, 'withdrawal.index'),
            approverEpoch: cleanDecimal(item.approverEpoch, 'withdrawal.approverEpoch'),
            recipient: cleanAddress(item.recipient, 'withdrawal.recipient'),
            asset: cleanAddress(item.asset, 'withdrawal.asset'),
            amount: cleanDecimal(item.amount, 'withdrawal.amount'),
          }
        }),
      }
      const result = await mutating(reply, () => withdrawals.ingest(witness))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'withdrawal.witness.finalize',
        target: `${witness.roomId}:${witness.outboxEpoch}`,
        idempotencyKey: requireIdempotencyKey(request),
        details: {
          withdrawalRoot: result.value.withdrawalRoot,
          withdrawals: result.value.withdrawals,
          sourceSha256: result.value.sourceSha256,
        },
      })
      return reply.code(result.value.created ? 201 : 200).send(result.value)
    },
  )

  app.get<{ Params: { roomId: string; epoch: string; withdrawalIndex: string } }>(
    '/hosting/v1/withdrawals/:roomId/:epoch/:withdrawalIndex/proof',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'withdrawal-read', undefined, true)
      if (!auth) return reply
      const proof = await runtime!.store.withdrawalProof({
        chainId: config.chainId,
        tenantId: auth.admin ? null : auth.principal!.tenantId,
        roomId: cleanDecimal(request.params.roomId, 'roomId'),
        epoch: cleanDecimal(request.params.epoch, 'epoch'),
        withdrawalIndex: cleanDecimal(request.params.withdrawalIndex, 'withdrawalIndex'),
      })
      if (!proof) return reply.code(404).send({ error: 'finalized withdrawal proof not found' })
      return proof
    },
  )

  app.post<{ Params: { roomId: string; epoch: string; withdrawalIndex: string } }>(
    '/hosting/v1/withdrawals/:roomId/:epoch/:withdrawalIndex/claims',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'withdrawal-claim')
      if (!auth) return reply
      const result = await mutating(reply, (hosted) => hosted.store.requestWithdrawalClaim(
        hosted.writableFence(), {
          chainId: config.chainId,
          tenantId: auth.principal!.tenantId,
          roomId: cleanDecimal(request.params.roomId, 'roomId'),
          epoch: cleanDecimal(request.params.epoch, 'epoch'),
          withdrawalIndex: cleanDecimal(request.params.withdrawalIndex, 'withdrawalIndex'),
          idempotencyKey: requireIdempotencyKey(request),
        },
      ))
      if (!result.ok) return reply
      return reply.code(202).send(result.value)
    },
  )

  app.get<{ Params: { claimId: string } }>(
    '/hosting/v1/withdrawal-claims/:claimId',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'withdrawal-read', undefined, true)
      if (!auth) return reply
      const claimId = cleanDecimal(request.params.claimId, 'claimId')
      const claim = await runtime!.store.withdrawalClaim(
        claimId, auth.admin ? null : auth.principal!.tenantId,
      )
      if (!claim) return reply.code(404).send({ error: 'withdrawal claim not found' })
      return claim
    },
  )

  app.post<{ Params:{ roomId:string }; Body:{
    schemaVersion?:number
    chainId?:number
    policy?:unknown
  } }>(
    '/hosting/v1/rooms/:roomId/proving-policy',
    async (request,reply) => {
      const auth=await authenticate(request,reply,'tenant-admin','api-key')
      if (!auth?.principal) return reply
      if (request.body?.schemaVersion!==1) {
        return reply.code(400).send({ error:'schemaVersion must equal 1' })
      }
      const chainId=cleanChainId(request.body.chainId)
      const roomId=cleanDecimal(request.params.roomId,'roomId')
      const policy=canonicalExecutionPolicyV5(request.body.policy)
      const policyHash=executionPolicyHashV5(policy)
      const bytes=new TextEncoder().encode(canonicalJson(policy))
      const stored=await runtime!.objects.putContent(bytes,'application/json')
      const registered=await mutating(reply,(hosted) => hosted.store.registerRoomProvingPolicy(
        hosted.writableFence(),{
          chainId,roomId,tenantId:auth.principal!.tenantId,
          principalId:auth.principal!.principalId,policyHash,policy,
          objectKey:stored.key,objectDigest:stored.sha256,
          idempotencyKey:requireIdempotencyKey(request),
        },
      ))
      if (!registered.ok) return reply
      return reply.code(registered.value.created ? 201 : 200).send({
        schemaVersion:1,chainId,roomId,policyHash,objectDigest:stored.sha256,
        boundBlock:registered.value.boundBlock,boundHash:registered.value.boundHash,
        created:registered.value.created,
      })
    },
  )

  app.get<{ Params:{ roomId:string } }>(
    '/hosting/v1/rooms/:roomId/proving-context',
    async (request,reply) => {
      const auth=await authenticate(request,reply,'room-operator','node')
      if (!auth?.principal) return reply
      const roomId=cleanDecimal(request.params.roomId,'roomId')
      await runtime!.assertCriticalL1Ready()
      const context=await runtime!.store.roomProvingContext(
        config.chainId,roomId,auth.principal.tenantId,
      )
      if (!context) return reply.code(404).send({ error:'canonical proving context not found' })
      if (
        context.schemaVersion!==2 || context.reconciled!==true
        || !Array.isArray(context.reconciliationErrors) || context.reconciliationErrors.length!==0
      ) return reply.code(503).send({ error:'room proving context is not schema-current and reconciled' })
      const document=record(context.document)
      const room=record(document.roomState)
      if (!['1','VALIDITY_ONLY'].includes(String(room.authorizationMode ?? ''))) {
        return reply.code(409).send({ error:'hosted live proving supports only VALIDITY_ONLY rooms' })
      }
      const observed=BigInt(cleanDecimal(context.headBlock,'observedL1Block'))
      const canonicalHead=await runtime!.store.canonicalHead(config.chainId)
      if (!canonicalHead) return reply.code(503).send({ error:'canonical indexer head is unavailable' })
      const lag=BigInt(canonicalHead.number)-observed
      if (lag<0n || lag>BigInt(Math.min(config.maximumArchiveLagBlocks,8))) {
        return reply.code(503).send({ error:'room proving context is outside the eight-block freshness gate' })
      }
      if (observed>BigInt(Number.MAX_SAFE_INTEGER)) {
        return reply.code(503).send({ error:'observed L1 block exceeds the JSON-safe range' })
      }
      const block=await runtime!.l1.agreedBlock(`0x${observed.toString(16)}`)
      const blockHash=cleanHash(context.headHash,'headHash')
      if (block.hash.toLowerCase()!==blockHash.toLowerCase()) {
        return reply.code(503).send({ error:'room proving context head is no longer canonical' })
      }
      const provenance=record(document.provenance)
      const observationSources=strings(provenance.verifiedSources)
      const providers=block.verifiedSources.filter((source) => observationSources.includes(source))
      if (new Set(providers).size<2) {
        return reply.code(503).send({ error:'room proving context lacks two-provider hash-bound evidence' })
      }
      const policy=canonicalExecutionPolicyV5(context.policy)
      const policyHash=executionPolicyHashV5(policy)
      if (
        policyHash.toLowerCase()!==String(context.policyHash ?? '').toLowerCase()
        || policyHash.toLowerCase()!==String(room.policyHash ?? '').toLowerCase()
      ) return reply.code(503).send({ error:'stored proving policy no longer matches canonical room policyHash' })
      const liabilities=Array.isArray(document.liabilities)
        ? document.liabilities.map((item,index) => {
            const outer=record(item)
            const value=record(outer.liability)
            return {
              asset:cleanAddress(outer.asset,`liabilities[${index}].asset`),
              pending:cleanDecimal(value.pending,`liabilities[${index}].pending`),
              controlled:cleanDecimal(value.controlled,`liabilities[${index}].controlled`),
              claimable:cleanDecimal(value.claimable,`liabilities[${index}].claimable`),
              paid:cleanDecimal(value.paid,`liabilities[${index}].paid`),
            }
          })
        : []
      const liabilitiesHash=liabilitiesHashV5(liabilities)
      // Pending exit inputs for the live composer: the ordered unsequenced
      // forced queue (raw signed bytes live only in the indexed event) and
      // the unconsumed deposit-inbox tail read hash-bound at the observed
      // head. Both are best-effort context and default to [] when the facts
      // or canonical views are unavailable; the composer detects the gap
      // from the room cursors and fails loudly instead of censoring.
      const pendingLimit=256
      // A degraded canonical view is signalled explicitly (…Unavailable=true), NOT
      // as a silent empty list: the composer refuses to compose against an
      // unavailable view rather than censoring pending forced entries/deposits.
      let pendingForced: Array<Record<string,unknown>>=[]
      let pendingForcedUnavailable=false
      try {
        const forcedCursor=cleanDecimal(room.forcedCursor,'room.forcedCursor')
        pendingForced=(await runtime!.store.roomPendingForcedTransactions(
          config.chainId,roomId,String(observed),forcedCursor,
        )).map((entry,index) => ({
          forcedId:cleanDecimal(entry.forcedId,`pendingForced[${index}].forcedId`),
          transactionHash:cleanHash(entry.transactionHash,`pendingForced[${index}].transactionHash`),
          deadlineBlock:cleanDecimal(entry.deadlineBlock,`pendingForced[${index}].deadlineBlock`),
          rawSignedTransaction:cleanHexData(entry.rawSignedTransaction,`pendingForced[${index}].rawSignedTransaction`),
        }))
      } catch { pendingForced=[]; pendingForcedUnavailable=true }
      let pendingDeposits: Array<Record<string,unknown>>=[]
      let pendingDepositsUnavailable=false
      try {
        const inboxCursor=BigInt(cleanDecimal(room.inboxCursor,'room.inboxCursor'))
        const nextInboxId=BigInt(cleanDecimal(room.nextInboxId,'room.nextInboxId'))
        // Inbox ids are assigned by pre-increment, so nextInboxId is the LAST
        // assigned id and the unconsumed tail is inboxCursor+1..nextInboxId
        // inclusive. A truncated prefix stays composable (strict cursor order).
        const last=nextInboxId-inboxCursor>BigInt(pendingLimit)
          ? inboxCursor+BigInt(pendingLimit)
          : nextInboxId
        const fn=depositEntryFunction()
        const entries: Array<Record<string,unknown>>=[]
        for (let inboxId=inboxCursor+1n;inboxId<=last;inboxId+=1n) {
          const call=await runtime!.l1.agreedCall({
            to:config.roomManager,
            data:encodeFunctionData({ abi:[fn],functionName:'depositEntry',args:[BigInt(roomId),inboxId] }),
            blockTag:{ blockHash,requireCanonical:true },
          })
          const entry=record(decodeFunctionResult({ abi:[fn],functionName:'depositEntry',data:call.data }))
          entries.push({
            inboxId:inboxId.toString(),
            depositor:cleanAddress(entry.depositor,`pendingDeposits[${inboxId}].depositor`),
            beneficiary:cleanAddress(entry.beneficiary,`pendingDeposits[${inboxId}].beneficiary`),
            asset:cleanAddress(entry.asset,`pendingDeposits[${inboxId}].asset`),
            amount:cleanDecimal(entry.amount,`pendingDeposits[${inboxId}].amount`),
            queuedAtBlock:cleanDecimal(entry.queuedAtBlock,`pendingDeposits[${inboxId}].queuedAtBlock`),
            consumed:entry.consumed===true,
            refunded:entry.refunded===true,
          })
        }
        pendingDeposits=entries
      } catch { pendingDeposits=[]; pendingDepositsUnavailable=true }
      return {
        schemaVersion:1,chainId:config.chainId,l1ChainId:config.chainId,roomId,
        observedL1Block:Number(observed),blockHash,canonical:true,
        receiptSource:{ providerIds:[...new Set(providers)].sort(),observedAt:new Date().toISOString(),canonical:true },
        room,domainSeparator:cleanHash(document.domainSeparator,'domainSeparator'),
        deploymentDomain:cleanHash(document.deploymentDomain,'deploymentDomain'),
        policy,liabilities,liabilitiesHash,pendingForced,pendingDeposits,
        ...(pendingForcedUnavailable ? { pendingForcedUnavailable:true } : {}),
        ...(pendingDepositsUnavailable ? { pendingDepositsUnavailable:true } : {}),
      }
    },
  )

  app.post<{ Body: {
    to?: string
    calldata?: string
    blobData?: string
    value?: string
    gas?: string
    maxPriorityFeePerGas?: string
    maxFeePerGas?: string
    maxFeePerBlobGas?: string
    inclusionDeadline?: string
  } }>('/hosting/v1/data-availability/publish', async (request, reply) => {
    const auth = await authenticate(request, reply, 'l1-publish', 'service', true)
    if (!auth) return reply
    if (!publisher) return reply.code(503).send({ error: 'fenced EIP-4844 publisher is not configured' })
    const idempotencyKey = requireIdempotencyKey(request)
    const body = request.body ?? {}
    const result = await mutating(reply, () => publisher.publish(idempotencyKey, {
      to: cleanAddress(body.to, 'to'),
      calldata: cleanHexData(body.calldata, 'calldata'),
      blobData: cleanHexData(body.blobData, 'blobData'),
      value: cleanDecimal(body.value, 'value'),
      gas: cleanDecimal(body.gas, 'gas'),
      maxPriorityFeePerGas: cleanDecimal(body.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
      maxFeePerGas: cleanDecimal(body.maxFeePerGas, 'maxFeePerGas'),
      maxFeePerBlobGas: cleanDecimal(body.maxFeePerBlobGas, 'maxFeePerBlobGas'),
      inclusionDeadline: cleanDecimal(body.inclusionDeadline, 'inclusionDeadline'),
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(), {
      tenantId: auth.principal?.tenantId ?? null,
      principalId: auth.principal?.principalId ?? null,
      action: 'blob.publish', target: result.value.operationId, idempotencyKey,
      details: { status: result.value.status },
    })
    return reply.code(202).send(result.value)
  })

  app.post<{ Body: {
    schemaVersion?: number
    chainId?: number
    poolAddress?: string
    expectedLivenessAccount?: string
    nodeId?: string
    profileHash?: string
    confirmationPolicy?: { minimumConfirmations?: number }
  } }>('/hosting/v1/l1-operations/node-heartbeats', async (request,reply) => {
    const auth=await authenticate(request,reply,'l1-liveness','service')
    if (!auth?.principal) return reply
    if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-liveness') {
      return reply.code(403).send({ error:'node heartbeat credential must carry only l1-liveness' })
    }
    if (!nodeHeartbeatPublisher) {
      return reply.code(503).send({ error:'scoped node-liveness publisher is not configured' })
    }
    const body=request.body ?? {}
    if (body.schemaVersion!==1) return reply.code(400).send({ error:'schemaVersion must equal 1' })
    const chainId=cleanChainId(body.chainId)
    const poolAddress=cleanAddress(body.poolAddress,'poolAddress')
    const expectedLivenessAccount=cleanAddress(body.expectedLivenessAccount,'expectedLivenessAccount')
    const nodeId=cleanHash(body.nodeId,'nodeId')
    const profileHash=cleanHash(body.profileHash,'profileHash')
    const minimumConfirmations=positiveInt(
      body.confirmationPolicy?.minimumConfirmations,0,4_096,
    )
    const binding=await runtime!.store.l1ServiceBinding(auth.principal.principalId)
    if (
      !binding || !binding.active || binding.bindingKind!=='node-liveness'
      || binding.chainId!==chainId || binding.contractAddress!==poolAddress
      || binding.expectedSender!==expectedLivenessAccount || binding.nodeId!==nodeId
      || expectedLivenessAccount!==nodeHeartbeatPublisher.signerAddress
    ) return reply.code(403).send({ error:'node-liveness principal is not bound to this exact authority' })
    const encoded=encodeFunctionData({
      abi:NODE_HEARTBEAT_ABI,functionName:'reportNodeHeartbeat',args:[nodeId,profileHash],
    })
    if (!encoded.startsWith(NODE_HEARTBEAT_SELECTOR)) {
      throw new Error('node heartbeat ABI selector does not match the pinned protocol selector')
    }
    const idempotencyKey=requireIdempotencyKey(request)
    const correlationId=requireCorrelationId(request)
    const result=await mutating(reply,() => nodeHeartbeatPublisher.publish({
      idempotencyKey,correlationId,tenantId:auth.principal!.tenantId,
      principalId:auth.principal!.principalId,to:poolAddress,calldata:encoded,
      minimumConfirmations,requireFinalized:true,
      payload:{
        schemaVersion:1,chainId,poolAddress,expectedLivenessAccount,nodeId,profileHash,
        confirmationPolicy:{ minimumConfirmations },
      },
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(),{
      tenantId:auth.principal.tenantId,principalId:auth.principal.principalId,
      action:'node-heartbeat.publish',target:nodeId,idempotencyKey,
      details:{ operationId:result.value.operationId,correlationId,status:result.value.status },
    })
    reply.header('x-correlation-id',correlationId)
    return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
  })

  app.post<{ Body: {
    schemaVersion?:number;chainId?:number;roomManager?:string;expectedOperationsAccount?:string
    roomId?:string;admissionIds?:string[]
    artifacts?:{
      prepare?:{ jobId?:string;resultDigest?:string;prepareArtifactDigest?:string }
      prove?:{ jobId?:string;resultDigest?:string }
      verify?:{ jobId?:string;resultDigest?:string }
    }
    confirmationPolicy?:{ minimumConfirmations?:number;requireFinalized?:boolean }
  } }>('/hosting/v1/l1-operations/room-batches',async (request,reply) => {
    const auth=await authenticate(request,reply,'l1-room-submit','service')
    if (!auth?.principal) return reply
    if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-room-submit') {
      return reply.code(403).send({ error:'room batch credential must carry only l1-room-submit' })
    }
    if (!roomBatchPublisher) return reply.code(503).send({ error:'scoped room-operations publisher is not configured' })
    const body=request.body ?? {}
    if (body.schemaVersion!==1) return reply.code(400).send({ error:'schemaVersion must equal 1' })
    const chainId=cleanChainId(body.chainId)
    const manager=cleanAddress(body.roomManager,'roomManager')
    const expectedSender=cleanAddress(body.expectedOperationsAccount,'expectedOperationsAccount')
    const roomId=cleanDecimal(body.roomId,'roomId')
    if (body.confirmationPolicy?.requireFinalized!==true) {
      return reply.code(400).send({ error:'room batch confirmationPolicy.requireFinalized must equal true' })
    }
    const minimumConfirmations=positiveInt(body.confirmationPolicy.minimumConfirmations,0,4_096)
    const binding=await runtime!.store.l1ServiceBinding(auth.principal.principalId)
    const tenantId=await runtime!.store.roomTenant(chainId,roomId)
    if (
      !binding || !binding.active || binding.bindingKind!=='room-submit'
      || binding.chainId!==chainId || binding.contractAddress!==manager
      || binding.expectedSender!==expectedSender || binding.roomId!==roomId
      || expectedSender!==roomBatchPublisher.signerAddress
      || manager!==config.roomManager
      || !tenantId || tenantId!==auth.principal.tenantId
    ) return reply.code(403).send({ error:'room-submit principal is not bound to this exact tenant room authority' })

    const correlationId=requireCorrelationId(request)
    const idempotencyKey=requireIdempotencyKey(request)
    const artifactInput=(name:'prepare'|'prove'|'verify') => {
      const value=body.artifacts?.[name]
      if (!value) throw new Error(`${name} artifact binding is required`)
      const jobId=cleanResourceId(value.jobId,`${name}.jobId`)
      if (!/^pj-[0-9a-f]{10,64}$/.test(jobId)) throw new Error(`${name}.jobId is malformed`)
      return { jobId,resultDigest:cleanDigest(value.resultDigest,`${name}.resultDigest`) }
    }
    const prepareInput=artifactInput('prepare')
    const proveInput=artifactInput('prove')
    const verifyInput=artifactInput('verify')
    const prepareArtifactDigest=cleanDigest(
      body.artifacts?.prepare?.prepareArtifactDigest,'prepare.prepareArtifactDigest',
    )

    const loadArtifact=async (
      input:{ jobId:string;resultDigest:string },endpoint:string,name:string,
    ) => {
      const job=await runtime!.store.getProveJob(input.jobId,tenantId)
      if (
        !job || job.status!=='DONE' || job.roomId!==roomId || job.correlationId!==correlationId
        || job.endpoint!==endpoint || job.resultDigest!==input.resultDigest || !job.resultObjectKey
      ) throw new Error(`${name} job is not the exact completed tenant/room/correlation artifact`)
      const [requestBytes,resultBytes]=await Promise.all([
        runtime!.objects.get(job.requestObjectKey),runtime!.objects.get(job.resultObjectKey),
      ])
      if (!resultBytes || createHash('sha256').update(resultBytes).digest('hex')!==input.resultDigest) {
        throw new Error(`${name} result bytes changed digest`)
      }
      return {
        job,request:jsonObject(requestBytes,`${name} request`),
        result:jsonObject(resultBytes,`${name} result`),
      }
    }
    const [prepared,proved,verified]=await Promise.all([
      loadArtifact(prepareInput,'/hosting/v1/rooms/prepare-batch','prepare'),
      loadArtifact(proveInput,'/v5/rooms/prove','prove'),
      loadArtifact(verifyInput,'/v5/rooms/verify','verify'),
    ])
    const prepare=prepared.result
    const prove=proved.result
    const verify=verified.result
    if (
      prepare.schemaVersion!==1 || prepare.preparedFrom!=='live-room-engine-state' || prepare.fixture!==false
      || prepare.prepareArtifactDigest!==prepareArtifactDigest
      || prepare.contentAddress!==prepareArtifactDigest
      || prove.backendId!=='risc0' || prove.proofMode!=='groth16'
      || verify.ok!==true || verify.proofMode!=='groth16'
    ) throw new Error('room batch artifact lineage is not a production live zkVM proof')
    const proofRequest=record(prepare.proofRequest)
    const witnessInputDigest=`0x${prepareArtifactDigest}`
    if (
      proofRequest.production!==true || proofRequest.proofMode!=='groth16'
      || proofRequest.inputDigest!==witnessInputDigest
      || canonicalJson(proved.request)!==canonicalJson(proofRequest)
      || prove.inputDigest!==proofRequest.inputDigest || prove.jobId!==proofRequest.jobId
      || prove.programId!==prepare.programId
    ) throw new Error('prove job request is not bound to the live prepared witness')
    const journalHash=cleanHash(prepare.journalHash,'prepare.journalHash')
    if (
      cleanHash(prove.journalHash,'prove.journalHash')!==journalHash
      || cleanHash(verify.journalHash,'verify.journalHash')!==journalHash
      || canonicalJson(prepare.journal)!==canonicalJson(prove.journal)
      || canonicalJson(prove.journal)!==canonicalJson(verify.journal)
    ) throw new Error('prepare/prove/verify journals do not have one exact identity')
    if (
      canonicalJson(verified.request)!==canonicalJson({
        journal:prove.journal,journalHash:prove.journalHash,receiptB64:prove.receiptB64,
      })
      || verify.ethereumSealB64!==prove.ethereumSealB64
      || (verify.imageId!==undefined && prove.imageId!==undefined && verify.imageId!==prove.imageId)
    ) throw new Error('verify job did not verify the exact proved receipt')

    const fn=submitBatchFunction()
    const submissionParameter=fn.inputs[1]!
    const journalParameter=(submissionParameter as AbiParameter & { components:readonly AbiParameter[] }).components[0]!
    const provisional=record(prepare.provisionalSubmission)
    if (provisional.seal!=='0x') throw new Error('prepared provisional submission seal must be empty')
    const contractJournal=coerceAbiValue(journalParameter,provisional.journal,'submission.journal')
    const encodedJournalHash=keccak256(encodeAbiParameters([journalParameter],[contractJournal]))
    if (encodedJournalHash!==journalHash) throw new Error('Solidity BatchJournal hash differs from the proved journal hash')
    const journalObject=record(provisional.journal)
    if (cleanDecimal(journalObject.protocolVersion,'journal.protocolVersion')!=='6'
      || cleanDecimal(journalObject.roomId,'journal.roomId')!==roomId) {
      throw new Error('proved journal is not protocol 6 for the bound room')
    }
    const latest=await runtime!.l1.agreedBlock('latest')
    const inclusionDeadline=BigInt(cleanDecimal(journalObject.l1InclusionDeadline,'journal.l1InclusionDeadline'))
    if (inclusionDeadline<BigInt(latest.number)+BigInt(config.minimumDeadlineLeadBlocks)) {
      throw new Error('proved room batch no longer has the required L1 inclusion margin')
    }

    const admissionIds=(body.admissionIds ?? []).map((id) => cleanDecimal(id,'admissionId'))
    if (new Set(admissionIds).size!==admissionIds.length) throw new Error('admissionIds must be unique')
    const cursorBefore=BigInt(cleanDecimal(journalObject.admissionCursorBefore,'journal.admissionCursorBefore'))
    const cursorAfter=BigInt(cleanDecimal(journalObject.admissionCursorAfter,'journal.admissionCursorAfter'))
    if (cursorAfter<cursorBefore || cursorAfter-cursorBefore!==BigInt(admissionIds.length)
      || admissionIds.some((id,index) => BigInt(id)!==cursorBefore+BigInt(index)+1n)) {
      throw new Error('admissionIds do not exactly cover the proved journal cursor interval')
    }
    const admissionRecords=await runtime!.store.acknowledgedAdmissions(roomId,tenantId,admissionIds)
    const submissionAdmissions=Array.isArray(provisional.admissions) ? provisional.admissions : null
    if (!submissionAdmissions || submissionAdmissions.length!==admissionRecords.length) {
      throw new Error('provisional submission admissions differ from ACKED admission ids')
    }
    for (const [index,item] of submissionAdmissions.entries()) {
      const admissionRecord=admissionRecords[index]!
      const recordObject=record(item)
      const receipt=record(recordObject.receipt)
      const outcome=record(recordObject.outcome)
      const durable=record(admissionRecord.receipt)
      const expectedReceipt={
        admissionId:durable.admissionId,transactionHash:durable.transactionHash,
        depositInboxId:durable.depositInboxId,depositContentHash:durable.depositContentHash,
        deadlineBlock:durable.deadlineBlock,maximumBatchIndex:durable.maximumBatchIndex,
        bondEpoch:durable.bondEpoch,admissionFee:durable.admissionFee,signature:durable.signature,
      }
      if (canonicalJson(receipt)!==canonicalJson(expectedReceipt)
        || cleanDecimal(receipt.admissionId,'admission.receipt.admissionId')!==admissionRecord.admissionId
        || cleanDecimal(outcome.admissionId,'admission.outcome.admissionId')!==admissionRecord.admissionId
        || String(outcome.transactionHash).toLowerCase()!==admissionRecord.transactionHash.toLowerCase()) {
        throw new Error('provisional admission record differs from the immutable ACKED WAL receipt')
      }
    }

    const submission={ ...provisional,seal:base64Hex(prove.ethereumSealB64,'prove.ethereumSealB64') }
    const calldata=encodeFunctionData({
      abi:[fn] as Abi,functionName:'submitBatch',
      args:[BigInt(roomId),coerceAbiValue(submissionParameter,submission,'submission')],
    })
    await runtime!.assertCriticalL1Ready()
    const operationBinding={
      schemaVersion:1,chainId,roomManager:manager,expectedOperationsAccount:expectedSender,roomId,
      correlationId,prepareJobId:prepareInput.jobId,prepareResultDigest:prepareInput.resultDigest,
      prepareArtifactDigest,proveJobId:proveInput.jobId,proveResultDigest:proveInput.resultDigest,
      verifyJobId:verifyInput.jobId,verifyResultDigest:verifyInput.resultDigest,
      journalHash,calldataHash:keccak256(calldata),admissionIds,
      confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
    }
    const result=await mutating(reply,() => roomBatchPublisher.publish({
      idempotencyKey,correlationId,tenantId,principalId:auth.principal!.principalId,
      to:manager,calldata,minimumConfirmations,requireFinalized:true,payload:operationBinding,
    }))
    if (!result.ok) return reply
    await runtime!.store.recordAudit(runtime!.writableFence(),{
      tenantId,principalId:auth.principal.principalId,action:'room-batch.publish',target:roomId,
      idempotencyKey,details:{ operationId:result.value.operationId,correlationId,journalHash,
        prepareJobId:prepareInput.jobId,proveJobId:proveInput.jobId,verifyJobId:verifyInput.jobId },
    })
    reply.header('x-correlation-id',correlationId)
    return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
  })

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/l1-operations/room-aggregates',async (request,reply) => {
      const auth=await authenticate(request,reply,'l1-aggregate-submit','service')
      if (!auth?.principal) return reply
      if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-aggregate-submit') {
        return reply.code(403).send({ error:'aggregate credential must carry only l1-aggregate-submit' })
      }
      if (!roomAggregatePublisher) {
        return reply.code(503).send({ error:'scoped aggregate type-3 publisher is not configured' })
      }
      const body=record(request.body)
      if (body.schemaVersion!==1) throw new Error('schemaVersion must equal 1')
      const chainId=cleanChainId(body.chainId)
      const manager=cleanAddress(body.roomManager,'roomManager')
      const expectedSender=cleanAddress(body.expectedOperationsAccount,'expectedOperationsAccount')
      const policy=record(body.confirmationPolicy)
      if (policy.requireFinalized!==true) {
        throw new Error('aggregate confirmationPolicy.requireFinalized must equal true')
      }
      const minimumConfirmations=positiveInt(policy.minimumConfirmations,0,4_096)
      const binding=await runtime!.store.l1ServiceBinding(auth.principal.principalId)
      if (!binding?.active || binding.bindingKind!=='room-aggregate'
        || binding.chainId!==chainId || binding.contractAddress!==manager
        || binding.expectedSender!==expectedSender
        || expectedSender!==roomAggregatePublisher.signerAddress || manager!==config.roomManager) {
        return reply.code(403).send({ error:'aggregate principal is not bound to this exact tenant authority' })
      }
      const correlationId=requireCorrelationId(request)
      const idempotencyKey=requireIdempotencyKey(request)
      const artifacts=record(body.artifacts)
      const rawMembers=artifacts.members
      if (!Array.isArray(rawMembers) || rawMembers.length<1 || rawMembers.length>8) {
        throw new Error('aggregate members must contain 1 through 8 entries')
      }
      const artifactBinding=(value:unknown,name:string,prepared=false) => {
        const item=record(value)
        const jobId=cleanResourceId(item.jobId,`${name}.jobId`)
        if (!/^pj-[0-9a-f]{10,64}$/.test(jobId)) throw new Error(`${name}.jobId is malformed`)
        return {
          jobId,resultDigest:cleanDigest(item.resultDigest,`${name}.resultDigest`),
          ...(prepared ? { prepareArtifactDigest:cleanDigest(
            item.prepareArtifactDigest,`${name}.prepareArtifactDigest`,
          ) } : {}),
        }
      }
      const members=rawMembers.map((value,index) => {
        const member=record(value)
        return {
          memberIndex:index,roomId:cleanDecimal(member.roomId,`members[${index}].roomId`),
          prepare:artifactBinding(member.prepare,`members[${index}].prepare`,true),
          prove:artifactBinding(member.prove,`members[${index}].prove`),
          verify:artifactBinding(member.verify,`members[${index}].verify`),
        }
      })
      if (new Set(members.map((member) => member.roomId)).size!==members.length) {
        throw new Error('aggregate roomId values must be unique')
      }
      const tenantId=auth.principal.tenantId
      for (const member of members) {
        if (await runtime!.store.roomTenant(chainId,member.roomId)!==tenantId) {
          return reply.code(403).send({ error:'aggregate member belongs to another tenant' })
        }
      }

      const loadArtifact=async (
        input:{ jobId:string;resultDigest:string },endpoint:string,name:string,roomId:string|null,
      ) => {
        const job=await runtime!.store.getProveJob(input.jobId,tenantId)
        if (!job || job.status!=='DONE' || job.correlationId!==correlationId
          || job.endpoint!==endpoint || job.resultDigest!==input.resultDigest || !job.resultObjectKey
          || (roomId!==null && job.roomId!==roomId)) {
          throw new Error(`${name} is not the exact completed tenant/correlation queue artifact`)
        }
        const [requestBytes,resultBytes]=await Promise.all([
          runtime!.objects.get(job.requestObjectKey),runtime!.objects.get(job.resultObjectKey),
        ])
        if (!resultBytes || createHash('sha256').update(resultBytes).digest('hex')!==input.resultDigest) {
          throw new Error(`${name} result bytes changed digest`)
        }
        return { job,request:jsonObject(requestBytes,`${name} request`),result:jsonObject(resultBytes,`${name} result`) }
      }

      const submitBatch=submitBatchFunction()
      const submissionParameter=submitBatch.inputs[1]!
      const journalParameter=(submissionParameter as AbiParameter & { components:readonly AbiParameter[] }).components[0]!
      const latest=await runtime!.l1.agreedBlock('latest')
      const memberArtifacts=[] as Array<{
        memberIndex:number;roomId:string;batchIndex:string;journalHash:`0x${string}`
        deploymentDomain:`0x${string}`;provisional:Record<string,unknown>
        submission:unknown;programId:`0x${string}`;receiptB64:string
        prepare:{jobId:string;resultDigest:string;prepareArtifactDigest?:string}
        prove:{jobId:string;resultDigest:string};verify:{jobId:string;resultDigest:string}
        proveResultObjectKey:string;admissionIds:string[]
      }>
      for (const member of members) {
        const [prepared,proved,verified]=await Promise.all([
          loadArtifact(member.prepare,'/hosting/v1/rooms/prepare-batch',`member ${member.memberIndex} prepare`,member.roomId),
          loadArtifact(member.prove,'/v5/rooms/prove',`member ${member.memberIndex} prove`,member.roomId),
          loadArtifact(member.verify,'/v5/rooms/verify',`member ${member.memberIndex} verify`,member.roomId),
        ])
        const prepare=prepared.result,prove=proved.result,verify=verified.result
        const preparedDigest=member.prepare.prepareArtifactDigest!
        if (prepare.schemaVersion!==1 || prepare.preparedFrom!=='live-room-engine-state'
          || prepare.fixture!==false || prepare.prepareArtifactDigest!==preparedDigest
          || prepare.contentAddress!==preparedDigest || prove.backendId!=='risc0'
          || prove.proofMode!=='groth16' || verify.ok!==true || verify.proofMode!=='groth16') {
          throw new Error(`member ${member.memberIndex} is not a production live zkVM proof`)
        }
        const proofRequest=record(prepare.proofRequest)
        if (proofRequest.production!==true || proofRequest.proofMode!=='groth16'
          || proofRequest.inputDigest!==`0x${preparedDigest}`
          || canonicalJson(proved.request)!==canonicalJson(proofRequest)
          || prove.inputDigest!==proofRequest.inputDigest || prove.jobId!==proofRequest.jobId
          || prove.programId!==prepare.programId) {
          throw new Error(`member ${member.memberIndex} prove request changed live witness identity`)
        }
        const journalHash=cleanHash(prepare.journalHash,`member ${member.memberIndex} journalHash`)
        if (cleanHash(prove.journalHash,'prove.journalHash')!==journalHash
          || cleanHash(verify.journalHash,'verify.journalHash')!==journalHash
          || canonicalJson(prepare.journal)!==canonicalJson(prove.journal)
          || canonicalJson(prove.journal)!==canonicalJson(verify.journal)
          || canonicalJson(verified.request)!==canonicalJson({
            journal:prove.journal,journalHash:prove.journalHash,receiptB64:prove.receiptB64,
          }) || verify.ethereumSealB64!==prove.ethereumSealB64) {
          throw new Error(`member ${member.memberIndex} prepare/prove/verify identity differs`)
        }
        if (typeof prove.receiptB64!=='string') throw new Error(`member ${member.memberIndex} receipt is missing`)
        const provisional=record(prepare.provisionalSubmission)
        if (provisional.seal!=='0x') throw new Error('aggregate member provisional seal must be empty')
        const contractJournal=coerceAbiValue(journalParameter,provisional.journal,'submission.journal')
        if (keccak256(encodeAbiParameters([journalParameter],[contractJournal]))!==journalHash) {
          throw new Error(`member ${member.memberIndex} Solidity journal hash differs from its receipt`)
        }
        const journal=record(provisional.journal)
        if (cleanDecimal(journal.protocolVersion,'journal.protocolVersion')!=='6'
          || cleanDecimal(journal.roomId,'journal.roomId')!==member.roomId) {
          throw new Error(`member ${member.memberIndex} journal is not protocol 6 for its bound room`)
        }
        const inclusionDeadline=BigInt(cleanDecimal(journal.l1InclusionDeadline,'journal.l1InclusionDeadline'))
        if (inclusionDeadline<BigInt(latest.number)+BigInt(config.minimumDeadlineLeadBlocks)) {
          throw new Error(`member ${member.memberIndex} no longer has the required L1 inclusion margin`)
        }
        const admissions=Array.isArray(provisional.admissions) ? provisional.admissions : []
        const admissionIds=admissions.map((item,index) => cleanDecimal(
          record(record(item).receipt).admissionId,`members[${member.memberIndex}].admissions[${index}].admissionId`,
        ))
        if (new Set(admissionIds).size!==admissionIds.length) throw new Error('aggregate member admission ids must be unique')
        const cursorBefore=BigInt(cleanDecimal(journal.admissionCursorBefore,'journal.admissionCursorBefore'))
        const cursorAfter=BigInt(cleanDecimal(journal.admissionCursorAfter,'journal.admissionCursorAfter'))
        if (cursorAfter<cursorBefore || cursorAfter-cursorBefore!==BigInt(admissionIds.length)
          || admissionIds.some((id,index) => BigInt(id)!==cursorBefore+BigInt(index)+1n)) {
          throw new Error(`member ${member.memberIndex} admission ids do not cover its journal cursor`)
        }
        const durableAdmissions=await runtime!.store.acknowledgedAdmissions(member.roomId,tenantId,admissionIds)
        if (durableAdmissions.length!==admissions.length) throw new Error('aggregate member contains an unacknowledged admission')
        for (const [index,item] of admissions.entries()) {
          const durable=durableAdmissions[index]!,itemObject=record(item)
          const receipt=record(itemObject.receipt),outcome=record(itemObject.outcome)
          const durableReceipt=record(durable.receipt)
          const expectedReceipt={
            admissionId:durableReceipt.admissionId,transactionHash:durableReceipt.transactionHash,
            depositInboxId:durableReceipt.depositInboxId,depositContentHash:durableReceipt.depositContentHash,
            deadlineBlock:durableReceipt.deadlineBlock,maximumBatchIndex:durableReceipt.maximumBatchIndex,
            bondEpoch:durableReceipt.bondEpoch,admissionFee:durableReceipt.admissionFee,
            signature:durableReceipt.signature,
          }
          if (canonicalJson(receipt)!==canonicalJson(expectedReceipt)
            || cleanDecimal(outcome.admissionId,'admission.outcome.admissionId')!==durable.admissionId
            || String(outcome.transactionHash).toLowerCase()!==durable.transactionHash.toLowerCase()) {
            throw new Error('aggregate member admission differs from its immutable ACKED WAL receipt')
          }
        }
        memberArtifacts.push({
          memberIndex:member.memberIndex,roomId:member.roomId,
          batchIndex:cleanDecimal(journal.batchIndex,'journal.batchIndex'),journalHash,
          deploymentDomain:cleanHash(journal.deploymentDomain,'journal.deploymentDomain'),provisional,
          submission:coerceAbiValue(submissionParameter,provisional,'submission'),
          programId:cleanHash(prove.programId,'prove.programId'),receiptB64:prove.receiptB64,
          prepare:member.prepare,prove:member.prove,verify:member.verify,
          proveResultObjectKey:proved.job.resultObjectKey!,admissionIds,
        })
      }
      const deploymentDomain=memberArtifacts[0]!.deploymentDomain
      if (memberArtifacts.some((member) => member.deploymentDomain!==deploymentDomain)) {
        throw new Error('aggregate members do not share one deploymentDomain')
      }

      const rawDa=artifacts.dataAvailability ?? []
      if (!Array.isArray(rawDa)) throw new Error('dataAvailability must be an array')
      const daInputs=rawDa.map((value,index) => {
        const item=record(value)
        return {
          memberIndex:nonnegativeInt(item.memberIndex,index,7),roomId:cleanDecimal(item.roomId,`dataAvailability[${index}].roomId`),
          prepare:artifactBinding(item.prepare,`dataAvailability[${index}].prepare`),
          prove:artifactBinding(item.prove,`dataAvailability[${index}].prove`),
          verify:artifactBinding(item.verify,`dataAvailability[${index}].verify`),
        }
      })
      if (daInputs.some((item,index) => index>0 && item.memberIndex<=daInputs[index-1]!.memberIndex)) {
        throw new Error('dataAvailability entries must be sorted by unique memberIndex')
      }
      if (new Set(daInputs.map((item) => item.memberIndex)).size!==daInputs.length) {
        throw new Error('dataAvailability memberIndex values must be unique')
      }
      const daByMember=new Map<number,{
        manifest:Record<string,unknown>;statement:`0x${string}`;programId:`0x${string}`
        receiptB64:string;blobs:Hex[];prepare:{jobId:string;resultDigest:string}
        prove:{jobId:string;resultDigest:string};verify:{jobId:string;resultDigest:string}
      }>()
      for (const item of daInputs) {
        const member=memberArtifacts[item.memberIndex]
        if (!member || member.roomId!==item.roomId) throw new Error('dataAvailability entries must target an existing aggregate member room')
        const [prepared,proved,verified]=await Promise.all([
          loadArtifact(item.prepare,'/v5/data-availability/prepare',`DA ${item.memberIndex} prepare`,item.roomId),
          loadArtifact(item.prove,'/v5/data-availability/prove',`DA ${item.memberIndex} prove`,item.roomId),
          loadArtifact(item.verify,'/v5/data-availability/verify',`DA ${item.memberIndex} verify`,item.roomId),
        ])
        const prepare=prepared.result,prove=proved.result,verify=verified.result
        const witness=record(prepare.equivalenceWitness)
        const proveWitness=record(prove.equivalenceWitness)
        const prepareRequestWitness=record(prepared.request.equivalenceWitness)
        const proveRequestWitness=record(proved.request.equivalenceWitness)
        const verifyRequestWitness=record(verified.request.equivalenceWitness)
        if (canonicalJson(witness)!==canonicalJson(prepareRequestWitness)
          || canonicalJson(witness)!==canonicalJson(proveWitness)
          || canonicalJson(witness)!==canonicalJson(proveRequestWitness)
          || canonicalJson(witness)!==canonicalJson(verifyRequestWitness)
          || prove.kind!=='data-availability-equivalence' || prove.proofMode!=='groth16'
          || proved.request.production!==true || proved.request.proofMode!=='groth16'
          || verify.ok!==true || verified.request.receiptB64!==prove.receiptB64) {
          throw new Error(`DA ${item.memberIndex} prepare/prove/verify lineage differs`)
        }
        const statement=cleanHash(prove.statement,'DA statement')
        const programId=cleanHash(prove.programId,'DA programId')
        if (cleanHash(prepare.statement,'DA prepare statement')!==statement
          || cleanHash(verify.statement,'DA verify statement')!==statement
          || cleanHash(verify.programId,'DA verify programId')!==programId
          || cleanDecimal(witness.roomId,'DA witness roomId')!==member.roomId
          || cleanHash(witness.journalHash,'DA witness journalHash')!==member.journalHash
          || cleanHash(witness.deploymentDomain,'DA witness deploymentDomain')!==deploymentDomain
          || typeof prove.receiptB64!=='string') {
          throw new Error(`DA ${item.memberIndex} statement is not bound to its room receipt`)
        }
        const manifest=record(prove.dataAvailabilityManifest)
        const prepareManifest=record(prepare.dataAvailabilityManifest)
        const verifyManifest=record(verify.dataAvailabilityManifest)
        const withoutSeal=(value:Record<string,unknown>) => ({ ...value,equivalenceSeal:'0x' })
        if (canonicalJson(withoutSeal(manifest))!==canonicalJson(withoutSeal(prepareManifest))
          || canonicalJson(withoutSeal(manifest))!==canonicalJson(withoutSeal(verifyManifest))
          || cleanHexData(manifest.equivalenceSeal,'DA equivalenceSeal')
            !==cleanHexData(prove.ethereumSealHex,'DA ethereumSealHex')) {
          throw new Error(`DA ${item.memberIndex} manifest differs from the proved equivalence receipt`)
        }
        const blobs=Array.isArray(prove.blobsB64)
          ? prove.blobsB64.map((blob,index) => base64Blob(blob,`DA ${item.memberIndex} blobsB64[${index}]`)) : []
        const versions=strings(manifest.blobVersionedHashes)
        const commitments=strings(manifest.commitments)
        const evaluationPoints=strings(manifest.evaluationPoints)
        const evaluations=strings(manifest.evaluations)
        const kzgProofs=strings(manifest.kzgProofs)
        if (blobs.length<1 || blobs.length!==versions.length || blobs.length!==commitments.length
          || blobs.length!==evaluationPoints.length || blobs.length!==evaluations.length
          || blobs.length!==kzgProofs.length) {
          throw new Error(`DA ${item.memberIndex} manifest vectors do not match its blob count`)
        }
        versions.forEach((value,index) => cleanHash(value,`DA versionedHash[${index}]`))
        commitments.forEach((value,index) => {
          const hex=cleanHexData(value,`DA commitment[${index}]`)
          if ((hex.length-2)/2!==48) throw new Error('DA commitment must contain 48 bytes')
        })
        kzgProofs.forEach((value,index) => {
          const hex=cleanHexData(value,`DA kzgProof[${index}]`)
          if ((hex.length-2)/2!==48) throw new Error('DA point-evaluation proof must contain 48 bytes')
        })
        daByMember.set(item.memberIndex,{ manifest,statement,programId,receiptB64:prove.receiptB64,
          blobs,prepare:item.prepare,prove:item.prove,verify:item.verify })
      }

      const aggregateBindings=record(artifacts.aggregate)
      const aggregateProveInput=artifactBinding(aggregateBindings.prove,'aggregate.prove')
      const aggregateVerifyInput=artifactBinding(aggregateBindings.verify,'aggregate.verify')
      const [aggregateProved,aggregateVerified]=await Promise.all([
        loadArtifact(aggregateProveInput,'/v5/aggregates/prove','aggregate prove',null),
        loadArtifact(aggregateVerifyInput,'/v5/aggregates/verify','aggregate verify',null),
      ])
      const aggregateRequest=aggregateProved.request,aggregateProof=aggregateProved.result
      const aggregateVerifyRequest=aggregateVerified.request,aggregateVerify=aggregateVerified.result
      const aggregateWitness=record(aggregateRequest.aggregateWitness)
      const witnessMembers=aggregateWitness.members
      const memberReceipts=aggregateRequest.memberReceipts
      if (!Array.isArray(witnessMembers) || witnessMembers.length!==members.length
        || !Array.isArray(memberReceipts) || memberReceipts.length!==members.length
        || aggregateRequest.production!==true || aggregateRequest.proofMode!=='groth16'
        || aggregateProof.kind!=='recursive-room-aggregate' || aggregateProof.proofMode!=='groth16'
        || canonicalJson(aggregateProof.aggregateWitness)!==canonicalJson(aggregateWitness)
        || aggregateVerify.ok!==true
        || canonicalJson(aggregateVerifyRequest.aggregateWitness)!==canonicalJson(aggregateWitness)
        || aggregateVerifyRequest.receiptB64!==aggregateProof.receiptB64) {
        throw new Error('aggregate prove/verify jobs are not one production recursive receipt')
      }
      const aggregateStatement=cleanHash(aggregateProof.statement,'aggregate statement')
      const aggregateProgramId=cleanHash(aggregateProof.programId,'aggregate programId')
      if (cleanHash(aggregateVerify.statement,'aggregate verify statement')!==aggregateStatement
        || cleanHash(aggregateVerify.programId,'aggregate verify programId')!==aggregateProgramId
        || cleanHash(aggregateWitness.deploymentDomain,'aggregate deploymentDomain')!==deploymentDomain
        || Number(aggregateProof.memberCount)!==members.length
        || Number(aggregateVerify.memberCount)!==members.length) {
        throw new Error('aggregate statement identity differs from the ordered members')
      }
      const ZERO_HASH=`0x${'00'.repeat(32)}` as `0x${string}`
      for (const [index,value] of witnessMembers.entries()) {
        const witness=record(value),receipt=record(memberReceipts[index])
        const member=memberArtifacts[index]!,da=daByMember.get(index)
        if (cleanDecimal(witness.roomId,'aggregate witness roomId')!==member.roomId
          || cleanHash(witness.roomProgramId,'aggregate roomProgramId')!==member.programId
          || cleanHash(witness.journalHash,'aggregate journalHash')!==member.journalHash
          || receipt.roomReceiptB64!==member.receiptB64) {
          throw new Error(`aggregate witness member ${index} differs from its room proof`)
        }
        if (da) {
          if (cleanHash(witness.equivalenceProgramId,'equivalenceProgramId')!==da.programId
            || cleanHash(witness.equivalenceStatement,'equivalenceStatement')!==da.statement
            || receipt.equivalenceReceiptB64!==da.receiptB64) {
            throw new Error(`aggregate witness member ${index} differs from its DA proof`)
          }
        } else if (cleanHash(witness.equivalenceProgramId,'equivalenceProgramId')!==ZERO_HASH
          || cleanHash(witness.equivalenceStatement,'equivalenceStatement')!==ZERO_HASH
          || receipt.equivalenceReceiptB64!==undefined) {
          throw new Error(`calldata aggregate member ${index} carries DA proof identity`)
        }
      }

      let nextBlobIndex=0
      const blobs:Hex[]=[]
      const orderedDa=[...daByMember.entries()].sort(([left],[right]) => left-right)
      for (const [memberIndex,da] of orderedDa) {
        const start=nonnegativeInt(da.manifest.blobStartIndex,0,5)
        if (start!==nextBlobIndex) throw new Error(`DA ${memberIndex} blob range is not aggregate-contiguous`)
        nextBlobIndex+=da.blobs.length
        if (nextBlobIndex>6) throw new Error('zkdeal aggregate submission cap is six blobs')
        blobs.push(...da.blobs)
      }
      if (blobs.length<1) throw new Error('room aggregate type-3 submission requires at least one proved blob')
      const bundle=await buildBlobBundleFromBlobs(blobs)
      const manifestVersions=orderedDa.flatMap(([,da]) => strings(da.manifest.blobVersionedHashes)
        .map((value) => cleanHash(value,'manifest versioned hash')))
      const manifestCommitments=orderedDa.flatMap(([,da]) => strings(da.manifest.commitments)
        .map((value) => cleanHexData(value,'manifest commitment')))
      if (canonicalJson(bundle.versionedHashes)!==canonicalJson(manifestVersions)
        || canonicalJson(bundle.commitments)!==canonicalJson(manifestCommitments)) {
        throw new Error('proved DA manifests differ from the exact type-3 sidecar blobs')
      }

      const emptyManifest={
        canonicalDataHash:ZERO_HASH,canonicalDataLength:'0',blobStartIndex:0,
        blobVersionedHashes:[],commitments:[],evaluationPoints:[],evaluations:[],kzgProofs:[],
        equivalenceSeal:'0x',fallbackDeadlineBlock:'0',fallbackSignature:'0x',
      }
      const aggregateSubmission={
        members:memberArtifacts.map((member,index) => ({
          roomId:member.roomId,submission:member.provisional,
          dataAvailability:daByMember.get(index)?.manifest ?? emptyManifest,
        })),
        aggregateSeal:cleanHexData(aggregateProof.ethereumSealHex,'aggregate ethereumSealHex'),
      }
      const fn=submitAggregateFunction()
      const calldata=encodeFunctionData({
        abi:[fn] as Abi,functionName:'submitAggregate',
        args:[coerceAbiValue(fn.inputs[0]!,aggregateSubmission,'aggregate')],
      })
      if (!calldata.startsWith('0x5e8b37ac')) throw new Error('aggregate selector differs from pinned protocol selector')
      const bundleDigest=createHash('sha256').update(encodeBlobBundle(bundle)).digest('hex')
      const operationBinding={
        schemaVersion:1,kind:'ROOM_AGGREGATE',chainId,roomManager:manager,
        expectedOperationsAccount:expectedSender,selector:'0x5e8b37ac',transactionType:3,
        calldataHash:keccak256(calldata),correlationId,aggregateStatement,aggregateProgramId,
        aggregateProve:{ jobId:aggregateProveInput.jobId,resultDigest:aggregateProveInput.resultDigest },
        aggregateVerify:{ jobId:aggregateVerifyInput.jobId,resultDigest:aggregateVerifyInput.resultDigest },
        members:memberArtifacts.map((member,index) => {
          const da=daByMember.get(index)
          return {
            memberIndex:index,roomId:member.roomId,batchIndex:member.batchIndex,
            journalHash:member.journalHash,admissionIds:member.admissionIds,
            prepare:member.prepare,prove:member.prove,verify:member.verify,
            dataAvailability:da ? {
              statement:da.statement,programId:da.programId,
              blobStartIndex:da.manifest.blobStartIndex,blobCount:da.blobs.length,
              prepare:da.prepare,prove:da.prove,verify:da.verify,
            } : null,
          }
        }),
        orderedBlobVersionedHashes:bundle.versionedHashes,bundleDigest,
        zkdealBlobCount:bundle.blobs.length,
        confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
      }
      await runtime!.assertCriticalL1Ready()
      // The success-only billing manifest binds each member's prove job and
      // exact result digest to the on-chain aggregate statement hash; the
      // publisher registers it at the SIGNED boundary before any broadcast.
      const billing={
        aggregateHash:aggregateStatement,
        members:memberArtifacts.map((member) => ({
          memberIndex:member.memberIndex,jobId:member.prove.jobId,roomId:member.roomId,
          batchIndex:member.batchIndex,resultObjectKey:member.proveResultObjectKey,
          resultDigest:member.prove.resultDigest,
        })),
      }
      const result=await mutating(reply,() => roomAggregatePublisher.publish({
        idempotencyKey,correlationId,tenantId,principalId:auth.principal!.principalId,
        to:manager,calldata,blobs,billing,payload:operationBinding,
        minimumConfirmations,requireFinalized:true,
      }))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(),{
        tenantId,principalId:auth.principal.principalId,action:'room-aggregate.publish',
        target:result.value.operationId,idempotencyKey,details:{
          correlationId,aggregateStatement,aggregateProgramId,
          memberCount:members.length,blobCount:blobs.length,bundleDigest,
        },
      })
      reply.header('x-correlation-id',correlationId)
      return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
    },
  )

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/l1-operations/pool-sponsor-mutations',async (request,reply) => {
      const auth=await authenticate(request,reply,'l1-pool-sponsor','service')
      if (!auth?.principal) return reply
      if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-pool-sponsor') {
        return reply.code(403).send({ error:'sponsor credential must carry only l1-pool-sponsor' })
      }
      if (!poolSponsorPublisher) return reply.code(503).send({ error:'scoped pool sponsor publisher is not configured' })
      const body=record(request.body)
      if (body.schemaVersion!==1) throw new Error('schemaVersion must equal 1')
      const chainId=cleanChainId(body.chainId),roomPool=cleanAddress(body.roomPool,'roomPool')
      const expectedSender=cleanAddress(body.expectedSponsorAccount,'expectedSponsorAccount')
      const sponsorshipId=cleanResourceId(body.sponsorshipId,'sponsorshipId')
      const beneficiaryTenantId=cleanTenantId(body.beneficiaryTenantId)
      const beneficiary=cleanAddress(body.beneficiary,'beneficiary')
      if (beneficiary===`0x${'00'.repeat(20)}`) throw new Error('beneficiary must be a nonzero address')
      const policy=record(body.confirmationPolicy)
      if (policy.requireFinalized!==true) throw new Error('sponsor confirmationPolicy.requireFinalized must equal true')
      const minimumConfirmations=positiveInt(policy.minimumConfirmations,0,4_096)
      const [binding,sponsorship]=await Promise.all([
        runtime!.store.l1ServiceBinding(auth.principal.principalId),
        runtime!.store.sponsorshipAuthority(sponsorshipId),
      ])
      if (!binding?.active || binding.bindingKind!=='pool-sponsor'
        || binding.chainId!==chainId || binding.contractAddress!==roomPool
        || binding.expectedSender!==expectedSender || binding.sponsorshipId!==sponsorshipId
        || expectedSender!==poolSponsorPublisher.signerAddress || roomPool!==config.roomPool
        || !sponsorship || !sponsorship.active
        || sponsorship.sponsorTenantId!==auth.principal.tenantId
        || sponsorship.beneficiaryTenantId!==beneficiaryTenantId) {
        return reply.code(403).send({ error:'sponsor principal is not bound to this exact sponsorship authority' })
      }
      if (sponsorship.expiresAt!==null && Date.parse(sponsorship.expiresAt)<=Date.now()) {
        return reply.code(409).send({ error:'sponsorship terms are expired' })
      }
      const mutation=record(body.mutation)
      const mutationKind=mutation.kind
      const SPONSOR_SELECTORS={
        reserveAndStartForWithDataAvailabilityWithPermit:'0x827ac259',
        renewRoomForWithPermit:'0xf180fe5d',
      } as const
      if (typeof mutationKind!=='string' || !(mutationKind in SPONSOR_SELECTORS)) {
        throw new Error('mutation.kind must be reserveAndStartForWithDataAvailabilityWithPermit or renewRoomForWithPermit')
      }
      const selector=SPONSOR_SELECTORS[mutationKind as keyof typeof SPONSOR_SELECTORS]
      const rawReservation=record(mutation.reservation)
      const maxTokenCharge=cleanDecimal(rawReservation.maxTokenCharge,'reservation.maxTokenCharge')
      if (BigInt(maxTokenCharge)<=0n) throw new Error('reservation.maxTokenCharge must be positive')
      const rawPermit=record(mutation.permit)
      const permitValue=cleanDecimal(rawPermit.value,'permit.value')
      const permitDeadline=cleanDecimal(rawPermit.deadline,'permit.deadline')
      const permitV=cleanDecimal(rawPermit.v,'permit.v')
      cleanHash(rawPermit.r,'permit.r');cleanHash(rawPermit.s,'permit.s')
      if (permitV!=='27' && permitV!=='28') throw new Error('permit.v must equal 27 or 28')
      if (BigInt(permitValue)<BigInt(maxTokenCharge)) {
        throw new Error('permit.value must cover reservation.maxTokenCharge')
      }
      const correlationId=requireCorrelationId(request)
      const idempotencyKey=requireIdempotencyKey(request)
      await runtime!.assertCriticalL1Ready()
      let calldata:Hex
      let payload:Record<string,unknown>
      if (mutationKind==='renewRoomForWithPermit') {
        if (mutation.creation!==undefined || mutation.dataAvailability!==undefined) {
          throw new Error('renewRoomForWithPermit must not carry creation or dataAvailability')
        }
        const previousAllocationId=cleanHash(mutation.previousAllocationId,'mutation.previousAllocationId')
        if (sponsorship.allocationId!==null
          && sponsorship.allocationId.toLowerCase()!==previousAllocationId) {
          return reply.code(403).send({ error:'sponsorship terms are bound to a different allocation' })
        }
        const authority=await runtime!.store.canonicalAllocationAuthority(
          chainId,beneficiaryTenantId,previousAllocationId,
        )
        if (!authority) {
          return reply.code(409).send({ error:'previous allocation has no canonical beneficiary-tenant authority' })
        }
        const [head,canonicalHead]=await Promise.all([
          runtime!.l1.agreedBlock('latest'),runtime!.store.canonicalHead(chainId),
        ])
        if (!canonicalHead || canonicalHead.number!==head.number
          || canonicalHead.hash.toLowerCase()!==head.hash.toLowerCase()) {
          return reply.code(503).send({ error:'sponsor renewal requires an exactly indexed canonical head' })
        }
        const stateFn=allocationStateFunction()
        const call=await runtime!.l1.agreedCall({
          to:roomPool,data:encodeFunctionData({ abi:[stateFn],functionName:'allocationState',args:[previousAllocationId] }),
          blockTag:{ blockHash:head.hash,requireCanonical:true },
        })
        const providers=head.verifiedSources.filter((source) => call.verifiedSources.includes(source))
        if (new Set(providers).size<2) {
          return reply.code(503).send({ error:'allocation state lacks two-provider hash-bound evidence' })
        }
        const allocation=record(decodeFunctionResult({ abi:[stateFn],functionName:'allocationState',data:call.data }))
        if (cleanAddress(allocation.user,'allocation.user')!==beneficiary
          || cleanDecimal(allocation.roomId,'allocation.roomId')!==authority.roomId
          || cleanDecimal(allocation.status,'allocation.status')!=='2') {
          return reply.code(409).send({ error:'previous allocation is not currently renewable for this beneficiary' })
        }
        const fn=roomPoolFunction('renewRoomForWithPermit',4)
        calldata=encodeFunctionData({ abi:[fn],functionName:'renewRoomForWithPermit',args:[
          previousAllocationId,beneficiary,
          coerceAbiValue(fn.inputs[2]!,rawReservation,'mutation.reservation'),
          coerceAbiValue(fn.inputs[3]!,rawPermit,'mutation.permit'),
        ] }) as Hex
        payload={
          schemaVersion:1,chainId,roomPool,expectedSponsorAccount:expectedSender,sponsorshipId,
          beneficiaryTenantId,beneficiary,mutationKind,selector,previousAllocationId,
          roomId:authority.roomId,allocationFactId:authority.factId,
          allocationFactBlockHash:authority.blockHash,canonicalHeadHash:head.hash,
          receiptSources:[...new Set(providers)].sort(),
          maxTokenCharge,permit:{ value:permitValue,deadline:permitDeadline },
          calldataHash:keccak256(calldata),
          confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
        }
      } else {
        if (mutation.previousAllocationId!==undefined) {
          throw new Error('reserveAndStartForWithDataAvailabilityWithPermit must not carry previousAllocationId')
        }
        const rawCreation=record(mutation.creation)
        const rawDataAvailability=record(mutation.dataAvailability)
        const daPolicy=cleanDecimal(rawDataAvailability.policy,'mutation.dataAvailability.policy')
        if (BigInt(daPolicy)>2n) throw new Error('mutation.dataAvailability.policy must be 0 through 2')
        const fn=roomPoolFunction('reserveAndStartForWithDataAvailabilityWithPermit',5)
        calldata=encodeFunctionData({ abi:[fn],functionName:'reserveAndStartForWithDataAvailabilityWithPermit',args:[
          beneficiary,
          coerceAbiValue(fn.inputs[1]!,rawReservation,'mutation.reservation'),
          coerceAbiValue(fn.inputs[2]!,rawCreation,'mutation.creation'),
          coerceAbiValue(fn.inputs[3]!,rawDataAvailability,'mutation.dataAvailability'),
          coerceAbiValue(fn.inputs[4]!,rawPermit,'mutation.permit'),
        ] }) as Hex
        payload={
          schemaVersion:1,chainId,roomPool,expectedSponsorAccount:expectedSender,sponsorshipId,
          beneficiaryTenantId,beneficiary,mutationKind,selector,
          dataAvailabilityPolicy:daPolicy,
          maxTokenCharge,permit:{ value:permitValue,deadline:permitDeadline },
          calldataHash:keccak256(calldata),
          confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
        }
      }
      if (!calldata.startsWith(selector)) {
        throw new Error('sponsor mutation selector differs from pinned protocol selector')
      }
      const result=await mutating(reply,() => poolSponsorPublisher.publish({
        idempotencyKey,correlationId,tenantId:auth.principal!.tenantId,
        principalId:auth.principal!.principalId,to:roomPool,calldata,payload,
        minimumConfirmations,requireFinalized:true,
      }))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(),{
        tenantId:auth.principal.tenantId,principalId:auth.principal.principalId,
        action:'pool-sponsor-mutation.publish',target:sponsorshipId,idempotencyKey,
        details:{
          operationId:result.value.operationId,correlationId,mutationKind,selector,
          beneficiaryTenantId,beneficiary,
        },
      })
      reply.header('x-correlation-id',correlationId)
      return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
    },
  )

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/l1-operations/pool-finalized-checkpoints',async (request,reply) => {
      const auth=await authenticate(request,reply,'l1-pool-finality-oracle','service')
      if (!auth?.principal) return reply
      if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-pool-finality-oracle') {
        return reply.code(403).send({ error:'checkpoint credential must carry only l1-pool-finality-oracle' })
      }
      if (!poolFinalityPublisher) return reply.code(503).send({ error:'scoped pool finality publisher is not configured' })
      const body=record(request.body)
      if (body.schemaVersion!==1) throw new Error('schemaVersion must equal 1')
      const chainId=cleanChainId(body.chainId),roomPool=cleanAddress(body.roomPool,'roomPool')
      const expectedSender=cleanAddress(body.expectedFinalityOracleAccount,'expectedFinalityOracleAccount')
      const roomId=cleanDecimal(body.roomId,'roomId'),batchIndex=cleanDecimal(body.batchIndex,'batchIndex')
      const stateRoot=cleanHash(body.stateRoot,'stateRoot')
      const l1BlockNumber=cleanDecimal(body.l1BlockNumber,'l1BlockNumber')
      const l1BlockHash=cleanHash(body.l1BlockHash,'l1BlockHash')
      const policy=record(body.confirmationPolicy)
      if (policy.requireFinalized!==true) throw new Error('confirmationPolicy.requireFinalized must equal true')
      const minimumConfirmations=positiveInt(policy.minimumConfirmations,0,4_096)
      const binding=await runtime!.store.l1ServiceBinding(auth.principal.principalId)
      const tenantId=await runtime!.store.roomTenant(chainId,roomId)
      if (!binding?.active || binding.bindingKind!=='pool-finality-oracle'
        || binding.chainId!==chainId || binding.contractAddress!==roomPool
        || binding.expectedSender!==expectedSender || binding.roomId!==roomId
        || expectedSender!==poolFinalityPublisher.signerAddress || roomPool!==config.roomPool
        || tenantId!==auth.principal.tenantId) {
        return reply.code(403).send({ error:'finality principal is not bound to this exact tenant room authority' })
      }
      await runtime!.assertCriticalL1Ready()
      const fact=await runtime!.store.latestCanonicalRoomEvent(chainId,roomId,'BatchAccepted')
      if (!fact) return reply.code(409).send({ error:'canonical BatchAccepted fact is unavailable' })
      const factPayload=record(fact.payload),factArgs=record(factPayload.args)
      if (String(fact.blockNumber)!==l1BlockNumber || String(fact.blockHash).toLowerCase()!==l1BlockHash
        || cleanDecimal(factArgs.batchIndex,'BatchAccepted.batchIndex')!==batchIndex
        || cleanHash(factArgs.postStateRoot,'BatchAccepted.postStateRoot')!==stateRoot) {
        return reply.code(409).send({ error:'checkpoint request differs from the latest canonical BatchAccepted fact' })
      }
      const [finalized,exact]=await Promise.all([
        runtime!.l1.agreedBlock('finalized'),runtime!.l1.agreedBlock(`0x${BigInt(l1BlockNumber).toString(16)}`),
      ])
      if (BigInt(finalized.number)<BigInt(l1BlockNumber) || exact.hash.toLowerCase()!==l1BlockHash) {
        return reply.code(409).send({ error:'checkpoint source block is not independently finalized and canonical' })
      }
      const fn=roomPoolFunction('recordFinalizedCheckpoint',5)
      const calldata=encodeFunctionData({ abi:[fn],functionName:'recordFinalizedCheckpoint',args:[
        BigInt(roomId),BigInt(batchIndex),stateRoot,BigInt(l1BlockNumber),l1BlockHash,
      ] })
      const correlationId=requireCorrelationId(request),idempotencyKey=requireIdempotencyKey(request)
      const payload={
        schemaVersion:1,chainId,roomPool,expectedFinalityOracleAccount:expectedSender,roomId,batchIndex,
        stateRoot,l1BlockNumber,l1BlockHash,canonicalFactId:String(fact.factId),calldataHash:keccak256(calldata),
        receiptSources:[...new Set([...finalized.verifiedSources,...exact.verifiedSources])].sort(),
        confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
      }
      const result=await mutating(reply,() => poolFinalityPublisher.publish({
        idempotencyKey,correlationId,tenantId:tenantId!,principalId:auth.principal!.principalId,
        to:roomPool,calldata,payload,minimumConfirmations,requireFinalized:true,
      }))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(),{
        tenantId,principalId:auth.principal.principalId,action:'pool-finalized-checkpoint.publish',
        target:roomId,idempotencyKey,details:{ operationId:result.value.operationId,batchIndex,l1BlockHash },
      })
      reply.header('x-correlation-id',correlationId)
      return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
    },
  )

  app.post<{ Body:Record<string,unknown> }>(
    '/hosting/v1/l1-operations/pool-beneficiary-disposals',async (request,reply) => {
      const auth=await authenticate(request,reply,'l1-pool-beneficiary','service')
      if (!auth?.principal) return reply
      if (auth.principal.roles.length!==1 || auth.principal.roles[0]!=='l1-pool-beneficiary') {
        return reply.code(403).send({ error:'disposal credential must carry only l1-pool-beneficiary' })
      }
      if (!poolBeneficiaryPublisher) return reply.code(503).send({ error:'scoped pool beneficiary publisher is not configured' })
      const body=record(request.body)
      if (body.schemaVersion!==1) throw new Error('schemaVersion must equal 1')
      const chainId=cleanChainId(body.chainId),roomPool=cleanAddress(body.roomPool,'roomPool')
      const expectedSender=cleanAddress(body.expectedBeneficiaryAccount,'expectedBeneficiaryAccount')
      const allocationId=cleanHash(body.allocationId,'allocationId')
      const policy=record(body.confirmationPolicy)
      if (policy.requireFinalized!==true) throw new Error('confirmationPolicy.requireFinalized must equal true')
      const minimumConfirmations=positiveInt(policy.minimumConfirmations,0,4_096)
      const binding=await runtime!.store.l1ServiceBinding(auth.principal.principalId)
      const authority=await runtime!.store.canonicalAllocationAuthority(chainId,auth.principal.tenantId,allocationId)
      if (!binding?.active || binding.bindingKind!=='pool-beneficiary'
        || binding.chainId!==chainId || binding.contractAddress!==roomPool
        || binding.expectedSender!==expectedSender || binding.allocationId!==allocationId
        || expectedSender!==poolBeneficiaryPublisher.signerAddress || roomPool!==config.roomPool || !authority) {
        return reply.code(403).send({ error:'beneficiary principal is not bound to this exact tenant allocation authority' })
      }
      await runtime!.assertCriticalL1Ready()
      const [head,canonicalHead]=await Promise.all([
        runtime!.l1.agreedBlock('latest'),runtime!.store.canonicalHead(chainId),
      ])
      if (!canonicalHead || canonicalHead.number!==head.number || canonicalHead.hash.toLowerCase()!==head.hash.toLowerCase()) {
        return reply.code(503).send({ error:'beneficiary disposal requires an exactly indexed canonical head' })
      }
      const stateFn=allocationStateFunction()
      const call=await runtime!.l1.agreedCall({
        to:roomPool,data:encodeFunctionData({ abi:[stateFn],functionName:'allocationState',args:[allocationId] }),
        blockTag:{ blockHash:head.hash,requireCanonical:true },
      })
      const providers=head.verifiedSources.filter((source) => call.verifiedSources.includes(source))
      if (new Set(providers).size<2) return reply.code(503).send({ error:'allocation state lacks two-provider hash-bound evidence' })
      const allocation=record(decodeFunctionResult({ abi:[stateFn],functionName:'allocationState',data:call.data }))
      const payer=cleanAddress(allocation.payer,'allocation.payer')
      if (cleanAddress(allocation.user,'allocation.user')!==expectedSender
        || cleanDecimal(allocation.roomId,'allocation.roomId')!==authority.roomId
        || cleanDecimal(allocation.status,'allocation.status')!=='2') {
        return reply.code(409).send({ error:'allocation is not currently disposable by the bound beneficiary' })
      }
      const fn=roomPoolFunction('disposeRoom',1)
      const calldata=encodeFunctionData({ abi:[fn],functionName:'disposeRoom',args:[allocationId] })
      const correlationId=requireCorrelationId(request),idempotencyKey=requireIdempotencyKey(request)
      const payload={
        schemaVersion:1,chainId,roomPool,expectedBeneficiaryAccount:expectedSender,allocationId,
        roomId:authority.roomId,payer,allocationFactId:authority.factId,
        allocationFactBlockHash:authority.blockHash,canonicalHeadHash:head.hash,
        receiptSources:[...new Set(providers)].sort(),calldataHash:keccak256(calldata),
        confirmationPolicy:{ minimumConfirmations,requireFinalized:true },
      }
      const result=await mutating(reply,() => poolBeneficiaryPublisher.publish({
        idempotencyKey,correlationId,tenantId:auth.principal!.tenantId,principalId:auth.principal!.principalId,
        to:roomPool,calldata,payload,minimumConfirmations,requireFinalized:true,
      }))
      if (!result.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(),{
        tenantId:auth.principal.tenantId,principalId:auth.principal.principalId,
        action:'pool-beneficiary-disposal.publish',target:allocationId,idempotencyKey,
        details:{ operationId:result.value.operationId,roomId:authority.roomId,payer },
      })
      reply.header('x-correlation-id',correlationId)
      return reply.code(result.value.status==='RESERVED' ? 202 : 200).send(result.value)
    },
  )

  app.get<{ Params: { operationId: string } }>(
    '/hosting/v1/l1-transactions/:operationId',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, 'service', true)
      if (!auth) return reply
      const operationId = cleanResourceId(request.params.operationId, 'operationId')
      const access=await runtime!.store.l1OperationAccess(operationId)
      if (access) {
        const binding=auth.principal
          ? await runtime!.store.l1ServiceBinding(auth.principal.principalId)
          : null
        if (!auth.admin) {
          if (
            !auth.principal || auth.principal.tenantId!==access.tenantId
            || !binding?.active || binding.bindingKind!==access.bindingKind
            || !hasHostedRole(auth.principal,HOSTED_L1_BINDING_ROLE[access.bindingKind])
          ) return reply.code(403).send({ error:'L1 operation belongs to another scoped principal' })
        }
        const managed={
          'node-liveness':nodeHeartbeatPublisher,'room-submit':roomBatchPublisher,
          'room-aggregate':roomAggregatePublisher,'pool-sponsor':poolSponsorPublisher,
          'pool-finality-oracle':poolFinalityPublisher,'pool-beneficiary':poolBeneficiaryPublisher,
        }[access.bindingKind]
        if (!managed) return reply.code(503).send({ error:'scoped managed L1 publisher is not configured' })
        try {
          const operation=await managed.operation(operationId)
          if (!auth.admin && operation) {
            const payload=record(operation.binding)
            const exact=Number(payload.chainId)===binding!.chainId && (
              access.bindingKind==='node-liveness'
                ? String(payload.poolAddress).toLowerCase()===binding!.contractAddress
                  && String(payload.expectedLivenessAccount).toLowerCase()===binding!.expectedSender
                  && String(payload.nodeId).toLowerCase()===binding!.nodeId
                : access.bindingKind==='room-submit'
                  ? String(payload.roomManager).toLowerCase()===binding!.contractAddress
                    && String(payload.expectedOperationsAccount).toLowerCase()===binding!.expectedSender
                    && String(payload.roomId)===binding!.roomId
                  : access.bindingKind==='room-aggregate'
                    ? String(payload.roomManager).toLowerCase()===binding!.contractAddress
                      && String(payload.expectedOperationsAccount).toLowerCase()===binding!.expectedSender
                  : access.bindingKind==='pool-sponsor'
                    ? String(payload.roomPool).toLowerCase()===binding!.contractAddress
                      && String(payload.expectedSponsorAccount).toLowerCase()===binding!.expectedSender
                      && String(payload.sponsorshipId)===binding!.sponsorshipId
                    : access.bindingKind==='pool-finality-oracle'
                      ? String(payload.roomPool).toLowerCase()===binding!.contractAddress
                        && String(payload.expectedFinalityOracleAccount).toLowerCase()===binding!.expectedSender
                        && String(payload.roomId)===binding!.roomId
                      : access.bindingKind==='pool-beneficiary'
                        ? String(payload.roomPool).toLowerCase()===binding!.contractAddress
                          && String(payload.expectedBeneficiaryAccount).toLowerCase()===binding!.expectedSender
                          && String(payload.allocationId).toLowerCase()===binding!.allocationId
                        : false
            )
            if (!exact) return reply.code(403).send({ error:'L1 operation belongs to another scoped principal' })
          }
          if (operation) reply.header('x-correlation-id',operation.correlationId)
          return operation ?? reply.code(404).send({ error:'L1 operation not found' })
        } catch (error) {
          return reply.code(503).send({
            error:error instanceof Error ? error.message : 'canonical L1 evidence is unavailable',
          })
        }
      }
      if (!auth.admin && (!auth.principal || !hasHostedRole(auth.principal,'l1-publish'))) {
        return reply.code(403).send({ error:'role l1-publish required' })
      }
      if (!publisher) return reply.code(503).send({ error: 'fenced EIP-4844 publisher is not configured' })
      const operation = await publisher.operation(operationId)
      return operation ?? reply.code(404).send({ error: 'L1 operation not found' })
    },
  )

  app.post<{ Params: { roomId: string }; Body: { limit?: number; leaseMs?: number } }>(
    '/hosting/v1/admissions/:roomId/lease',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'room-operator', 'node')
      if (!auth) return reply
      const roomId = cleanDecimal(request.params.roomId, 'roomId')
      const entries = await mutating(reply, (hosted) => hosted.store.leaseAdmissions(
        hosted.writableFence(),
        roomId,
        auth.principal!.principalId,
        positiveInt(request.body?.limit, 64, 1_024),
        positiveInt(request.body?.leaseMs, 30_000, 3_600_000),
        auth.principal!.tenantId,
      ))
      if (!entries.ok) return reply
      return { entries: entries.value }
    },
  )

  app.post<{ Body: { limit?: number } }>('/hosting/v1/admin/admissions/recover', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    if (!admission) return reply.code(503).send({ error: 'admission signer is not configured' })
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return reply.code(400).send({ error: 'Idempotency-Key header is required' })
    }
    try {
      const recovered = await admission.recoverHostedReservations(
        positiveInt(request.body?.limit, 1_000, 10_000),
      )
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'admission.recover',
        target: 'reserved-admissions',
        idempotencyKey,
        details: { recovered },
      })
      return { recovered }
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : 'admission recovery failed',
      })
    }
  })

  app.post<{ Params: { roomId: string }; Body: { admissionIds?: string[] } }>(
    '/hosting/v1/admissions/:roomId/ack',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'room-operator', 'node')
      if (!auth) return reply
      const roomId = cleanDecimal(request.params.roomId, 'roomId')
      const admissionIds = strings(request.body?.admissionIds).map((id) => cleanDecimal(id, 'admissionId'))
      const acknowledged = await mutating(reply, (hosted) => hosted.store.ackAdmissions(
        hosted.writableFence(), roomId, auth.principal!.principalId, admissionIds, auth.principal!.tenantId,
      ))
      if (!acknowledged.ok) return reply
      return { acknowledged: acknowledged.value }
    },
  )

  app.post<{ Body: { chainId?: number; roomId?: string } }>('/hosting/v1/admin/reconcile', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
    const result = await mutating(reply, (hosted) => hosted.store.requestRoomReconciliation(
      hosted.writableFence(), cleanChainId(request.body?.chainId),
      cleanDecimal(request.body?.roomId, 'roomId'), auth.principal?.principalId ?? null,
      requireIdempotencyKey(request),
    ))
    if (!result.ok) return reply
    return reply.code(202).send(result.value)
  })

  app.post<{ Params: { eventId: string } }>(
    '/hosting/v1/admin/safety-events/:eventId/resolve',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      const idempotencyKey = requireIdempotencyKey(request)
      const eventId = cleanDecimal(request.params.eventId, 'eventId')
      const resolved = await mutating(reply, (hosted) => hosted.store.resolveSafetyEvent(hosted.writableFence(), eventId))
      if (!resolved.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'safety-event.resolve', target: eventId, idempotencyKey,
        details: { resolved: resolved.value },
      })
      return { resolved: resolved.value }
    },
  )

  app.post<{ Body: {
    transientRetentionDays?: number
    auditRetentionDays?: number
    resolvedSafetyRetentionDays?: number
  } }>(
    '/hosting/v1/admin/reap',
    async (request, reply) => {
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth?.admin) return auth ? reply.code(403).send({ error: 'hosting administrator required' }) : reply
      const idempotencyKey = requireIdempotencyKey(request)
      const reaped = await mutating(reply, (hosted) => hosted.store.reap(hosted.writableFence(), request.body ?? {}))
      if (!reaped.ok) return reply
      await runtime!.store.recordAudit(runtime!.writableFence(), {
        tenantId: auth.principal?.tenantId ?? null,
        principalId: auth.principal?.principalId ?? null,
        action: 'retention.reap', target: 'hosted-retention', idempotencyKey,
        details: reaped.value,
      })
      return reaped.value
    },
  )

  app.get<{ Querystring: { once?: string } }>('/hosting/v1/events', async (request, reply) => {
    const auth = await authenticate(request, reply, undefined, undefined, true)
    if (!auth) return reply
    if (!auth.principal) {
      return reply.code(403).send({ error: 'event streams require a scoped principal credential' })
    }
    const hosted = runtime!
    const tenantId = auth.principal.tenantId
    const header = request.headers['last-event-id']
    let cursor = cleanDecimal(Array.isArray(header) ? header[0] : header ?? '0', 'Last-Event-ID')
    const connectionId = randomUUID()
    const admitted = await hosted.store.acquireSseSlot(
      tenantId,
      connectionId,
      config.coordinatorId,
      auth.principal.limits.sseConnections,
      MAX_GLOBAL_SSE_CONNECTIONS,
      SSE_SLOT_TTL_MS,
    )
    if (!admitted) return reply.code(503).send({ error: 'event stream connection capacity reached' })
    const bounds = await hosted.store.outboxBounds(tenantId, auth.admin)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-schema-version': String(HOSTING_API_SCHEMA),
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
    })
    if (cursor !== '0' && bounds.firstEventId !== null && BigInt(cursor) < BigInt(bounds.firstEventId)) {
      reply.raw.write(`event: refetch\ndata: ${JSON.stringify({
        reason: 'requested event cursor predates retained stream data',
        earliestEventId: bounds.firstEventId,
        latestEventId: bounds.lastEventId,
      })}\n\n`)
      cursor = (BigInt(bounds.firstEventId) - 1n).toString()
    }
    let closed = false
    let pumping = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(poll)
      clearInterval(renew)
      clearInterval(heartbeat)
      void hosted.store.releaseSseSlot(connectionId).catch(() => {})
      if (!reply.raw.writableEnded) reply.raw.end()
    }
    const pump = async () => {
      if (closed || pumping) return
      pumping = true
      try {
        const events = await hosted.store.readOutbox(cursor, tenantId, 200, auth.admin)
        for (const event of events) {
          if (reply.raw.destroyed || reply.raw.writableEnded) return close()
          const accepted = reply.raw.write(
            `id: ${event.eventId}\nevent: ${event.topic}\ndata: ${JSON.stringify({
              schemaVersion: HOSTING_API_SCHEMA,
              aggregateId: event.aggregateId,
              payload: event.payload,
              createdAt: event.createdAt,
            })}\n\n`,
          )
          cursor = event.eventId
          if (reply.raw.writableLength > MAX_SSE_BUFFERED_BYTES) return close()
          if (!accepted) {
            await new Promise<void>((resolve) => {
              const drained = () => resolve()
              reply.raw.once('drain', drained)
              reply.raw.once('close', drained)
            })
            if (closed || reply.raw.destroyed || reply.raw.writableEnded) return close()
          }
        }
        if (request.query.once === '1') close()
      } catch {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write('event: service-error\ndata: {"refetch":true}\n\n')
        }
        close()
      } finally {
        pumping = false
      }
    }
    const poll = setInterval(() => void pump(), SSE_POLL_MS)
    const renew = setInterval(() => {
      void hosted.store.renewSseSlot(connectionId, SSE_SLOT_TTL_MS).then((ok) => {
        if (!ok) close()
      }).catch(close)
    }, 10_000)
    const heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return close()
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      if (reply.raw.writableLength > MAX_SSE_BUFFERED_BYTES) close()
    }, 15_000)
    poll.unref?.()
    renew.unref?.()
    heartbeat.unref?.()
    request.raw.once('close', close)
    await pump()
    return reply
  })

  app.post<{ Body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } }>(
    '/hosting/v1/json-rpc',
    async (request, reply) => {
      const id = request.body?.id ?? null
      const method = request.body?.method
      if (request.body?.jsonrpc !== '2.0' || typeof method !== 'string') {
        return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } })
      }
      if (method === 'hosting_capabilities') {
        return {
          jsonrpc: '2.0', id,
          result: hostingCapabilities(
            config,
            runtime?.status() ?? null,
            { roomBatchAcceptanceOverride: options.roomBatchCapabilityOverride },
          ),
        }
      }
      const auth = await authenticate(request, reply, undefined, undefined, true)
      if (!auth) return reply
      const params = (() => {
        try {
          return record(request.body.params ?? {})
        } catch {
          return null
        }
      })()
      if (!params) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'params must be an object' } }
      }
      const rpcError = (code: number, message: string, data?: unknown) => ({
        jsonrpc: '2.0' as const,
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      })
      const requireRpcRole = (role: HostedRole) => {
        if (auth.admin) return null
        if (auth.principal && hasHostedRole(auth.principal, role)) return null
        return rpcError(-32003, `${role} role required`)
      }
      const tenantScope = auth.admin ? null : auth.principal!.tenantId
      const factQuery = async (factKinds?: string[]) => runtime!.store.listIndexerFacts({
        chainId: config.chainId,
        tenantId: tenantScope,
        factKinds,
        roomId: params.roomId === undefined ? null : cleanDecimal(params.roomId, 'roomId'),
        afterFactId: cleanDecimal(params.after ?? '0', 'after'),
        limit: positiveInt(params.limit, 200, 1_000),
      })
      try {
        if (method === 'hosting_usage' || method === 'zkdeal_getUsage') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          const tenantId = auth.admin
            ? cleanTenantId(params.tenantId)
            : auth.principal!.tenantId
          return { jsonrpc: '2.0', id, result: await runtime!.store.listUsage(
            tenantId,
            cleanDecimal(params.after ?? '0', 'after'),
            positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getBillingLedger') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          const tenantId = auth.admin ? cleanTenantId(params.tenantId) : auth.principal!.tenantId
          return { jsonrpc: '2.0', id, result: await runtime!.store.listBillingLedger(
            tenantId,
            cleanDecimal(params.after ?? '0', 'after'),
            positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getInvoices') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          const tenantId = auth.admin ? cleanTenantId(params.tenantId) : auth.principal!.tenantId
          return { jsonrpc: '2.0', id, result: await runtime!.store.listInvoiceExports(
            tenantId, positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getRefunds') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          const tenantId = auth.admin ? cleanTenantId(params.tenantId) : auth.principal!.tenantId
          return { jsonrpc: '2.0', id, result: await runtime!.store.listBillingRefunds(
            tenantId, positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getIndexerStatus') {
          return { jsonrpc: '2.0', id, result: await runtime!.store.indexerStatus(config.chainId) }
        }
        if (method === 'zkdeal_getCanonicalBlock') {
          const number = cleanDecimal(params.number, 'number')
          const block = await runtime!.store.canonicalBlockAt(config.chainId, number)
          return block
            ? { jsonrpc: '2.0', id, result: block }
            : rpcError(-32004, 'canonical block not found')
        }
        if (method === 'zkdeal_getBlocks' || method === 'zkdeal_getCanonicalBlocks') {
          return { jsonrpc: '2.0', id, result: await runtime!.store.listCanonicalBlocks(
            config.chainId,
            cleanDecimal(params.fromBlock ?? '0', 'fromBlock'),
            positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getRoom') {
          const room = await runtime!.store.roomObservation(
            config.chainId, cleanDecimal(params.roomId, 'roomId'), tenantScope,
          )
          return room ? { jsonrpc: '2.0', id, result: room } : rpcError(-32004, 'room not found')
        }
        if (method === 'zkdeal_getRoomEvents') {
          const kinds = params.kinds === undefined
            ? undefined
            : strings(params.kinds).map((value) => cleanResourceId(value, 'fact kind'))
          return { jsonrpc: '2.0', id, result: await factQuery(kinds) }
        }
        if (method === 'zkdeal_getDeposits') {
          return { jsonrpc: '2.0', id, result: await factQuery(['deposit']) }
        }
        if (method === 'zkdeal_getImports') {
          return { jsonrpc: '2.0', id, result: await factQuery(['import']) }
        }
        if (method === 'zkdeal_getAdmissions') {
          return { jsonrpc: '2.0', id, result: await factQuery(['admission']) }
        }
        if (method === 'zkdeal_getBatches') {
          return { jsonrpc: '2.0', id, result: await factQuery(['batch', 'aggregate', 'data-availability']) }
        }
        if (method === 'zkdeal_getTransaction' || method === 'zkdeal_getTransactions') {
          const transactionHash = cleanHash(params.transactionHash, 'transactionHash')
          const transaction = await runtime!.store.indexedTransaction(
            config.chainId, transactionHash, tenantScope,
          )
          return transaction
            ? { jsonrpc: '2.0', id, result: transaction }
            : rpcError(-32004, 'canonical indexed transaction not found')
        }
        if (method === 'zkdeal_getWithdrawals') {
          const denied = requireRpcRole('withdrawal-read')
          if (denied) return denied
          return { jsonrpc: '2.0', id, result: await runtime!.store.listWithdrawals({
            chainId: config.chainId,
            tenantId: tenantScope,
            roomId: params.roomId === undefined ? null : cleanDecimal(params.roomId, 'roomId'),
            status: params.status === undefined ? null : String(params.status),
            limit: positiveInt(params.limit, 200, 1_000),
          }) }
        }
        if (method === 'zkdeal_getWithdrawalProof' || method === 'zkdeal_getProof') {
          const denied = requireRpcRole('withdrawal-read')
          if (denied) return denied
          const proof = await runtime!.store.withdrawalProof({
            chainId: config.chainId,
            tenantId: tenantScope,
            roomId: cleanDecimal(params.roomId, 'roomId'),
            epoch: cleanDecimal(params.epoch, 'epoch'),
            withdrawalIndex: cleanDecimal(params.withdrawalIndex, 'withdrawalIndex'),
          })
          return proof
            ? { jsonrpc: '2.0', id, result: proof }
            : rpcError(-32004, 'finalized withdrawal proof not found')
        }
        if (method === 'zkdeal_requestWithdrawalClaim') {
          const denied = requireRpcRole('withdrawal-claim')
          if (denied) return denied
          if (auth.admin) return rpcError(-32003, 'claim requests require a tenant-scoped principal')
          const result = await runtime!.store.requestWithdrawalClaim(runtime!.writableFence(), {
            chainId: config.chainId,
            tenantId: auth.principal!.tenantId,
            roomId: cleanDecimal(params.roomId, 'roomId'),
            epoch: cleanDecimal(params.epoch, 'epoch'),
            withdrawalIndex: cleanDecimal(params.withdrawalIndex, 'withdrawalIndex'),
            idempotencyKey: requireIdempotencyKey(request),
          })
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_getFinalityStatus') {
          const [status, head, floor] = await Promise.all([
            runtime!.store.indexerStatus(config.chainId),
            runtime!.store.canonicalHead(config.chainId),
            runtime!.store.canonicalFloor(config.chainId),
          ])
          return { jsonrpc: '2.0', id, result: {
            status, head, floor,
            blobArchiveReady: head
              ? await runtime!.store.blobArchiveReadyThrough(config.chainId, head.number)
              : false,
          } }
        }
        if (method === 'zkdeal_getReconciliationStatus') {
          const status = await runtime!.store.roomReconciliationStatus(
            config.chainId, cleanDecimal(params.roomId, 'roomId'), tenantScope,
          )
          return status
            ? { jsonrpc: '2.0', id, result: status }
            : rpcError(-32004, 'room reconciliation status not found')
        }
        if (method === 'zkdeal_getEntitlements') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          if (auth.admin) return rpcError(-32602, 'admin must use tenant-scoped REST query')
          return { jsonrpc: '2.0', id, result: await runtime!.store.listEntitlements(
            auth.principal!.tenantId, positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getSponsorships') {
          const denied = requireRpcRole('usage-read')
          if (denied) return denied
          if (auth.admin) return rpcError(-32602, 'admin must use tenant-scoped REST query')
          return { jsonrpc: '2.0', id, result: await runtime!.store.listSponsorships(
            auth.principal!.tenantId, positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_getCapacity') {
          const denied = requireRpcRole('capacity-manage')
          if (denied) return denied
          if (auth.admin) return rpcError(-32602, 'admin must use tenant-scoped REST query')
          return { jsonrpc: '2.0', id, result: await runtime!.store.listCapacityIntents(
            auth.principal!.tenantId, positiveInt(params.limit, 200, 1_000),
          ) }
        }
        if (method === 'zkdeal_adminBackfill') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.requestIndexerBackfill(
            runtime!.writableFence(), config.chainId,
            cleanDecimal(params.fromBlock, 'fromBlock'), auth.principal?.principalId ?? null,
            requireIdempotencyKey(request),
          )
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_adminReconcile') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.requestRoomReconciliation(
            runtime!.writableFence(), config.chainId,
            cleanDecimal(params.roomId, 'roomId'), auth.principal?.principalId ?? null,
            requireIdempotencyKey(request),
          )
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_adminRetention') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.reap(runtime!.writableFence(), {
            transientRetentionDays: params.transientRetentionDays === undefined
              ? undefined : positiveInt(params.transientRetentionDays, 30, 365),
            auditRetentionDays: params.auditRetentionDays === undefined
              ? undefined : positiveInt(params.auditRetentionDays, 365, 3_650),
            resolvedSafetyRetentionDays: params.resolvedSafetyRetentionDays === undefined
              ? undefined : positiveInt(params.resolvedSafetyRetentionDays, 30, 3_650),
          })
          await runtime!.store.recordAudit(runtime!.writableFence(), {
            tenantId: auth.principal?.tenantId ?? null,
            principalId: auth.principal?.principalId ?? null,
            action: 'retention.reap', target: 'hosted-retention',
            idempotencyKey: requireIdempotencyKey(request), details: result,
          })
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_adminPublishBillingPrice') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.publishBillingPrice(runtime!.writableFence(), {
            tenantId: cleanTenantId(params.tenantId),
            unit: cleanResourceId(params.unit, 'unit'),
            currency: String(params.currency ?? ''),
            unitPrice: cleanQuantity(params.unitPrice, 'unitPrice', true),
            effectiveFrom: cleanTimestamp(params.effectiveFrom, 'effectiveFrom')!,
            idempotencyKey: requireIdempotencyKey(request),
          })
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_adminPublishSlaPolicy') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const serviceClass = String(params.serviceClass ?? '')
          if (!['standard', 'latency', 'batch'].includes(serviceClass)) {
            return rpcError(-32602, 'serviceClass is invalid')
          }
          const result = await runtime!.store.publishSlaPolicy(runtime!.writableFence(), {
            tenantId: cleanTenantId(params.tenantId),
            serviceClass: serviceClass as 'standard' | 'latency' | 'batch',
            maximumQueueMs: nonnegativeInt(params.maximumQueueMs, 0, Number.MAX_SAFE_INTEGER),
            maximumProofMs: nonnegativeInt(params.maximumProofMs, 0, Number.MAX_SAFE_INTEGER),
            creditBasisPoints: nonnegativeInt(params.creditBasisPoints, 0, 9_999),
            effectiveFrom: cleanTimestamp(params.effectiveFrom, 'effectiveFrom')!,
            idempotencyKey: requireIdempotencyKey(request),
          })
          return { jsonrpc: '2.0', id, result }
        }
        if (method === 'zkdeal_adminFinalizeInvoice') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.createInvoiceExport(runtime!.writableFence(), {
            invoiceId: cleanResourceId(params.invoiceId, 'invoiceId'),
            supersedesInvoiceId: params.supersedesInvoiceId === undefined || params.supersedesInvoiceId === null
              ? null : cleanResourceId(params.supersedesInvoiceId, 'supersedesInvoiceId'),
            tenantId: cleanTenantId(params.tenantId),
            periodStart: cleanTimestamp(params.periodStart, 'periodStart')!,
            periodEnd: cleanTimestamp(params.periodEnd, 'periodEnd')!,
            currency: String(params.currency ?? ''),
            idempotencyKey: requireIdempotencyKey(request),
          })
          return { jsonrpc: '2.0', id, result: result.invoice }
        }
        if (method === 'zkdeal_adminRefund') {
          if (!auth.admin) return rpcError(-32003, 'hosting administrator required')
          const result = await runtime!.store.issueBillingRefund(runtime!.writableFence(), {
            tenantId: cleanTenantId(params.tenantId),
            chargeEntryId: cleanDecimal(params.chargeEntryId, 'chargeEntryId'),
            quantity: cleanQuantity(params.quantity, 'quantity'),
            reason: String(params.reason ?? ''),
            idempotencyKey: requireIdempotencyKey(request),
          })
          return { jsonrpc: '2.0', id, result: result.entry }
        }
        return rpcError(-32601, 'method not found')
      } catch (error) {
        return rpcError(-32602, error instanceof Error ? error.message : 'invalid params')
      }
    },
  )
}
