import { createHash } from 'node:crypto'
import { keccak256 } from 'viem'

export interface L1EndpointConfig {
  url: string
  /** Operator-declared independent provider/failure-domain identity. */
  providerId: string
}

export interface AgreedL1Block {
  chainId: number
  number: string
  hash: `0x${string}`
  parentHash: `0x${string}`
  parentBeaconBlockRoot: `0x${string}` | null
  timestamp: string
  verifiedSources: string[]
}

export interface AgreedL1Logs {
  logs: Array<Record<string, unknown>>
  verifiedSources: string[]
}

export interface AgreedL1Transaction {
  transaction: Record<string, unknown>
  verifiedSources: string[]
}

export interface AgreedL1OptionalTransaction {
  transaction: Record<string, unknown> | null
  verifiedSources: string[]
}

export interface AgreedL1Call {
  data: `0x${string}`
  verifiedSources: string[]
}

export type L1CallBlock = {
  blockHash: `0x${string}`
  requireCanonical: true
}

export interface L1TransportHealth {
  source: string
  healthy: boolean
  lastSuccessAt: string | null
  lastError: string | null
  latencyMs: number | null
}

export interface AgreedEip1559Fees {
  baseFeePerGas: string
  maxPriorityFeePerGas: string
  maxFeePerGas: string
  blockNumber: string
  blockHash: `0x${string}`
  verifiedSources: string[]
}

interface JsonRpcResponse<T> {
  result?: T
  error?: { code: number; message: string }
}

interface Endpoint {
  url: string
  providerId: string
  source: string
}

export function normalizedL1Endpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('L1 RPC endpoint must be HTTP(S)')
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = ''
  }
  // URL paths, queries, and userinfo may be case-sensitive. Do not lowercase
  // or otherwise conflate provider credentials/routing paths.
  if (url.pathname === '/' && !url.search && !url.hash) url.pathname = ''
  return url.href.replace(/\/$/, '')
}

function sourceId(endpoint: Pick<Endpoint, 'url' | 'providerId'>): string {
  return `rpc-${createHash('sha256')
    .update(`${endpoint.providerId}\0${normalizedL1Endpoint(endpoint.url)}`)
    .digest('hex')
    .slice(0, 16)}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hexNumber(value: unknown, field: string): string {
  const text = String(value ?? '').toLowerCase()
  if (!/^0x[0-9a-f]+$/.test(text)) throw new Error(`RPC ${field} is not hexadecimal`)
  return `0x${BigInt(text).toString(16)}`
}

function hexData(value: unknown, bytes: number | null, field: string): string {
  const text = String(value ?? '').toLowerCase()
  const expression = bytes === null ? /^0x(?:[0-9a-f]{2})*$/ : new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`)
  if (!expression.test(text)) throw new Error(`RPC ${field} is malformed`)
  return text
}

function normalizedLog(log: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(log.topics)) throw new Error('RPC log topics are malformed')
  return {
    address: hexData(log.address, 20, 'log address'),
    topics: log.topics.map((topic) => hexData(topic, 32, 'log topic')),
    data: hexData(log.data, null, 'log data'),
    blockNumber: hexNumber(log.blockNumber, 'log blockNumber'),
    blockHash: hexData(log.blockHash, 32, 'log blockHash'),
    transactionHash: hexData(log.transactionHash, 32, 'log transactionHash'),
    transactionIndex: hexNumber(log.transactionIndex, 'log transactionIndex'),
    logIndex: hexNumber(log.logIndex, 'logIndex'),
    removed: log.removed === true,
  }
}

function normalizedTransaction(value: Record<string, unknown>): Record<string, unknown> {
  return {
    hash: hexData(value.hash, 32, 'transaction hash'),
    from: hexData(value.from, 20, 'transaction from'),
    to: value.to === null ? null : hexData(value.to, 20, 'transaction to'),
    nonce: hexNumber(value.nonce, 'transaction nonce'),
    input: hexData(value.input ?? value.data, null, 'transaction input'),
    value: hexNumber(value.value, 'transaction value'),
    type: value.type === undefined ? null : hexNumber(value.type, 'transaction type'),
    chainId: value.chainId === undefined ? null : hexNumber(value.chainId, 'transaction chainId'),
    blockHash: value.blockHash === null ? null : hexData(value.blockHash, 32, 'transaction blockHash'),
    blockNumber: value.blockNumber === null ? null : hexNumber(value.blockNumber, 'transaction blockNumber'),
    transactionIndex: value.transactionIndex === null
      ? null
      : hexNumber(value.transactionIndex, 'transaction index'),
    blobVersionedHashes: value.blobVersionedHashes === undefined
      ? null
      : Array.isArray(value.blobVersionedHashes)
        ? value.blobVersionedHashes.map((hash) => hexData(hash, 32, 'blob versioned hash'))
        : (() => { throw new Error('transaction blobVersionedHashes is malformed') })(),
  }
}

