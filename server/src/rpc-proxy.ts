/**
 * Strict JSON-RPC proxy (review: "unrestricted cross-origin JSON-RPC proxy
 * exposes the upstream node").
 *
 * The coordinator sits in front of the execution node and is reachable by
 * every browser tab that loaded the app, so forwarding arbitrary JSON gave
 * anyone the upstream's `debug_*`/`admin_*`/`personal_*`/`anvil_*` surface and
 * unmetered expensive calls. Only the methods the zkdeal clients actually
 * need are forwarded; anvil/evm cheats are additionally gated on a dev chain.
 */

import { isDevChain } from './config.js'

/** Methods every deployment needs (read paths + raw tx submission). */
export const RPC_ALLOWLIST: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getBalance',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getBlockByNumber',
  'eth_feeHistory',
])

/**
 * Devnet cheat namespaces. `anvil_*` mining/impersonation/balance calls are
 * state-mutating admin operations - allowed ONLY when the configured chain id
 * is a known throwaway devnet.
 */
const DEV_PREFIXES = ['anvil_', 'evm_'] as const

/** Max requests in one JSON-RPC batch. */
export const RPC_MAX_BATCH = 8
/** Max params array length for a single request. */
export const RPC_MAX_PARAMS = 16
/** Max serialized bytes forwarded upstream. */
export const RPC_MAX_BODY_BYTES = 128 * 1024
/** Max upstream response bytes returned to the caller. */
export const RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Upstream deadline. */
export const RPC_TIMEOUT_MS = 15_000
/**
 * Max span of every `eth_getLogs` filter. Tag-valued and omitted endpoints
 * must be resolved by the HTTP route before this screen approves the call.
 */
export const RPC_MAX_LOG_BLOCK_SPAN = 100_000n

function blockNumber(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) return null
  return BigInt(value)
}

export interface RpcScreenContext {
  /** Canonical head resolved by the proxy immediately before forwarding. */
  latestBlock?: bigint
}

function resolvedBlock(
  value: unknown,
  latestBlock: bigint | undefined,
): { value: bigint | null; unresolved: boolean; malformed: boolean } {
  const numeric = blockNumber(value)
  if (numeric !== null) return { value: numeric, unresolved: false, malformed: false }
  if (value === 'earliest') return { value: 0n, unresolved: false, malformed: false }
  if (
    value === undefined ||
    value === 'latest' ||
    value === 'safe' ||
    value === 'finalized' ||
    value === 'pending'
  ) {
    return latestBlock === undefined
      ? { value: null, unresolved: true, malformed: false }
      : {
          // Using the latest head for safe/finalized is conservative: it can
          // only make a wide query get rejected, never let one exceed the cap.
          value: value === 'pending' ? latestBlock + 1n : latestBlock,
          unresolved: false,
          malformed: false,
        }
  }
  return { value: null, unresolved: false, malformed: true }
}

/**
 * `eth_getLogs` is the one allowlisted method whose cost is unbounded by its
 * own shape: the allowlist checked the name, the params count and nothing else.
 */
function screenGetLogs(params: unknown, context: RpcScreenContext): RpcScreenResult | null {
  if (!Array.isArray(params) || params.length !== 1) {
    return { ok: false, status: 400, error: 'eth_getLogs takes exactly one filter object' }
  }
  const filter = params[0]
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return { ok: false, status: 400, error: 'malformed eth_getLogs filter' }
  }
  const f = filter as Record<string, unknown>
  if (Array.isArray(f.address) && f.address.length > RPC_MAX_PARAMS) {
    return { ok: false, status: 413, error: 'too many eth_getLogs addresses' }
  }
  if (Array.isArray(f.topics) && f.topics.length > 4) {
    return { ok: false, status: 400, error: 'eth_getLogs accepts at most four topic positions' }
  }
  if (f.blockHash !== undefined) {
    if (
      typeof f.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(f.blockHash) ||
      f.fromBlock !== undefined ||
      f.toBlock !== undefined
    ) {
      return { ok: false, status: 400, error: 'malformed eth_getLogs blockHash filter' }
    }
    return null
  }
  const from = resolvedBlock(f.fromBlock, context.latestBlock)
  const to = resolvedBlock(f.toBlock, context.latestBlock)
  if (from.malformed || to.malformed) {
    return { ok: false, status: 400, error: 'malformed eth_getLogs block range' }
  }
  if (from.unresolved || to.unresolved) {
    return {
      ok: false,
      status: 503,
      error: 'eth_getLogs range requires a resolved canonical chain head',
    }
  }
  if (from.value! > to.value!) {
    return { ok: false, status: 400, error: 'eth_getLogs fromBlock is after toBlock' }
  }
  if (to.value! - from.value! > RPC_MAX_LOG_BLOCK_SPAN) {
    return {
      ok: false,
      status: 413,
      error: `eth_getLogs range exceeds ${RPC_MAX_LOG_BLOCK_SPAN} blocks`,
    }
  }
  return null
}

export function isRpcMethodAllowed(method: string, chainId: number): boolean {
  if (RPC_ALLOWLIST.has(method)) return true
  if (isDevChain(chainId) && DEV_PREFIXES.some((p) => method.startsWith(p))) return true
  return false
}

export type RpcScreenResult =
  | { ok: true; methods: string[] }
  | { ok: false; status: number; error: string }

/**
 * Validate a JSON-RPC request body before anything is forwarded. Fail-closed:
 * anything that is not a well-formed, allowlisted, bounded request is rejected
 * here and never reaches the upstream node.
 */
export function screenRpcBody(
  body: unknown,
  chainId: number,
  context: RpcScreenContext = {},
): RpcScreenResult {
  const items = Array.isArray(body) ? body : [body]
  if (items.length === 0) return { ok: false, status: 400, error: 'empty JSON-RPC request' }
  if (items.length > RPC_MAX_BATCH) {
    return { ok: false, status: 413, error: `batch too large (max ${RPC_MAX_BATCH})` }
  }
  const methods: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, status: 400, error: 'malformed JSON-RPC request' }
    }
    const r = item as Record<string, unknown>
    if (typeof r.method !== 'string' || r.method.length === 0 || r.method.length > 64) {
      return { ok: false, status: 400, error: 'malformed JSON-RPC method' }
    }
    if (r.params !== undefined && !Array.isArray(r.params) && typeof r.params !== 'object') {
      return { ok: false, status: 400, error: 'malformed JSON-RPC params' }
    }
    if (Array.isArray(r.params) && r.params.length > RPC_MAX_PARAMS) {
      return { ok: false, status: 413, error: 'too many JSON-RPC params' }
    }
    if (!isRpcMethodAllowed(r.method, chainId)) {
      return { ok: false, status: 403, error: `method not allowed: ${r.method}` }
    }
    if (r.method === 'eth_getLogs') {
      const rejected = screenGetLogs(r.params, context)
      if (rejected) return rejected
    }
    methods.push(r.method)
  }
  return { ok: true, methods }
}
