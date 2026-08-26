import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ServerConfig } from './config.js'

function localChain(cfg: ServerConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: 'zkdeal-l1',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.l1RpcUrl] } },
  })
}

/** Hard ceiling on tracked addresses; entries expire after the cooldown. */
const MAX_TRACKED_ADDRESSES = 50_000

export class FaucetService {
  /**
   * Cooldown reservations. The timestamp is written BEFORE the transaction is
   * sent (and rolled back on submission failure) - writing it after the await
   * let every concurrent request for one address pass the precheck.
   */
  private readonly lastByAddress = new Map<string, number>()
  /** Rolling-hour drip timestamps, for the global budget. */
  private recentDrips: number[] = []
  private readonly wallet: WalletClient | null
  private readonly account
  private readonly chain: Chain
  private readonly rpc: PublicClient | null

  constructor(
    private readonly cfg: ServerConfig,
    publicClient?: PublicClient,
  ) {
    this.chain = localChain(cfg)
    if (!cfg.faucetKey) {
      this.wallet = null
      this.account = null
      this.rpc = null
      return
    }
    this.account = privateKeyToAccount(cfg.faucetKey)
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(cfg.l1RpcUrl),
    })
    this.rpc =
      publicClient ??
      createPublicClient({
        chain: this.chain,
        transport: http(cfg.l1RpcUrl),
      })
  }

  get enabled(): boolean {
    return this.wallet !== null
  }

  async drip(address: Hex): Promise<{ ok: true; txHash: Hex } | { ok: false; error: string; status: number }> {
    if (!this.wallet || !this.account) {
      return { ok: false, error: 'faucet disabled (FAUCET_KEY not set)', status: 503 }
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { ok: false, error: 'invalid address', status: 400 }
    }
    const key = address.toLowerCase()
    const now = Date.now()
    this.prune(now)

    const last = this.lastByAddress.get(key) ?? 0
    if (now - last < this.cfg.faucetCooldownMs) {
      const retrySec = Math.ceil((this.cfg.faucetCooldownMs - (now - last)) / 1000)
      return { ok: false, error: `rate limited; retry in ${retrySec}s`, status: 429 }
    }
    // Unique-address floods bypass the per-address cooldown entirely, so cap
    // total drips per rolling hour as well.
    if (this.recentDrips.length >= this.cfg.faucetMaxDripsPerHour) {
      return { ok: false, error: 'faucet budget exhausted; try later', status: 429 }
    }
    if (this.lastByAddress.size >= MAX_TRACKED_ADDRESSES) {
      return { ok: false, error: 'faucet busy; try later', status: 429 }
    }

    // Reserve the slot atomically (single-threaded event loop: no await
    // between the check above and these writes) so concurrent requests for the
    // same address cannot all pass.
    this.lastByAddress.set(key, now)
    this.recentDrips.push(now)

    try {
      const txHash = await this.wallet.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: address,
        value: this.cfg.faucetWei,
      })
      if (this.rpc) {
        // anvil --block-time 12: wait or caller must anvil_mine
        await this.rpc.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 }).catch(() => undefined)
      }
      return { ok: true, txHash }
    } catch (err) {
      // Submission failed: release the reservation so the caller may retry,
      // but keep it if the failure could still land on-chain is unknown - we
      // only roll back when nothing was broadcast (viem throws before/at send).
      this.lastByAddress.delete(key)
      const i = this.recentDrips.lastIndexOf(now)
      if (i >= 0) this.recentDrips.splice(i, 1)
      this.err = err instanceof Error ? err.message : String(err)
      // Upstream node errors can carry the RPC URL / node internals; keep them
      // in the server log (caller-visible text stays generic).
      return { ok: false, error: 'faucet transaction failed', status: 502 }
    }
  }

  /** Last upstream error (server-side diagnostics only; never returned). */
  err: string | null = null

  private prune(now: number): void {
    const cutoff = now - 3_600_000
    if (this.recentDrips.length > 0 && this.recentDrips[0]! <= cutoff) {
      this.recentDrips = this.recentDrips.filter((t) => t > cutoff)
    }
    if (this.lastByAddress.size > MAX_TRACKED_ADDRESSES / 2) {
      for (const [k, t] of this.lastByAddress) {
        if (now - t >= this.cfg.faucetCooldownMs) this.lastByAddress.delete(k)
      }
    }
  }
}
