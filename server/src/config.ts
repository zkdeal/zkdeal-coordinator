import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The web2-api folder this server ships in: server/src → server → web2-api */
export const FOLDER_ROOT = resolve(HERE, '../..')
/**
 * The umbrella checkout holding the sibling component folders. The default
 * layout is the folders side by side (web3-protocol/, prover-node/, …); every
 * cross-folder default below can be overridden per deployment with its env
 * variable, and the container images lay the folders out the same way under
 * /app.
 */
export const UMBRELLA_ROOT = resolve(HERE, '../../..')

/** Chain ids we treat as throwaway local devnets (anvil/hardhat defaults). */
export const DEV_CHAIN_IDS: readonly number[] = [31337, 1337]

export function isDevChain(chainId: number): boolean {
  return DEV_CHAIN_IDS.includes(chainId)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export interface ServerConfig {
  port: number
  /**
   * Interface the HTTP listener (and the libp2p relay) binds to. Defaults to
   * loopback: the coordinator carries dev-only surfaces (faucet, RPC proxy)
   * and must be opted into public exposure explicitly (HOST/BIND).
   */
  bindHost: string
  chainId: number
  l1RpcUrl: string
  /** Independent endpoints used for fail-closed critical-read agreement. */
  l1RpcUrls: readonly string[]
  /** Explicit provider/failure-domain identity corresponding to each URL. */
  l1RpcProviderIds: readonly string[]
  /** Long-lived manager used for admission receipt EIP-712 domains. */
  roomManager: `0x${string}`
  /** Optional managed GPU room-pool access contract. */
  roomPool: `0x${string}`
  /** Fixed-supply token used by the managed room pool. */
  accessToken: `0x${string}`
  /** Optional guided profile for the public managed-room journey. */
  managedRoomProfile?: {
    nodeId: `0x${string}`
    slotId: `0x${string}`
    presetId: `0x${string}`
    participantCapacity: number
    nodeLabel: string
    slotLabel: string
    presetLabel: string
  }
  faucetKey: `0x${string}` | null
  /** Environment-only operator key; never exposed by public config or logs. */
  admissionKey: `0x${string}` | null
  /** Explicit loopback/devnet escape hatch for a process-local admission key. */
  allowDevAdmissionKey: boolean
  /** Production remote EIP-712 signer boundary. */
  admissionSignerUrl: string | null
  admissionSignerAddress: `0x${string}` | null
  admissionSignerAuthToken: string | null
  /** Bounded credential-rotation overlap; tried only after current auth rejects. */
  admissionSignerPreviousAuthToken: string | null
  /** Remote transaction signer used by the fenced EIP-4844 publisher only. */
  l1SignerUrl: string | null
  l1SignerAddress: `0x${string}` | null
  l1SignerAuthToken: string | null
  l1SignerPreviousAuthToken: string | null
  blobPublisherEnabled: boolean
  /** Scoped remote signer used only for allowlisted node heartbeat calls. */
  nodeLivenessSignerUrl?: string | null
  nodeLivenessSignerAddress?: `0x${string}` | null
  nodeLivenessSignerAuthToken?: string | null
  nodeLivenessSignerPreviousAuthToken?: string | null
  nodeLivenessGasLimit?: bigint
  /** Scoped remote signer used only for verified RoomManager batch submission. */
  roomOperationsSignerUrl?: string | null
  roomOperationsSignerAddress?: `0x${string}` | null
  roomOperationsSignerAuthToken?: string | null
  roomOperationsSignerPreviousAuthToken?: string | null
  roomBatchGasLimit?: bigint
  /** Scoped aggregate EIP-4844 signer; never shared with single-room operations. */
  aggregateSignerUrl?: string | null
  aggregateSignerAddress?: `0x${string}` | null
  aggregateSignerAuthToken?: string | null
  aggregateSignerPreviousAuthToken?: string | null
  aggregateGasLimit?: bigint
  /** zkdeal submission ceiling, not the Ethereum network blob-gas limit. */
  aggregateMaxFeePerBlobGas?: bigint
  /** Sponsor authority for permit-bound reserve/renew calls only. */
  poolSponsorSignerUrl?: string | null
  poolSponsorSignerAddress?: `0x${string}` | null
  poolSponsorSignerAuthToken?: string | null
  poolSponsorSignerPreviousAuthToken?: string | null
  poolSponsorGasLimit?: bigint
  /** Finality-oracle authority for recordFinalizedCheckpoint only. */
  poolFinalitySignerUrl?: string | null
  poolFinalitySignerAddress?: `0x${string}` | null
  poolFinalitySignerAuthToken?: string | null
  poolFinalitySignerPreviousAuthToken?: string | null
  poolFinalityGasLimit?: bigint
  /** Allocation beneficiary authority for disposeRoom only. */
  poolBeneficiarySignerUrl?: string | null
  poolBeneficiarySignerAddress?: `0x${string}` | null
  poolBeneficiarySignerAuthToken?: string | null
  poolBeneficiarySignerPreviousAuthToken?: string | null
  poolBeneficiaryGasLimit?: bigint
  /** Permissionless claim sender uses a distinct scoped remote signer role. */
  withdrawalClaimerEnabled: boolean
  withdrawalSignerUrl: string | null
  withdrawalSignerAddress: `0x${string}` | null
  withdrawalSignerAuthToken: string | null
  withdrawalSignerPreviousAuthToken: string | null
  withdrawalClaimGasLimit: bigint
  withdrawalClaimInclusionWindowBlocks: number
  /** Always-on fenced provider/on-chain capacity reconciliation worker. */
  capacityControllerEnabled: boolean
  capacityProviderUrl: string | null
  capacityProviderAuthToken: string | null
  capacityProviderPreviousAuthToken: string | null
  /**
   * Operator credential every admission request must present. Signing an
   * admission receipt commits the room service bond, so the route is never
   * exposed without it: a configured key with no token aborts startup.
   */
  admissionToken: string | null
  /**
   * Indexer credential for the observer write surface (PUT
   * /observer/v1/rooms/:id). The coordinator is the only disk writer; without
   * this token the write routes answer 503 and the archive stays read-only.
   */
  indexerToken: string | null
  /** Server-side floor for the caller-supplied `admissionFee`, in wei. */
  minimumAdmissionFeeWei: bigint
  /** Minimum L1 blocks between the chain head and an accepted deadline. */
  minimumDeadlineLeadBlocks: number
  /** Maximum L1 blocks the observer archive may trail the chain head by. */
  maximumArchiveLagBlocks: number
  faucetEnabled: boolean
  relayPort: number
  relayMaxReservations: number
  relayMaxRooms: number
  relayRoomTtlMs: number
  /** Explicit proxy addresses/CIDRs allowed to supply forwarding headers. */
  trustProxyCidrs: string[]
  /** PostgreSQL is mandatory for active/standby hosted coordinators. */
  databaseUrl: string | null
  /** Pepper used to hash high-entropy hosted API keys before storage. */
  apiKeyPepper: string | null
  /** Bootstrap credential for tenant/key administration in hosted mode. */
  hostingAdminToken: string | null
  /** Explicit loopback/devnet escape hatch; never valid for hosted production. */
  allowDevStaticAdmin: boolean
  /** S3/MinIO endpoint used for immutable requests, results, blobs and sidecars. */
  objectStoreEndpoint: string | null
  objectStoreBucket: string
  objectStoreRegion: string
  objectStoreAccessKeyId: string | null
  objectStoreSecretAccessKey: string | null
  objectStorePrefix: string
  /** Beacon REST endpoints used only when a canonical blob was not prepublished. */
  beaconSidecarUrls: readonly string[]
  webRoot: string
  artifactsRoot: string
  /**
   * The `circuits/` package root. `card-artifacts.lock.json` records every card
   * artifact path relative to it, so the allow-listed card artifact routes
   * resolve against this and never against a caller-supplied prefix.
   */
  circuitsRoot: string
  contractsRoot: string
  contractsOut: string
  scenariosPath: string
  dataDir: string
  addressesPath: string
  /** zkVM artifact tree (zkvm/build) served under /artifacts/zkvm/. */
  zkvmArtifactsRoot: string
  /** zkvm/artifacts.lock.json - source of programDigests for /config. */
  zkvmLockPath: string
  l1BlockTimeSec: number
  dealExecutionWindowSec: number
  challengeWindowBlocks: number
  faucetWei: bigint
  faucetCooldownMs: number
  /** Per-IP faucet burst; per-ADDRESS cooldown is the real abuse control. */
  faucetIpBurst: number
  faucetIpPerSec: number
  /** Hard ceiling on faucet drips per rolling hour across ALL addresses. */
  faucetMaxDripsPerHour: number
  /**
   * Transitional escape hatch: accept UNSIGNED mutating room writes
   * (manifest/genesis/snapshot/bus). Default OFF - every mutation must carry a
   * SignedEnvelope from an L1-registered member. Dev flows opt in with
   * ALLOW_UNSIGNED_WRITES=1 and the server logs loudly on every use.
   */
  allowUnsignedWrites: boolean
  /**
   * Exact CORS origins allowed to call the API. Empty array = same-origin +
   * loopback origins only (the default). '*' is never accepted.
   */
  corsOrigins: string[]
  /** Max buffered bus messages per room (ring). */
  busMaxMessages: number
  /** Max buffered bus bytes per room (ring). */
  busMaxBytesPerRoom: number
  /** Max rooms held in the in-memory bus before LRU eviction. */
  busMaxRooms: number
  /** Max registry entries before least-recently-updated eviction. */
  registryMaxRooms: number
  /** Observable topology identity; never grants authority over room state. */
  coordinatorId: string
  coordinatorRole: 'active' | 'standby' | 'standalone'
  /** Oldest fenced-primary WAL heartbeat accepted by standby promotion. */
  promotionMaximumCheckpointAgeMs: number
  /** Mounts the shared prove queue (`prove-queue/`) when QUEUE_ENABLED=1. */
  queueEnabled: boolean
  /** Submitter credential for `/queue/v1/jobs*`; required when enabled. */
  queueSubmitToken: string | null
  /** Prover-node credential for `/queue/v1/lease` etc.; required when enabled. */
  queueNodeToken: string | null
  /** When set, the demo runtime routes proof requests through this queue. */
  queueUrl: string | null
}

function envFlag(name: string, fallback = false): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
}

function posInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return n
}

/**
 * Fractional rates (tokens per second) still have to fail closed: a bare
 * `Number(env(...))` turned a typo into `NaN`, which RateLimiter accepted and
 * which then disabled the bucket entirely.
 */
function posNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number, got ${JSON.stringify(value)}`)
  }
  return n
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v
}

function managedRoomProfileFromEnv(): ServerConfig['managedRoomProfile'] {
  const nodeId = env('MANAGED_ROOM_NODE_ID')
  const slotId = env('MANAGED_ROOM_SLOT_ID')
  const presetId = env('MANAGED_ROOM_PRESET_ID')
  if (!nodeId && !slotId && !presetId) return undefined
  for (const [label, value] of [
    ['MANAGED_ROOM_NODE_ID', nodeId],
    ['MANAGED_ROOM_SLOT_ID', slotId],
    ['MANAGED_ROOM_PRESET_ID', presetId],
  ] as const) {
    if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error(`${label} must be a 32-byte hexadecimal identifier`)
    }
  }
  return {
    nodeId: nodeId!.toLowerCase() as `0x${string}`,
    slotId: slotId!.toLowerCase() as `0x${string}`,
    presetId: presetId!.toLowerCase() as `0x${string}`,
    participantCapacity: posInt(
      env('MANAGED_ROOM_PARTICIPANT_CAPACITY'),
      128,
      'MANAGED_ROOM_PARTICIPANT_CAPACITY',
    ),
    nodeLabel: env('MANAGED_ROOM_NODE_LABEL', 'RTX 4090 proof node')!,
    slotLabel: env('MANAGED_ROOM_SLOT_LABEL', 'Flexible proof deadline')!,
    presetLabel: env('MANAGED_ROOM_PRESET_LABEL', 'Proof-backed room')!,
  }
}

function coordinatorRole(value: string | undefined): ServerConfig['coordinatorRole'] {
  const role = value?.trim().toLowerCase() || 'standalone'
  if (role !== 'active' && role !== 'standby' && role !== 'standalone') {
    throw new Error(`COORDINATOR_ROLE must be active, standby, or standalone, got ${JSON.stringify(value)}`)
  }
  return role
}

function proxyCidrs(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function abs(p: string, base = UMBRELLA_ROOT): string {
  return isAbsolute(p) ? p : resolve(base, p)
}

function loadAddressFromAddresses(
  path: string,
  candidates: readonly string[],
): `0x${string}` | null {
  if (!existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const nested = j.addresses as Record<string, unknown> | undefined
    const addr = candidates
      .map((key) => j[key] ?? nested?.[key])
      .find((value) => typeof value === 'string')
    if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return addr.toLowerCase() as `0x${string}`
    }
  } catch {
    /* ignore malformed addresses file */
  }
  return null
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = abs(env('DATA_DIR', join(FOLDER_ROOT, 'server', 'data'))!)
  const addressesPath = abs(env('ADDRESSES_PATH', join(dataDir, 'addresses.json'))!)
  const zero = '0x0000000000000000000000000000000000000000'
  const fromFile = loadAddressFromAddresses(addressesPath, ['roomManager', 'RoomManager'])
  const roomManager = env('ROOM_MANAGER', fromFile ?? zero)!.toLowerCase() as `0x${string}`
  const poolFromFile = loadAddressFromAddresses(addressesPath, ['roomPool', 'RoomPoolManager'])
  const roomPool = env('ROOM_POOL', poolFromFile ?? zero)!.toLowerCase() as `0x${string}`
  const tokenFromFile = loadAddressFromAddresses(addressesPath, ['accessToken', 'ZkdealAccessToken'])
  const accessToken =
    env('ACCESS_TOKEN', tokenFromFile ?? zero)!.toLowerCase() as `0x${string}`
  const faucetKeyRaw = env('FAUCET_KEY')
  const faucetKey =
    faucetKeyRaw && /^0x[0-9a-fA-F]{64}$/.test(faucetKeyRaw)
      ? (faucetKeyRaw as `0x${string}`)
      : null
  const admissionKeyRaw = env('ADMISSION_KEY')
  if (admissionKeyRaw && !/^0x[0-9a-fA-F]{64}$/.test(admissionKeyRaw)) {
    throw new Error('ADMISSION_KEY must be a 32-byte hexadecimal private key')
  }
  const admissionKey = (admissionKeyRaw || null) as `0x${string}` | null

  const primaryL1RpcUrl = env('L1_RPC_URL', 'http://127.0.0.1:8545')!
  const configuredL1RpcUrls = (env('L1_RPC_URLS') ?? primaryL1RpcUrl)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const configuredL1ProviderIds = (env('L1_RPC_PROVIDER_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const cfg: ServerConfig = {
    port: posInt(env('PORT'), 3000, 'PORT'),
    bindHost: env('HOST', env('BIND', '127.0.0.1'))!,
    chainId: posInt(env('CHAIN_ID'), 31337, 'CHAIN_ID'),
    l1RpcUrl: primaryL1RpcUrl,
    l1RpcUrls: configuredL1RpcUrls,
    l1RpcProviderIds: configuredL1ProviderIds.length > 0
      ? configuredL1ProviderIds
      : configuredL1RpcUrls.map((url) => new URL(url).hostname.toLowerCase()),
    roomManager,
    roomPool,
    accessToken,
    managedRoomProfile: managedRoomProfileFromEnv(),
    faucetKey,
    admissionKey,
    allowDevAdmissionKey: env('ADMISSION_DEV_PRIVATE_KEY') === '1',
    admissionSignerUrl: env('ADMISSION_SIGNER_URL')?.trim() || null,
    admissionSignerAddress: (env('ADMISSION_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}` | null,
    admissionSignerAuthToken: env('ADMISSION_SIGNER_AUTH_TOKEN')?.trim() || null,
    admissionSignerPreviousAuthToken: env('ADMISSION_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    l1SignerUrl: env('L1_SIGNER_URL')?.trim() || null,
    l1SignerAddress: (env('L1_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}` | null,
    l1SignerAuthToken: env('L1_SIGNER_AUTH_TOKEN')?.trim() || null,
    l1SignerPreviousAuthToken: env('L1_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    blobPublisherEnabled: envFlag('BLOB_PUBLISHER_ENABLED'),
    nodeLivenessSignerUrl: env('NODE_LIVENESS_SIGNER_URL')?.trim() || null,
    nodeLivenessSignerAddress: (env('NODE_LIVENESS_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}` | null,
    nodeLivenessSignerAuthToken: env('NODE_LIVENESS_SIGNER_AUTH_TOKEN')?.trim() || null,
    nodeLivenessSignerPreviousAuthToken: env('NODE_LIVENESS_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    nodeLivenessGasLimit: BigInt(env('NODE_LIVENESS_GAS_LIMIT','150000')!),
    roomOperationsSignerUrl: env('ROOM_OPERATIONS_SIGNER_URL')?.trim() || null,
    roomOperationsSignerAddress: (env('ROOM_OPERATIONS_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}` | null,
    roomOperationsSignerAuthToken: env('ROOM_OPERATIONS_SIGNER_AUTH_TOKEN')?.trim() || null,
    roomOperationsSignerPreviousAuthToken: env('ROOM_OPERATIONS_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    roomBatchGasLimit: BigInt(env('ROOM_BATCH_GAS_LIMIT','5000000')!),
    aggregateSignerUrl:env('AGGREGATE_SIGNER_URL')?.trim() || null,
    aggregateSignerAddress:(env('AGGREGATE_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}`|null,
    aggregateSignerAuthToken:env('AGGREGATE_SIGNER_AUTH_TOKEN')?.trim() || null,
    aggregateSignerPreviousAuthToken:env('AGGREGATE_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    aggregateGasLimit:BigInt(env('AGGREGATE_GAS_LIMIT','12000000')!),
    aggregateMaxFeePerBlobGas:BigInt(env('AGGREGATE_MAX_FEE_PER_BLOB_GAS','3000000000')!),
    poolSponsorSignerUrl:env('POOL_SPONSOR_SIGNER_URL')?.trim() || null,
    poolSponsorSignerAddress:(env('POOL_SPONSOR_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}`|null,
    poolSponsorSignerAuthToken:env('POOL_SPONSOR_SIGNER_AUTH_TOKEN')?.trim() || null,
    poolSponsorSignerPreviousAuthToken:env('POOL_SPONSOR_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    poolSponsorGasLimit:BigInt(env('POOL_SPONSOR_GAS_LIMIT','5000000')!),
    poolFinalitySignerUrl:env('POOL_FINALITY_SIGNER_URL')?.trim() || null,
    poolFinalitySignerAddress:(env('POOL_FINALITY_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}`|null,
    poolFinalitySignerAuthToken:env('POOL_FINALITY_SIGNER_AUTH_TOKEN')?.trim() || null,
    poolFinalitySignerPreviousAuthToken:env('POOL_FINALITY_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    poolFinalityGasLimit:BigInt(env('POOL_FINALITY_GAS_LIMIT','500000')!),
    poolBeneficiarySignerUrl:env('POOL_BENEFICIARY_SIGNER_URL')?.trim() || null,
    poolBeneficiarySignerAddress:(env('POOL_BENEFICIARY_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}`|null,
    poolBeneficiarySignerAuthToken:env('POOL_BENEFICIARY_SIGNER_AUTH_TOKEN')?.trim() || null,
    poolBeneficiarySignerPreviousAuthToken:env('POOL_BENEFICIARY_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    poolBeneficiaryGasLimit:BigInt(env('POOL_BENEFICIARY_GAS_LIMIT','500000')!),
    withdrawalClaimerEnabled: envFlag('WITHDRAWAL_CLAIMER_ENABLED'),
    withdrawalSignerUrl: env('WITHDRAWAL_SIGNER_URL')?.trim() || null,
    withdrawalSignerAddress: (env('WITHDRAWAL_SIGNER_ADDRESS')?.trim().toLowerCase() || null) as `0x${string}` | null,
    withdrawalSignerAuthToken: env('WITHDRAWAL_SIGNER_AUTH_TOKEN')?.trim() || null,
    withdrawalSignerPreviousAuthToken: env('WITHDRAWAL_SIGNER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    withdrawalClaimGasLimit: BigInt(env('WITHDRAWAL_CLAIM_GAS_LIMIT', '500000')!),
    withdrawalClaimInclusionWindowBlocks: posInt(
      env('WITHDRAWAL_CLAIM_INCLUSION_WINDOW_BLOCKS'), 64,
      'WITHDRAWAL_CLAIM_INCLUSION_WINDOW_BLOCKS',
    ),
    capacityControllerEnabled: envFlag('CAPACITY_CONTROLLER_ENABLED'),
    capacityProviderUrl: env('CAPACITY_PROVIDER_URL')?.trim().replace(/\/+$/, '') || null,
    capacityProviderAuthToken: env('CAPACITY_PROVIDER_AUTH_TOKEN')?.trim() || null,
    capacityProviderPreviousAuthToken: env('CAPACITY_PROVIDER_PREVIOUS_AUTH_TOKEN')?.trim() || null,
    admissionToken: env('ADMISSION_TOKEN')?.trim() || null,
    indexerToken: env('INDEXER_TOKEN')?.trim() || null,
    minimumAdmissionFeeWei: BigInt(env('MIN_ADMISSION_FEE_WEI', '0')!),
    minimumDeadlineLeadBlocks: posInt(
      env('MIN_DEADLINE_LEAD_BLOCKS'),
      8,
      'MIN_DEADLINE_LEAD_BLOCKS',
    ),
    maximumArchiveLagBlocks: posInt(
      env('MAX_ARCHIVE_LAG_BLOCKS'),
      8,
      'MAX_ARCHIVE_LAG_BLOCKS',
    ),
    faucetEnabled: Boolean(faucetKey),
    relayPort: posInt(env('RELAY_PORT'), 9001, 'RELAY_PORT'),
    relayMaxReservations: posInt(
      env('RELAY_MAX_RESERVATIONS'),
      64,
      'RELAY_MAX_RESERVATIONS',
    ),
    relayMaxRooms: posInt(env('RELAY_MAX_ROOMS'), 512, 'RELAY_MAX_ROOMS'),
    relayRoomTtlMs: posInt(
      env('RELAY_ROOM_TTL_MS'),
      10 * 60_000,
      'RELAY_ROOM_TTL_MS',
    ),
    trustProxyCidrs: proxyCidrs(env('TRUST_PROXY_CIDRS')),
    databaseUrl: env('DATABASE_URL')?.trim() || null,
    apiKeyPepper: env('API_KEY_PEPPER')?.trim() || null,
    hostingAdminToken: env('HOSTING_ADMIN_TOKEN')?.trim() || null,
    allowDevStaticAdmin: envFlag('HOSTING_DEV_STATIC_ADMIN'),
    objectStoreEndpoint: env('OBJECT_STORE_ENDPOINT')?.trim().replace(/\/+$/, '') || null,
    objectStoreBucket: env('OBJECT_STORE_BUCKET', 'zkdeal')!.trim(),
    objectStoreRegion: env('OBJECT_STORE_REGION', 'us-east-1')!.trim(),
    objectStoreAccessKeyId: env('OBJECT_STORE_ACCESS_KEY_ID')?.trim() || null,
    objectStoreSecretAccessKey: env('OBJECT_STORE_SECRET_ACCESS_KEY')?.trim() || null,
    objectStorePrefix: env('OBJECT_STORE_PREFIX', 'zkdeal')!.trim().replace(/^\/+|\/+$/g, ''),
    beaconSidecarUrls: (env('BEACON_SIDECAR_URLS') ?? '')
      .split(',')
      .map((value) => value.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    webRoot: abs(env('WEB_ROOT', join(FOLDER_ROOT, 'web', 'out'))!),
    artifactsRoot: abs(env('ARTIFACTS_ROOT', join(UMBRELLA_ROOT, 'web3-protocol', 'circuits', 'build'))!),
    circuitsRoot: abs(env('CIRCUITS_ROOT', join(UMBRELLA_ROOT, 'web3-protocol', 'circuits'))!),
    contractsRoot: abs(env('CONTRACTS_ROOT', join(UMBRELLA_ROOT, 'web3-protocol', 'contracts'))!),
    contractsOut: abs(env('CONTRACTS_OUT', join(UMBRELLA_ROOT, 'web3-protocol', 'contracts', 'out'))!),
    scenariosPath: abs(env('SCENARIOS_PATH', join(UMBRELLA_ROOT, 'web3-protocol', 'contracts', 'scenarios.json'))!),
    dataDir,
    addressesPath,
    zkvmArtifactsRoot: abs(env('ZKVM_ARTIFACTS_ROOT', join(UMBRELLA_ROOT, 'prover-node', 'zkvm', 'build'))!),
    zkvmLockPath: abs(env('ZKVM_LOCK_PATH', join(UMBRELLA_ROOT, 'prover-node', 'zkvm', 'artifacts.lock.json'))!),
    l1BlockTimeSec: 12,
    dealExecutionWindowSec: 8,
    challengeWindowBlocks: 2,
    faucetWei: BigInt(env('FAUCET_WEI', '1000000000000000000')!), // 1 ETH
    faucetCooldownMs: posInt(env('FAUCET_COOLDOWN_MS'), 60_000, 'FAUCET_COOLDOWN_MS'),
    faucetIpBurst: posInt(env('FAUCET_IP_BURST'), 60, 'FAUCET_IP_BURST'),
    faucetIpPerSec: posNumber(env('FAUCET_IP_PER_SEC'), 1, 'FAUCET_IP_PER_SEC'),
    faucetMaxDripsPerHour: posInt(env('FAUCET_MAX_DRIPS_PER_HOUR'), 200, 'FAUCET_MAX_DRIPS_PER_HOUR'),
    allowUnsignedWrites: envFlag('ALLOW_UNSIGNED_WRITES'),
    corsOrigins: (env('CORS_ORIGINS', '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    busMaxMessages: posInt(env('BUS_MAX_MESSAGES'), 500, 'BUS_MAX_MESSAGES'),
    busMaxBytesPerRoom: posInt(env('BUS_MAX_BYTES_PER_ROOM'), 4 * 1024 * 1024, 'BUS_MAX_BYTES_PER_ROOM'),
    busMaxRooms: posInt(env('BUS_MAX_ROOMS'), 256, 'BUS_MAX_ROOMS'),
    registryMaxRooms: posInt(env('REGISTRY_MAX_ROOMS'), 4096, 'REGISTRY_MAX_ROOMS'),
    coordinatorId: env('COORDINATOR_ID', 'standalone')!.trim(),
    coordinatorRole: coordinatorRole(env('COORDINATOR_ROLE')),
    promotionMaximumCheckpointAgeMs: posInt(
      env('PROMOTION_MAX_CHECKPOINT_AGE_MS'),
      5 * 60_000,
      'PROMOTION_MAX_CHECKPOINT_AGE_MS',
    ),
    queueEnabled: envFlag('QUEUE_ENABLED'),
    queueSubmitToken: env('ZKDEAL_QUEUE_SUBMIT_TOKEN')?.trim() || null,
    queueNodeToken: env('ZKDEAL_QUEUE_NODE_TOKEN')?.trim() || null,
    queueUrl: env('QUEUE_URL')?.trim().replace(/\/+$/, '') || null,
    ...overrides,
  }
  if (overrides.l1RpcUrl !== undefined && overrides.l1RpcUrls === undefined) {
    cfg.l1RpcUrls = [cfg.l1RpcUrl]
  }
  if ((overrides.l1RpcUrls !== undefined || overrides.l1RpcUrl !== undefined)
    && overrides.l1RpcProviderIds === undefined) {
    cfg.l1RpcProviderIds = cfg.l1RpcUrls.map((url) => new URL(url).hostname.toLowerCase())
  }
  validateConfig(cfg)
  return cfg
}

/**
 * Fail-closed startup validation (review: "configuration is accepted without
 * startup validation"). Throws rather than letting a malformed value surface
 * as an opaque runtime failure much later.
 */
export function validateConfig(cfg: ServerConfig): void {
  const bad = (msg: string): never => {
    throw new Error(`invalid server config: ${msg}`)
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65_535) bad(`port ${cfg.port}`)
  if (!Number.isInteger(cfg.relayPort) || cfg.relayPort < 0 || cfg.relayPort > 65_535) {
    bad(`relayPort ${cfg.relayPort}`)
  }
  if (
    !Number.isSafeInteger(cfg.relayMaxReservations) ||
    cfg.relayMaxReservations <= 0 ||
    cfg.relayMaxReservations > 16_384
  ) {
    bad(`relayMaxReservations ${cfg.relayMaxReservations}`)
  }
  if (
    !Number.isSafeInteger(cfg.relayMaxRooms) ||
    cfg.relayMaxRooms <= 0 ||
    cfg.relayMaxRooms > 16_384
  ) {
    bad(`relayMaxRooms ${cfg.relayMaxRooms}`)
  }
  if (
    !Number.isSafeInteger(cfg.relayRoomTtlMs) ||
    cfg.relayRoomTtlMs < 1_000 ||
    cfg.relayRoomTtlMs > 24 * 60 * 60_000
  ) {
    bad(`relayRoomTtlMs ${cfg.relayRoomTtlMs}`)
  }
  for (const cidr of cfg.trustProxyCidrs) {
    const [address, prefixText, extra] = cidr.split('/')
    const family = isIP(address ?? '')
    const prefix = prefixText === undefined ? null : Number(prefixText)
    const maxPrefix = family === 4 ? 32 : 128
    if (
      extra !== undefined ||
      family === 0 ||
      (prefix !== null && (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix))
    ) {
      bad(`trustProxyCidrs entry ${JSON.stringify(cidr)} is not an IP address or CIDR`)
    }
  }
  if (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0) bad(`chainId ${cfg.chainId}`)
  if (!/^0x[0-9a-f]{40}$/.test(cfg.roomManager)) bad(`roomManager ${cfg.roomManager}`)
  if (!/^0x[0-9a-f]{40}$/.test(cfg.roomPool)) bad(`roomPool ${cfg.roomPool}`)
  if (!/^0x[0-9a-f]{40}$/.test(cfg.accessToken)) bad(`accessToken ${cfg.accessToken}`)
  if (cfg.managedRoomProfile) {
    for (const [label, value] of [
      ['nodeId', cfg.managedRoomProfile.nodeId],
      ['slotId', cfg.managedRoomProfile.slotId],
      ['presetId', cfg.managedRoomProfile.presetId],
    ]) {
      if (!/^0x[0-9a-f]{64}$/.test(value)) bad(`managedRoomProfile.${label} ${value}`)
    }
    if (
      !Number.isSafeInteger(cfg.managedRoomProfile.participantCapacity)
      || cfg.managedRoomProfile.participantCapacity < 128
      || cfg.managedRoomProfile.participantCapacity > 32_768
      || (cfg.managedRoomProfile.participantCapacity
        & (cfg.managedRoomProfile.participantCapacity - 1)) !== 0
    ) {
      bad(`managedRoomProfile.participantCapacity ${cfg.managedRoomProfile.participantCapacity}`)
    }
  }
  if (!/^https?:\/\//i.test(cfg.l1RpcUrl)) bad(`l1RpcUrl ${cfg.l1RpcUrl}`)
  if (cfg.l1RpcUrls.length === 0 || cfg.l1RpcUrls.some((url) => !/^https?:\/\//i.test(url))) {
    bad('l1RpcUrls must contain valid HTTP(S) endpoints')
  }
  if (
    cfg.l1RpcProviderIds.length !== cfg.l1RpcUrls.length
    || cfg.l1RpcProviderIds.some((provider) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(provider))
  ) bad('L1_RPC_PROVIDER_IDS must provide one valid identity per L1 RPC URL')
  // The indexer write surface corroborates reorg fork points on the quorum,
  // so it carries the same two-endpoint requirement as the admission signer.
  if (
    (cfg.admissionKey !== null ||
      cfg.admissionSignerUrl !== null ||
      cfg.indexerToken !== null ||
      cfg.databaseUrl !== null ||
      process.env.DEMO_ENABLED === '1') &&
    (new Set(cfg.l1RpcUrls.map((value) => {
      const url = new URL(value)
      url.protocol = url.protocol.toLowerCase()
      url.hostname = url.hostname.toLowerCase()
      if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = ''
      return url.href
    })).size < 2
      || new Set(cfg.l1RpcProviderIds).size < 2)
  ) {
    bad('critical L1 reads require two independent RPC endpoints and provider identities')
  }
  if (cfg.databaseUrl !== null && !isDevChain(cfg.chainId)
    && cfg.l1RpcUrls.some((url) => new URL(url).protocol !== 'https:')) {
    bad('hosted production L1 RPC endpoints must use HTTPS')
  }
  if (
    cfg.beaconSidecarUrls.some((url) => !/^https?:\/\//i.test(url))
    || new Set(cfg.beaconSidecarUrls).size !== cfg.beaconSidecarUrls.length
  ) bad('BEACON_SIDECAR_URLS must contain distinct HTTP(S) endpoints')
  if (
    cfg.databaseUrl !== null
    && !isDevChain(cfg.chainId)
    && cfg.beaconSidecarUrls.some((url) => new URL(url).protocol !== 'https:')
  ) bad('hosted production beacon sidecar endpoints must use HTTPS')
  if (cfg.faucetWei < 0n) bad(`faucetWei ${cfg.faucetWei}`)
  if (cfg.corsOrigins.includes('*')) bad(`corsOrigins may not contain '*'`)
  for (const o of cfg.corsOrigins) {
    if (!/^https?:\/\/[^/]+$/i.test(o)) bad(`corsOrigins entry ${JSON.stringify(o)} is not an origin`)
  }
  if (typeof cfg.bindHost !== 'string' || cfg.bindHost.trim() === '') bad('bindHost is empty')
  if (!Number.isFinite(cfg.faucetIpPerSec) || cfg.faucetIpPerSec <= 0) {
    bad(`faucetIpPerSec ${cfg.faucetIpPerSec}`)
  }
  if (!Number.isInteger(cfg.faucetIpBurst) || cfg.faucetIpBurst <= 0) {
    bad(`faucetIpBurst ${cfg.faucetIpBurst}`)
  }
  // Fail closed: the admission route signs receipts that are slashable against
  // the room service bond, so a configured signer with no operator credential
  // must abort startup rather than expose an anonymous mutating surface.
  if (cfg.admissionToken !== null && cfg.admissionToken.length < 16) {
    bad('admissionToken must contain at least 16 characters when enabled')
  }
  if (cfg.admissionKey !== null && cfg.admissionToken === null) {
    bad('ADMISSION_TOKEN is required whenever ADMISSION_KEY is configured')
  }
  if (cfg.admissionKey !== null && !cfg.allowDevAdmissionKey) {
    bad('ADMISSION_KEY requires the explicit ADMISSION_DEV_PRIVATE_KEY=1 dev escape hatch')
  }
  if (cfg.allowDevAdmissionKey && (!isDevChain(cfg.chainId) || !isLoopbackHost(cfg.bindHost))) {
    bad('process-local admission keys are permitted only on a loopback dev chain')
  }
  const remoteSignerParts = [
    cfg.admissionSignerUrl,
    cfg.admissionSignerAddress,
    cfg.admissionSignerAuthToken,
  ]
  if (remoteSignerParts.some(Boolean) && !remoteSignerParts.every(Boolean)) {
    bad('ADMISSION_SIGNER_URL, ADMISSION_SIGNER_ADDRESS, and ADMISSION_SIGNER_AUTH_TOKEN are all required together')
  }
  if (cfg.admissionSignerUrl !== null) {
    try {
      if (!['http:', 'https:'].includes(new URL(cfg.admissionSignerUrl).protocol)) throw new Error()
    } catch {
      bad('ADMISSION_SIGNER_URL must be a valid HTTP(S) URL')
    }
  }
  if (cfg.admissionSignerAddress !== null && !/^0x[0-9a-f]{40}$/.test(cfg.admissionSignerAddress)) {
    bad('ADMISSION_SIGNER_ADDRESS must be a 20-byte hexadecimal address')
  }
  if (cfg.admissionSignerAuthToken !== null && cfg.admissionSignerAuthToken.length < 16) {
    bad('ADMISSION_SIGNER_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.admissionSignerPreviousAuthToken !== null && cfg.admissionSignerPreviousAuthToken.length < 16) {
    bad('ADMISSION_SIGNER_PREVIOUS_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.admissionSignerPreviousAuthToken !== null && cfg.admissionSignerAuthToken === null) {
    bad('a previous admission signer token requires the current signer token')
  }
  if (cfg.admissionKey !== null && cfg.admissionSignerUrl !== null) {
    bad('configure either the remote admission signer or the dev private key, never both')
  }
  if (cfg.admissionSignerUrl !== null && cfg.admissionToken === null) {
    bad('ADMISSION_TOKEN is required whenever the remote admission signer is configured')
  }
  const l1SignerParts = [cfg.l1SignerUrl, cfg.l1SignerAddress, cfg.l1SignerAuthToken]
  if (l1SignerParts.some(Boolean) && !l1SignerParts.every(Boolean)) {
    bad('L1_SIGNER_URL, L1_SIGNER_ADDRESS, and L1_SIGNER_AUTH_TOKEN are all required together')
  }
  if (cfg.l1SignerUrl !== null) {
    try {
      if (!['http:', 'https:'].includes(new URL(cfg.l1SignerUrl).protocol)) throw new Error()
    } catch {
      bad('L1_SIGNER_URL must be a valid HTTP(S) URL')
    }
  }
  if (cfg.l1SignerAddress !== null && !/^0x[0-9a-f]{40}$/.test(cfg.l1SignerAddress)) {
    bad('L1_SIGNER_ADDRESS must be a 20-byte hexadecimal address')
  }
  if (cfg.l1SignerAuthToken !== null && cfg.l1SignerAuthToken.length < 16) {
    bad('L1_SIGNER_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.l1SignerPreviousAuthToken !== null && cfg.l1SignerPreviousAuthToken.length < 16) {
    bad('L1_SIGNER_PREVIOUS_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.l1SignerPreviousAuthToken !== null && cfg.l1SignerAuthToken === null) {
    bad('a previous L1 signer token requires the current signer token')
  }
  if (cfg.blobPublisherEnabled && !l1SignerParts.every(Boolean)) {
    bad('BLOB_PUBLISHER_ENABLED requires the remote L1 transaction signer')
  }
  if (cfg.blobPublisherEnabled && cfg.databaseUrl === null) {
    bad('BLOB_PUBLISHER_ENABLED requires PostgreSQL hosted mode')
  }
  if (cfg.blobPublisherEnabled && !cfg.objectStoreEndpoint) {
    bad('BLOB_PUBLISHER_ENABLED requires the immutable object store')
  }
  if (cfg.blobPublisherEnabled && !isDevChain(cfg.chainId) && new URL(cfg.l1SignerUrl!).protocol !== 'https:') {
    bad('hosted production L1 signer must use HTTPS')
  }
  const validateManagedSigner = (
    prefix: string,
    url: string | null | undefined,
    signerAddress: string | null | undefined,
    token: string | null | undefined,
    previousToken: string | null | undefined,
    gasLimit: bigint | undefined,
  ) => {
    const parts=[url,signerAddress,token]
    if (parts.some(Boolean) && !parts.every(Boolean)) {
      bad(`${prefix}_SIGNER_URL, ${prefix}_SIGNER_ADDRESS, and ${prefix}_SIGNER_AUTH_TOKEN are all required together`)
    }
    if (!parts.some(Boolean)) return
    try {
      if (!['http:','https:'].includes(new URL(url!).protocol)) throw new Error()
    } catch { bad(`${prefix}_SIGNER_URL must be a valid HTTP(S) URL`) }
    if (!/^0x[0-9a-f]{40}$/.test(signerAddress!)) bad(`${prefix}_SIGNER_ADDRESS must be a 20-byte hexadecimal address`)
    if (token!.length<16) bad(`${prefix}_SIGNER_AUTH_TOKEN must contain at least 16 characters`)
    if (previousToken && previousToken.length<16) bad(`${prefix}_SIGNER_PREVIOUS_AUTH_TOKEN must contain at least 16 characters`)
    if (cfg.databaseUrl===null || !cfg.objectStoreEndpoint) {
      bad(`${prefix}_SIGNER configuration requires PostgreSQL and immutable object storage`)
    }
    if (!isDevChain(cfg.chainId) && new URL(url!).protocol!=='https:') {
      bad(`hosted production ${prefix.toLowerCase()} signer must use HTTPS`)
    }
    if (gasLimit===undefined || gasLimit<21_000n || gasLimit>30_000_000n) {
      bad(`${prefix}_GAS_LIMIT is outside the safe range`)
    }
  }
  validateManagedSigner(
    'NODE_LIVENESS',cfg.nodeLivenessSignerUrl,cfg.nodeLivenessSignerAddress,
    cfg.nodeLivenessSignerAuthToken,cfg.nodeLivenessSignerPreviousAuthToken,cfg.nodeLivenessGasLimit,
  )
  validateManagedSigner(
    'ROOM_OPERATIONS',cfg.roomOperationsSignerUrl,cfg.roomOperationsSignerAddress,
    cfg.roomOperationsSignerAuthToken,cfg.roomOperationsSignerPreviousAuthToken,cfg.roomBatchGasLimit,
  )
  validateManagedSigner(
    'AGGREGATE',cfg.aggregateSignerUrl,cfg.aggregateSignerAddress,
    cfg.aggregateSignerAuthToken,cfg.aggregateSignerPreviousAuthToken,cfg.aggregateGasLimit,
  )
  if (cfg.aggregateMaxFeePerBlobGas===undefined || cfg.aggregateMaxFeePerBlobGas<=0n
    || cfg.aggregateMaxFeePerBlobGas>1_000_000_000_000_000_000n) {
    bad('AGGREGATE_MAX_FEE_PER_BLOB_GAS must be a positive value no greater than 1 ether')
  }
  validateManagedSigner(
    'POOL_SPONSOR',cfg.poolSponsorSignerUrl,cfg.poolSponsorSignerAddress,
    cfg.poolSponsorSignerAuthToken,cfg.poolSponsorSignerPreviousAuthToken,cfg.poolSponsorGasLimit,
  )
  validateManagedSigner(
    'POOL_FINALITY',cfg.poolFinalitySignerUrl,cfg.poolFinalitySignerAddress,
    cfg.poolFinalitySignerAuthToken,cfg.poolFinalitySignerPreviousAuthToken,cfg.poolFinalityGasLimit,
  )
  validateManagedSigner(
    'POOL_BENEFICIARY',cfg.poolBeneficiarySignerUrl,cfg.poolBeneficiarySignerAddress,
    cfg.poolBeneficiarySignerAuthToken,cfg.poolBeneficiarySignerPreviousAuthToken,cfg.poolBeneficiaryGasLimit,
  )
  const scopedSignerAddresses=[
    cfg.l1SignerAddress,cfg.withdrawalSignerAddress,
    cfg.nodeLivenessSignerAddress,cfg.roomOperationsSignerAddress,
    cfg.aggregateSignerAddress,cfg.poolSponsorSignerAddress,cfg.poolFinalitySignerAddress,
    cfg.poolBeneficiarySignerAddress,
  ].filter((value): value is `0x${string}` => Boolean(value))
  if (new Set(scopedSignerAddresses).size!==scopedSignerAddresses.length) {
    bad('every hosted L1 authority requires a distinct scoped signer account')
  }
  const withdrawalSignerParts = [
    cfg.withdrawalSignerUrl,
    cfg.withdrawalSignerAddress,
    cfg.withdrawalSignerAuthToken,
  ]
  if (withdrawalSignerParts.some(Boolean) && !withdrawalSignerParts.every(Boolean)) {
    bad('WITHDRAWAL_SIGNER_URL, WITHDRAWAL_SIGNER_ADDRESS, and WITHDRAWAL_SIGNER_AUTH_TOKEN are all required together')
  }
  if (cfg.withdrawalSignerUrl !== null) {
    try {
      if (!['http:', 'https:'].includes(new URL(cfg.withdrawalSignerUrl).protocol)) throw new Error()
    } catch {
      bad('WITHDRAWAL_SIGNER_URL must be a valid HTTP(S) URL')
    }
  }
  if (cfg.withdrawalSignerAddress !== null && !/^0x[0-9a-f]{40}$/.test(cfg.withdrawalSignerAddress)) {
    bad('WITHDRAWAL_SIGNER_ADDRESS must be a 20-byte hexadecimal address')
  }
  if (cfg.withdrawalSignerAuthToken !== null && cfg.withdrawalSignerAuthToken.length < 16) {
    bad('WITHDRAWAL_SIGNER_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.withdrawalSignerPreviousAuthToken !== null && cfg.withdrawalSignerPreviousAuthToken.length < 16) {
    bad('WITHDRAWAL_SIGNER_PREVIOUS_AUTH_TOKEN must contain at least 16 characters')
  }
  if (cfg.withdrawalSignerPreviousAuthToken !== null && cfg.withdrawalSignerAuthToken === null) {
    bad('a previous withdrawal signer token requires the current signer token')
  }
  if (cfg.withdrawalClaimerEnabled && !withdrawalSignerParts.every(Boolean)) {
    bad('WITHDRAWAL_CLAIMER_ENABLED requires the scoped withdrawal signer')
  }
  if (cfg.withdrawalClaimerEnabled && cfg.databaseUrl === null) {
    bad('WITHDRAWAL_CLAIMER_ENABLED requires PostgreSQL hosted mode')
  }
  if (cfg.withdrawalClaimerEnabled && !cfg.objectStoreEndpoint) {
    bad('WITHDRAWAL_CLAIMER_ENABLED requires the immutable object store')
  }
  if (
    cfg.withdrawalClaimerEnabled && cfg.blobPublisherEnabled
    && cfg.withdrawalSignerAddress === cfg.l1SignerAddress
  ) bad('withdrawal and blob publisher workers require distinct scoped signer accounts')
  if (
    cfg.withdrawalClaimerEnabled && !isDevChain(cfg.chainId)
    && new URL(cfg.withdrawalSignerUrl!).protocol !== 'https:'
  ) bad('hosted production withdrawal signer must use HTTPS')
  const capacityProviderParts = [cfg.capacityProviderUrl, cfg.capacityProviderAuthToken]
  if (capacityProviderParts.some(Boolean) && !capacityProviderParts.every(Boolean)) {
    bad('CAPACITY_PROVIDER_URL and CAPACITY_PROVIDER_AUTH_TOKEN are required together')
  }
  if (cfg.capacityProviderUrl !== null) {
    try {
      if (!['http:', 'https:'].includes(new URL(cfg.capacityProviderUrl).protocol)) throw new Error()
    } catch {
      bad('CAPACITY_PROVIDER_URL must be a valid HTTP(S) URL')
    }
  }
  if (cfg.capacityProviderAuthToken !== null && cfg.capacityProviderAuthToken.length < 16) {
    bad('CAPACITY_PROVIDER_AUTH_TOKEN must contain at least 16 characters')
  }
  if (
    cfg.capacityProviderPreviousAuthToken !== null
    && cfg.capacityProviderPreviousAuthToken.length < 16
  ) bad('CAPACITY_PROVIDER_PREVIOUS_AUTH_TOKEN must contain at least 16 characters')
  if (cfg.capacityProviderPreviousAuthToken !== null && cfg.capacityProviderAuthToken === null) {
    bad('a previous capacity provider token requires the current provider token')
  }
  if (cfg.capacityControllerEnabled && !capacityProviderParts.every(Boolean)) {
    bad('CAPACITY_CONTROLLER_ENABLED requires the scoped capacity provider')
  }
  if (cfg.capacityControllerEnabled && cfg.databaseUrl === null) {
    bad('CAPACITY_CONTROLLER_ENABLED requires PostgreSQL hosted mode')
  }
  if (
    cfg.capacityControllerEnabled && !isDevChain(cfg.chainId)
    && new URL(cfg.capacityProviderUrl!).protocol !== 'https:'
  ) bad('hosted production capacity provider must use HTTPS')
  if (cfg.withdrawalClaimGasLimit < 100_000n || cfg.withdrawalClaimGasLimit > 5_000_000n) {
    bad('WITHDRAWAL_CLAIM_GAS_LIMIT must be between 100000 and 5000000')
  }
  if (
    cfg.withdrawalClaimInclusionWindowBlocks < 8
    || cfg.withdrawalClaimInclusionWindowBlocks > 1_024
  ) bad('WITHDRAWAL_CLAIM_INCLUSION_WINDOW_BLOCKS must be between 8 and 1024')
  if (cfg.databaseUrl !== null && !isDevChain(cfg.chainId)) {
    if (!cfg.admissionSignerUrl || !cfg.admissionSignerAddress || !cfg.admissionSignerAuthToken) {
      bad('hosted production requires the remote admission signer boundary')
    }
    if (new URL(cfg.admissionSignerUrl!).protocol !== 'https:') {
      bad('hosted production admission signer must use HTTPS')
    }
    if (cfg.admissionKey !== null) bad('hosted production cannot use ADMISSION_KEY')
  }
  // The indexer credential authorizes rewriting the whole observation archive,
  // so a short guessable value must abort startup like the other tokens.
  if (cfg.indexerToken !== null && cfg.indexerToken.length < 16) {
    bad('indexerToken must contain at least 16 characters when set')
  }
  if (cfg.minimumAdmissionFeeWei < 0n) {
    bad(`minimumAdmissionFeeWei ${cfg.minimumAdmissionFeeWei}`)
  }
  // Same fail-closed rule as the admission surface: an enabled queue with a
  // missing or trivial credential must abort startup, never listen openly.
  for (const [label, token] of [
    ['queueSubmitToken', cfg.queueSubmitToken],
    ['queueNodeToken', cfg.queueNodeToken],
  ] as const) {
    if (token !== null && token.length < 16) {
      bad(`${label} must contain at least 16 characters when set`)
    }
    if (cfg.queueEnabled && cfg.databaseUrl === null && token === null) {
      bad(`${label} is required for a standalone QUEUE_ENABLED=1 service`)
    }
  }
  if (cfg.queueUrl !== null && !/^https?:\/\//i.test(cfg.queueUrl)) {
    bad(`queueUrl ${cfg.queueUrl}`)
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(cfg.coordinatorId)) {
    bad(`coordinatorId ${JSON.stringify(cfg.coordinatorId)}`)
  }
  if (!['active', 'standby', 'standalone'].includes(cfg.coordinatorRole)) {
    bad(`coordinatorRole ${JSON.stringify(cfg.coordinatorRole)}`)
  }
  if (
    !Number.isSafeInteger(cfg.promotionMaximumCheckpointAgeMs)
    || cfg.promotionMaximumCheckpointAgeMs < 5_000
    || cfg.promotionMaximumCheckpointAgeMs > 5 * 60_000
  ) bad('promotionMaximumCheckpointAgeMs must be from 5000 through 300000')
  if (cfg.coordinatorRole !== 'standalone' && cfg.databaseUrl === null) {
    bad('DATABASE_URL is required for active/standby coordinators')
  }
  if (cfg.databaseUrl !== null && !/^postgres(?:ql)?:\/\//i.test(cfg.databaseUrl)) {
    bad('databaseUrl must be a PostgreSQL URL')
  }
  if (cfg.databaseUrl !== null && (cfg.apiKeyPepper?.length ?? 0) < 32) {
    bad('API_KEY_PEPPER with at least 32 characters is required with DATABASE_URL')
  }
  if (cfg.databaseUrl !== null && envFlag('DEMO_ENABLED')) {
    bad('DEMO_ENABLED cannot run inside PostgreSQL hosted mode; use the explicit standalone demo')
  }
  if (cfg.hostingAdminToken !== null && cfg.hostingAdminToken.length < 32) {
    bad('HOSTING_ADMIN_TOKEN must contain at least 32 characters when configured')
  }
  if (cfg.allowDevStaticAdmin && (!isDevChain(cfg.chainId) || !isLoopbackHost(cfg.bindHost))) {
    bad('HOSTING_DEV_STATIC_ADMIN is allowed only on loopback throwaway devnets')
  }
  if (cfg.hostingAdminToken !== null && !cfg.allowDevStaticAdmin) {
    bad('static HOSTING_ADMIN_TOKEN requires explicit HOSTING_DEV_STATIC_ADMIN=1; production uses scoped principals')
  }
  if (cfg.databaseUrl !== null) {
    if (!cfg.objectStoreEndpoint || !/^https?:\/\//i.test(cfg.objectStoreEndpoint)) {
      bad('OBJECT_STORE_ENDPOINT is required and must be HTTP(S) in hosted mode')
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/.test(cfg.objectStoreBucket)) {
      bad('objectStoreBucket is not a valid S3 bucket name')
    }
    if (!cfg.objectStoreRegion || !cfg.objectStoreAccessKeyId || (cfg.objectStoreSecretAccessKey?.length ?? 0) < 8) {
      bad('hosted mode requires object-store region and credentials')
    }
    if (!cfg.objectStorePrefix || cfg.objectStorePrefix.includes('..')) {
      bad('objectStorePrefix is invalid')
    }
  }
}

/**
 * Public-exposure guard (review blocker #7). Dev-only surfaces - faucet,
 * unsigned room writes, explicit-origin-less CORS - may only be reachable off
 * loopback on a known throwaway devnet. Returns a human-readable reason when
 * the combination must abort startup, otherwise null.
 */
export function exposureViolation(cfg: ServerConfig): string | null {
  if (isLoopbackHost(cfg.bindHost)) return null
  if (isDevChain(cfg.chainId)) return null
  const dev: string[] = []
  if (cfg.faucetEnabled) dev.push('faucet (FAUCET_KEY)')
  if (cfg.allowUnsignedWrites) dev.push('unsigned room writes (ALLOW_UNSIGNED_WRITES)')
  if (cfg.corsOrigins.length === 0) dev.push('permissive default CORS (CORS_ORIGINS unset)')
  if (dev.length === 0) return null
  return (
    `refusing to bind ${cfg.bindHost} on chain ${cfg.chainId} with dev-only features enabled: ` +
    `${dev.join(', ')}. Bind 127.0.0.1, disable these, or run on a dev chain (${DEV_CHAIN_IDS.join('/')}).`
  )
}
