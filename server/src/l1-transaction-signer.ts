import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem'

export interface BlobTransactionToSign {
  chainId: number
  nonce: bigint
  to: `0x${string}`
  data: Hex
  value: bigint
  gas: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  maxFeePerBlobGas: bigint
  blobVersionedHashes: Hex[]
}

export interface SignedBlobTransactionBody {
  signedBody: Hex
  transactionHash: `0x${string}`
}

export interface Eip1559TransactionToSign {
  chainId: number
  nonce: bigint
  to: `0x${string}`
  data: Hex
  value: bigint
  gas: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
}

export type SignedEip1559TransactionBody = SignedBlobTransactionBody

export interface L1TransactionSigner {
  readonly address: `0x${string}`
  assertReady(): Promise<void>
  signEip4844(input: BlobTransactionToSign): Promise<SignedBlobTransactionBody>
}

export interface L1Eip1559TransactionSigner {
  readonly address: `0x${string}`
  assertReady(): Promise<void>
  signEip1559(input: Eip1559TransactionToSign): Promise<SignedEip1559TransactionBody>
}

interface Web3SignerL1Options {
  url: string
  expectedAddress: `0x${string}`
  authToken: string
  previousAuthToken?: string | null
  timeoutMs?: number
  request?: typeof globalThis.fetch
}

function quantity(value: bigint | number): Hex {
  const next = BigInt(value)
  if (next < 0n) throw new Error('transaction quantities cannot be negative')
  return `0x${next.toString(16)}`
}