/** Shared fail-closed, health-ranked L1 read/write transport. */
export class SharedL1Transport {
  private readonly endpoints: Endpoint[]
  private readonly health = new Map<string, L1TransportHealth>()

  constructor(
    endpoints: readonly (string | L1EndpointConfig)[],
    private readonly expectedChainId: number,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
    providerIds?: readonly string[],
  ) {
    this.endpoints = endpoints.map((entry, index) => {
      const url = normalizedL1Endpoint(typeof entry === 'string' ? entry : entry.url)
      const declaredProviderId = (typeof entry === 'string' ? providerIds?.[index] : entry.providerId)?.trim()
      const providerId = declaredProviderId || new URL(url).hostname
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(providerId)) {
        throw new Error('L1 RPC provider identity is invalid')
      }
      const endpoint = { url, providerId, source: '' }
      // Durable evidence labels (verifiedSources, receipt provider ids,
      // canonical-floor provenance) carry the operator-declared provider
      // identity when one is configured; the hash-derived id is only the
      // fallback for bare URL endpoints without a declared identity.
      endpoint.source = declaredProviderId ? providerId : sourceId(endpoint)
      return endpoint
    })
    if (new Set(this.endpoints.map(({ url }) => url)).size !== this.endpoints.length) {
      throw new Error('shared L1 transport endpoints must be distinct')
    }
    if (new Set(this.endpoints.map(({ providerId }) => providerId)).size !== this.endpoints.length) {
      throw new Error('shared L1 transport requires distinct independent provider identities per endpoint')
    }
    if (new Set(this.endpoints.map(({ source }) => source)).size !== this.endpoints.length) {
      throw new Error('shared L1 transport evidence source identities must be distinct')
    }
    if (this.endpoints.length < 2) {
      throw new Error('shared L1 transport requires two independent provider identities')
    }
    for (const endpoint of this.endpoints) {
      this.health.set(endpoint.source, {
        source: endpoint.source, healthy: false, lastSuccessAt: null, lastError: null, latencyMs: null,
      })
    }
  }

  private rankedEndpoints(): Endpoint[] {
    return [...this.endpoints].sort((left, right) => {
      const a = this.health.get(left.source)!
      const b = this.health.get(right.source)!
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1
      return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER)
    })
  }

  private async rpc<T>(
    endpoint: Endpoint,
    method: string,
    params: unknown[],
    allowNull = false,
  ): Promise<T> {
    const started = performance.now()
    try {
      const response = await this.request(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as JsonRpcResponse<T>
      if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`)
      if (payload.result === undefined || (payload.result === null && !allowNull)) {
        throw new Error('RPC returned no result')
      }
      this.health.set(endpoint.source, {
        source: endpoint.source,
        healthy: true,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        latencyMs: Math.max(0, performance.now() - started),
      })
      return payload.result
    } catch (error) {
      this.health.set(endpoint.source, {
        source: endpoint.source,
        healthy: false,
        lastSuccessAt: this.health.get(endpoint.source)?.lastSuccessAt ?? null,
        lastError: error instanceof Error ? error.message.slice(0, 300) : 'unknown RPC failure',
        latencyMs: Math.max(0, performance.now() - started),
      })
      throw error
    }
  }

  private async expectedChain(endpoint: Endpoint): Promise<boolean> {
    const chainId = await this.rpc<string>(endpoint, 'eth_chainId', [])
    return BigInt(chainId) === BigInt(this.expectedChainId)
  }

  private async agreed<T>(
    method: string,
    params: unknown[],
    normalize: (value: T) => string,
    allowNull = false,
  ): Promise<{
    value: T
    sources: string[]
  }> {
    const responses = await Promise.allSettled(
      this.rankedEndpoints().map(async (endpoint) => {
        if (!await this.expectedChain(endpoint)) throw new Error('endpoint is on the wrong chain')
        return { endpoint, value: await this.rpc<T>(endpoint, method, params, allowNull) }
      }),
    )
    const groups = new Map<string, Array<{ endpoint: Endpoint; value: T }>>()
    for (const response of responses) {
      if (response.status !== 'fulfilled') continue
      const key = normalize(response.value.value)
      groups.set(key, [...(groups.get(key) ?? []), response.value])
    }
    const eligible = [...groups.values()]
      .filter((group) => new Set(group.map(({ endpoint }) => endpoint.providerId)).size >= 2)
      .sort((left, right) => right.length - left.length)
    if (eligible.length > 1) {
      throw new Error(`${method} returned conflicting two-provider agreements on chain ${this.expectedChainId}`)
    }
    const winner = eligible[0]
    if (!winner) {
      throw new Error(`${method} did not reach two-provider agreement on chain ${this.expectedChainId}`)
    }
    return { value: winner[0]!.value, sources: winner.map(({ endpoint }) => endpoint.source) }
  }

  async agreedBlock(tag: 'latest' | 'finalized' | `0x${string}`): Promise<AgreedL1Block> {
    const block = await this.agreed<{
      number: string
      hash: `0x${string}`
      parentHash: `0x${string}`
      parentBeaconBlockRoot?: `0x${string}` | null
      timestamp: string
    }>('eth_getBlockByNumber', [tag, false], (value) => canonical({
      number: hexNumber(value.number, 'block number'),
      hash: hexData(value.hash, 32, 'block hash'),
      parentHash: hexData(value.parentHash, 32, 'block parentHash'),
      parentBeaconBlockRoot: value.parentBeaconBlockRoot === undefined || value.parentBeaconBlockRoot === null
        ? null
        : hexData(value.parentBeaconBlockRoot, 32, 'block parentBeaconBlockRoot'),
      timestamp: hexNumber(value.timestamp, 'block timestamp'),
    }))
    return {
      chainId: this.expectedChainId,
      number: BigInt(block.value.number).toString(),
      hash: hexData(block.value.hash, 32, 'block hash') as `0x${string}`,
      parentHash: hexData(block.value.parentHash, 32, 'block parentHash') as `0x${string}`,
      parentBeaconBlockRoot: block.value.parentBeaconBlockRoot === undefined || block.value.parentBeaconBlockRoot === null
        ? null
        : hexData(block.value.parentBeaconBlockRoot, 32, 'block parentBeaconBlockRoot') as `0x${string}`,
      timestamp: BigInt(block.value.timestamp).toString(),
      verifiedSources: block.sources,
    }
  }

  async agreedLogs(filter: Record<string, unknown>): Promise<AgreedL1Logs> {
    const sort = (values: Array<Record<string, unknown>>) => values.map(normalizedLog).sort((left, right) => {
      for (const field of ['blockNumber', 'transactionIndex', 'logIndex'] as const) {
        const order = BigInt(String(left[field])) - BigInt(String(right[field]))
        if (order !== 0n) return order < 0n ? -1 : 1
      }
      return 0
    })
    const agreed = await this.agreed<Array<Record<string, unknown>>>(
      'eth_getLogs', [filter], (value) => canonical(sort(value)),
    )
    return { logs: sort(agreed.value), verifiedSources: agreed.sources }
  }

  async agreedCall(input: {
    to: `0x${string}`
    data: `0x${string}`
    blockTag: L1CallBlock
  }): Promise<AgreedL1Call> {
    const to = hexData(input.to, 20, 'call address') as `0x${string}`
    const data = hexData(input.data, null, 'call data') as `0x${string}`
    if (
      !input.blockTag
      || typeof input.blockTag !== 'object'
      || input.blockTag.requireCanonical !== true
    ) throw new Error('critical L1 calls require an EIP-1898 canonical block hash')
    const blockTag: L1CallBlock = {
      blockHash: hexData(input.blockTag.blockHash, 32, 'call blockHash') as `0x${string}`,
      requireCanonical: true,
    }
    const agreed = await this.agreed<string>(
      'eth_call', [{ to, data }, blockTag],
      (value) => hexData(value, null, 'call result'),
    )
    return {
      data: hexData(agreed.value, null, 'call result') as `0x${string}`,
      verifiedSources: agreed.sources,
    }
  }

  async agreedTransaction(hash: `0x${string}`): Promise<AgreedL1Transaction> {
    const agreed = await this.agreed<Record<string, unknown>>(
      'eth_getTransactionByHash', [hash], (value) => canonical(normalizedTransaction(value)),
    )
    const transaction = normalizedTransaction(agreed.value)
    if (transaction.hash !== hash.toLowerCase()) throw new Error('RPC transaction hash does not match request')
    let blockSources: string[] = []
    if (transaction.blockNumber && transaction.blockHash) {
      const block = await this.agreedBlock(transaction.blockNumber as `0x${string}`)
      if (block.hash !== transaction.blockHash) throw new Error('transaction block hash is not canonical')
      blockSources = block.verifiedSources
    }
    return {
      transaction,
      verifiedSources: [...new Set([...agreed.sources, ...blockSources])],
    }
  }

  async agreedReceipt(hash: `0x${string}`): Promise<AgreedL1Transaction> {
    const normalize = (value: Record<string, unknown>) => ({
      transactionHash: hexData(value.transactionHash, 32, 'receipt transactionHash'),
      blockHash: hexData(value.blockHash, 32, 'receipt blockHash'),
      blockNumber: hexNumber(value.blockNumber, 'receipt blockNumber'),
      transactionIndex: hexNumber(value.transactionIndex, 'receipt transactionIndex'),
      status: value.status === undefined ? null : hexNumber(value.status, 'receipt status'),
      type: value.type === undefined ? null : hexNumber(value.type, 'receipt type'),
      gasUsed: value.gasUsed === undefined ? null : hexNumber(value.gasUsed, 'receipt gasUsed'),
      effectiveGasPrice: value.effectiveGasPrice === undefined
        ? null
        : hexNumber(value.effectiveGasPrice, 'receipt effectiveGasPrice'),
      blobGasUsed: value.blobGasUsed === undefined ? null : hexNumber(value.blobGasUsed, 'receipt blobGasUsed'),
      blobGasPrice: value.blobGasPrice === undefined ? null : hexNumber(value.blobGasPrice, 'receipt blobGasPrice'),
    })
    const agreed = await this.agreed<Record<string, unknown>>(
      'eth_getTransactionReceipt', [hash], (value) => canonical(normalize(value)),
    )
    const receipt = normalize(agreed.value)
    if (receipt.transactionHash !== hash.toLowerCase()) throw new Error('receipt transaction hash mismatch')
    const block = await this.agreedBlock(receipt.blockNumber as `0x${string}`)
    if (block.hash !== receipt.blockHash) throw new Error('receipt block hash is not canonical')
    return { transaction: receipt, verifiedSources: [...new Set([...agreed.sources, ...block.verifiedSources])] }
  }

  /**
   * Receipt watcher primitive that distinguishes a two-provider agreed
   * absence from an RPC outage/split. Callers must never treat a thrown quorum
   * error as evidence that an included transaction was reorged out.
   */
  async agreedReceiptOptional(hash: `0x${string}`): Promise<AgreedL1OptionalTransaction> {
    const normalize = (value: Record<string, unknown>) => ({
      transactionHash: hexData(value.transactionHash, 32, 'receipt transactionHash'),
      blockHash: hexData(value.blockHash, 32, 'receipt blockHash'),
      blockNumber: hexNumber(value.blockNumber, 'receipt blockNumber'),
      transactionIndex: hexNumber(value.transactionIndex, 'receipt transactionIndex'),
      status: value.status === undefined ? null : hexNumber(value.status, 'receipt status'),
      type: value.type === undefined ? null : hexNumber(value.type, 'receipt type'),
      gasUsed: value.gasUsed === undefined ? null : hexNumber(value.gasUsed, 'receipt gasUsed'),
      effectiveGasPrice: value.effectiveGasPrice === undefined
        ? null
        : hexNumber(value.effectiveGasPrice, 'receipt effectiveGasPrice'),
      blobGasUsed: value.blobGasUsed === undefined ? null : hexNumber(value.blobGasUsed, 'receipt blobGasUsed'),
      blobGasPrice: value.blobGasPrice === undefined ? null : hexNumber(value.blobGasPrice, 'receipt blobGasPrice'),
    })
    const agreed = await this.agreed<Record<string, unknown> | null>(
      'eth_getTransactionReceipt', [hash],
      (value) => value === null ? 'null' : canonical(normalize(value)),
      true,
    )
    if (agreed.value === null) return { transaction: null, verifiedSources: agreed.sources }
    const receipt = normalize(agreed.value)
    if (receipt.transactionHash !== hash.toLowerCase()) throw new Error('receipt transaction hash mismatch')
    const block = await this.agreedBlock(receipt.blockNumber as `0x${string}`)
    if (block.hash !== receipt.blockHash) throw new Error('receipt block hash is not canonical')
    return { transaction: receipt, verifiedSources: [...new Set([...agreed.sources, ...block.verifiedSources])] }
  }

  async agreedTransactionCount(
    address: `0x${string}`,
    tag: 'latest' | 'pending' = 'pending',
  ): Promise<string> {
    const normalizedAddress = hexData(address, 20, 'transaction-count address')
    const agreed = await this.agreed<string>(
      'eth_getTransactionCount', [normalizedAddress, tag],
      (value) => hexNumber(value, 'transaction count'),
    )
    return BigInt(agreed.value).toString()
  }

  /** Two-provider, expected-chain fee suggestion bound to one canonical latest block. */
  async agreedEip1559Fees(): Promise<AgreedEip1559Fees> {
    const block = await this.agreed<{
      number: string
      hash: `0x${string}`
      baseFeePerGas?: string
    }>('eth_getBlockByNumber', ['latest', false], (value) => canonical({
      number: hexNumber(value.number, 'fee block number'),
      hash: hexData(value.hash, 32, 'fee block hash'),
      baseFeePerGas: hexNumber(value.baseFeePerGas, 'baseFeePerGas'),
    }))
    const priority = await this.agreed<string>(
      'eth_maxPriorityFeePerGas', [], (value) => hexNumber(value, 'maxPriorityFeePerGas'),
    )
    const baseFeePerGas = BigInt(block.value.baseFeePerGas!)
    const maxPriorityFeePerGas = BigInt(priority.value)
    return {
      baseFeePerGas: baseFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      maxFeePerGas: (baseFeePerGas * 2n + maxPriorityFeePerGas).toString(),
      blockNumber: BigInt(block.value.number).toString(),
      blockHash: hexData(block.value.hash, 32, 'fee block hash') as `0x${string}`,
      verifiedSources: [...new Set([...block.sources, ...priority.sources])],
    }
  }

  async broadcastRawTransaction(
    rawTransaction: `0x${string}`,
    expectedTransactionHash?: `0x${string}`,
  ): Promise<`0x${string}`> {
    hexData(rawTransaction, null, 'raw transaction')
    // EIP-4844 network wrappers contain blobs outside the signed transaction
    // hash preimage. Their publisher supplies the independently parsed and
    // reserialized signed-body hash; ordinary envelopes retain keccak(raw).
    const localHash = expectedTransactionHash
      ? hexData(expectedTransactionHash, 32, 'expected transaction hash') as `0x${string}`
      : keccak256(rawTransaction).toLowerCase() as `0x${string}`
    let expectedChainProviders = 0
    let accepted = 0
    for (const endpoint of this.rankedEndpoints()) {
      try {
        if (!await this.expectedChain(endpoint)) continue
        expectedChainProviders += 1
        const returned = (await this.rpc<string>(endpoint, 'eth_sendRawTransaction', [rawTransaction])).toLowerCase()
        if (returned !== localHash) throw new Error('RPC returned a hash different from the signed transaction')
        accepted += 1
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : ''
        if (/\balready known\b|\bknown transaction\b|\balready imported\b/.test(message)) {
          accepted += 1
        } else if (/\bnonce too low\b/.test(message)) {
          // A nonce collision is not evidence that this transaction was imported:
          // another transaction may already occupy the nonce. Accept it only when
          // this provider can return the exact locally-hashed transaction.
          try {
            const existing = normalizedTransaction(
              await this.rpc<Record<string, unknown>>(endpoint, 'eth_getTransactionByHash', [localHash]),
            )
            if (existing.hash === localHash) accepted += 1
          } catch {
            // The watcher must fail closed when the exact transaction is absent.
          }
        }
      }
    }
    if (expectedChainProviders < 2) throw new Error('raw transaction broadcast did not reach two expected-chain providers')
    if (accepted < 1) throw new Error('every L1 RPC rejected the signed transaction')
    return localHash
  }

  status(): L1TransportHealth[] {
    return this.rankedEndpoints().map((endpoint) => ({ ...this.health.get(endpoint.source)! }))
  }
}
