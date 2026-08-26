import { recoverTypedDataAddress, type Hex } from 'viem'
import type { AdmissionSigner, AdmissionTypedData } from './admission.js'

interface Web3SignerOptions {
  url: string
  expectedAddress: Hex
  authToken: string
  previousAuthToken?: string | null
  timeoutMs?: number
  request?: typeof globalThis.fetch
}

function serializable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(serializable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serializable(item)]),
    )
  }
  return value
}

/** Narrow remote key boundary: this client can request only EIP-712 signatures. */
export class Web3SignerAdmissionSigner implements AdmissionSigner {
  readonly address: Hex
  private readonly url: string
  private readonly tokens: string[]
  private readonly timeoutMs: number
  private readonly request: typeof globalThis.fetch

  constructor(options: Web3SignerOptions) {
    const url = new URL(options.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('admission signer URL must be HTTP(S)')
    if (!/^0x[0-9a-fA-F]{40}$/.test(options.expectedAddress)) {
      throw new Error('admission signer expected address is malformed')
    }
    if (options.authToken.length < 16) throw new Error('admission signer auth token is too short')
    if (options.previousAuthToken && options.previousAuthToken.length < 16) {
      throw new Error('previous admission signer auth token is too short')
    }
    this.url = url.href
    this.address = options.expectedAddress.toLowerCase() as Hex
    this.tokens = [...new Set([options.authToken, options.previousAuthToken].filter((item): item is string => Boolean(item)))]
    this.timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5_000, 30_000))
    this.request = options.request ?? globalThis.fetch
  }

  private async rpc<T>(method: 'eth_accounts' | 'eth_signTypedData_v4', params: unknown[]): Promise<T> {
    let lastError = 'remote signer rejected the request'
    for (const token of this.tokens) {
      try {
        const response = await this.request(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (response.status === 401 || response.status === 403) {
          lastError = `remote signer authentication failed (${response.status})`
          continue
        }
        if (!response.ok) throw new Error(`remote signer HTTP ${response.status}`)
        const payload = await response.json() as {
          result?: T
          error?: { code?: number; message?: string }
        }
        if (payload.error) throw new Error(`remote signer RPC ${payload.error.code ?? 'error'}: ${payload.error.message ?? 'rejected'}`)
        if (payload.result === undefined || payload.result === null) throw new Error('remote signer returned no result')
        return payload.result
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'remote signer request failed'
      }
    }
    throw new Error(lastError)
  }

  async assertReady(): Promise<void> {
    const accounts = await this.rpc<string[]>('eth_accounts', [])
    if (!Array.isArray(accounts) || !accounts.some((account) => account.toLowerCase() === this.address)) {
      throw new Error('remote admission signer does not expose the configured address')
    }
  }

  async signTypedData(data: AdmissionTypedData): Promise<Hex> {
    const signature = await this.rpc<string>('eth_signTypedData_v4', [
      this.address,
      JSON.stringify(serializable(data)),
    ])
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('remote admission signer returned a malformed signature')
    const recovered = await recoverTypedDataAddress({ ...data, signature: signature as Hex })
    if (recovered.toLowerCase() !== this.address) {
      throw new Error('remote admission signer returned a signature from the wrong key')
    }
    return signature.toLowerCase() as Hex
  }
}