function data(value: unknown, bytes: number | null, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  const expression = bytes === null ? /^0x(?:[0-9a-f]{2})*$/ : new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`)
  if (!expression.test(text)) throw new Error(`${field} is malformed`)
  return text as Hex
}

function sameBigInt(actual: unknown, expected: bigint, field: string): void {
  if (actual === undefined || actual === null || BigInt(actual as bigint | number | string) !== expected) {
    throw new Error(`remote L1 signer changed transaction ${field}`)
  }
}

/**
 * Scoped Web3Signer boundary for hosted L1 writes. It accepts only a complete
 * EIP-4844 transaction request and verifies the returned envelope and signer
 * before any bytes can be archived or broadcast.
 */
export class Web3SignerL1TransactionSigner implements L1TransactionSigner, L1Eip1559TransactionSigner {
  readonly address: `0x${string}`
  private readonly url: string
  private readonly tokens: string[]
  private readonly timeoutMs: number
  private readonly request: typeof globalThis.fetch

  constructor(options: Web3SignerL1Options) {
    const url = new URL(options.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('L1 signer URL must be HTTP(S)')
    if (!/^0x[0-9a-fA-F]{40}$/.test(options.expectedAddress)) {
      throw new Error('L1 signer expected address is malformed')
    }
    if (options.authToken.length < 16) throw new Error('L1 signer auth token is too short')
    if (options.previousAuthToken && options.previousAuthToken.length < 16) {
      throw new Error('previous L1 signer auth token is too short')
    }
    this.url = url.href
    this.address = options.expectedAddress.toLowerCase() as `0x${string}`
    this.tokens = [...new Set(
      [options.authToken, options.previousAuthToken].filter((item): item is string => Boolean(item)),
    )]
    this.timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 10_000, 30_000))
    this.request = options.request ?? globalThis.fetch
  }

  private async rpc<T>(method: 'eth_accounts' | 'eth_signTransaction', params: unknown[]): Promise<T> {
    let lastError = 'remote L1 signer rejected the request'
    for (const token of this.tokens) {
      try {
        const response = await this.request(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (response.status === 401 || response.status === 403) {
          lastError = `remote L1 signer authentication failed (${response.status})`
          continue
        }
        if (!response.ok) throw new Error(`remote L1 signer HTTP ${response.status}`)
        const payload = await response.json() as {
          result?: T
          error?: { code?: number; message?: string }
        }
        if (payload.error) {
          throw new Error(`remote L1 signer RPC ${payload.error.code ?? 'error'}: ${payload.error.message ?? 'rejected'}`)
        }
        if (payload.result === undefined || payload.result === null) {
          throw new Error('remote L1 signer returned no result')
        }
        return payload.result
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'remote L1 signer request failed'
      }
    }
    throw new Error(lastError)
  }

  async assertReady(): Promise<void> {
    const accounts = await this.rpc<string[]>('eth_accounts', [])
    if (!Array.isArray(accounts) || !accounts.some((account) => account.toLowerCase() === this.address)) {
      throw new Error('remote L1 signer does not expose the configured address')
    }
  }

  async signEip4844(input: BlobTransactionToSign): Promise<SignedBlobTransactionBody> {
    data(input.to, 20, 'transaction to')
    data(input.data, null, 'transaction data')
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('transaction chainId is invalid')
    if (input.blobVersionedHashes.length === 0) throw new Error('blob transaction has no versioned hashes')
    const versionedHashes = input.blobVersionedHashes.map((hash) => data(hash, 32, 'blob versioned hash'))
    const result = await this.rpc<string | { raw?: string }>('eth_signTransaction', [{
      from: this.address,
      to: input.to.toLowerCase(),
      type: '0x3',
      chainId: quantity(input.chainId),
      nonce: quantity(input.nonce),
      gas: quantity(input.gas),
      maxPriorityFeePerGas: quantity(input.maxPriorityFeePerGas),
      maxFeePerGas: quantity(input.maxFeePerGas),
      maxFeePerBlobGas: quantity(input.maxFeePerBlobGas),
      value: quantity(input.value),
      data: input.data.toLowerCase(),
      accessList: [],
      blobVersionedHashes: versionedHashes,
    }])
    const raw = typeof result === 'string' ? result : result.raw
    const signedBody = data(raw, null, 'remote L1 signer result')
    const parsed = parseTransaction(signedBody)
    if (parsed.type !== 'eip4844' || !parsed.r || !parsed.s || parsed.yParity === undefined) {
      throw new Error('remote L1 signer did not return a signed EIP-4844 body')
    }
    if (Array.isArray(parsed.sidecars) && parsed.sidecars.length > 0) {
      throw new Error('remote L1 signer unexpectedly returned blob sidecars')
    }
    sameBigInt(parsed.chainId, BigInt(input.chainId), 'chainId')
    sameBigInt(parsed.nonce, input.nonce, 'nonce')
    sameBigInt(parsed.gas, input.gas, 'gas')
    sameBigInt(parsed.value ?? 0n, input.value, 'value')
    sameBigInt(parsed.maxPriorityFeePerGas, input.maxPriorityFeePerGas, 'maxPriorityFeePerGas')
    sameBigInt(parsed.maxFeePerGas, input.maxFeePerGas, 'maxFeePerGas')
    sameBigInt(parsed.maxFeePerBlobGas, input.maxFeePerBlobGas, 'maxFeePerBlobGas')
    if (parsed.to?.toLowerCase() !== input.to.toLowerCase()) throw new Error('remote L1 signer changed transaction to')
    if ((parsed.data ?? '0x').toLowerCase() !== input.data.toLowerCase()) {
      throw new Error('remote L1 signer changed transaction data')
    }
    const actualHashes = parsed.blobVersionedHashes?.map((hash) => hash.toLowerCase()) ?? []
    if (
      actualHashes.length !== versionedHashes.length
      || actualHashes.some((hash, index) => hash !== versionedHashes[index])
    ) throw new Error('remote L1 signer changed transaction blob versioned hashes')
    if ((parsed.accessList?.length ?? 0) !== 0) throw new Error('remote L1 signer changed transaction access list')
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signedBody as `0x03${string}`,
    })
    if (recovered.toLowerCase() !== this.address) {
      throw new Error('remote L1 signer returned a transaction from the wrong key')
    }
    return { signedBody, transactionHash: keccak256(signedBody).toLowerCase() as `0x${string}` }
  }

  async signEip1559(input: Eip1559TransactionToSign): Promise<SignedEip1559TransactionBody> {
    data(input.to, 20, 'transaction to')
    data(input.data, null, 'transaction data')
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('transaction chainId is invalid')
    const result = await this.rpc<string | { raw?: string }>('eth_signTransaction', [{
      from: this.address,
      to: input.to.toLowerCase(),
      type: '0x2',
      chainId: quantity(input.chainId),
      nonce: quantity(input.nonce),
      gas: quantity(input.gas),
      maxPriorityFeePerGas: quantity(input.maxPriorityFeePerGas),
      maxFeePerGas: quantity(input.maxFeePerGas),
      value: quantity(input.value),
      data: input.data.toLowerCase(),
      accessList: [],
    }])
    const raw = typeof result === 'string' ? result : result.raw
    const signedBody = data(raw, null, 'remote L1 signer result')
    const parsed = parseTransaction(signedBody)
    if (parsed.type !== 'eip1559' || !parsed.r || !parsed.s || parsed.yParity === undefined) {
      throw new Error('remote L1 signer did not return a signed EIP-1559 transaction')
    }
    sameBigInt(parsed.chainId, BigInt(input.chainId), 'chainId')
    sameBigInt(parsed.nonce, input.nonce, 'nonce')
    sameBigInt(parsed.gas, input.gas, 'gas')
    sameBigInt(parsed.value ?? 0n, input.value, 'value')
    sameBigInt(parsed.maxPriorityFeePerGas, input.maxPriorityFeePerGas, 'maxPriorityFeePerGas')
    sameBigInt(parsed.maxFeePerGas, input.maxFeePerGas, 'maxFeePerGas')
    if (parsed.to?.toLowerCase() !== input.to.toLowerCase()) throw new Error('remote L1 signer changed transaction to')
    if ((parsed.data ?? '0x').toLowerCase() !== input.data.toLowerCase()) {
      throw new Error('remote L1 signer changed transaction data')
    }
    if ((parsed.accessList?.length ?? 0) !== 0) throw new Error('remote L1 signer changed transaction access list')
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signedBody as `0x02${string}`,
    })
    if (recovered.toLowerCase() !== this.address) {
      throw new Error('remote L1 signer returned a transaction from the wrong key')
    }
    return { signedBody, transactionHash: keccak256(signedBody).toLowerCase() as `0x${string}` }
  }
}
