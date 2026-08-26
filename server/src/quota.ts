/**
 * Bounded token-bucket rate limiting (review: "no per-IP/per-room quotas on
 * bus posts, manifest/genesis/snapshot bodies, and faucet").
 *
 * Deliberately dependency-free and O(1): one bucket per key, keys evicted in
 * insertion order once `maxKeys` is reached so a stream of unique keys cannot
 * grow the map without bound (which was itself part of the reported DoS).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>()

  /**
   * @param capacity burst size (tokens)
   * @param refillPerSec sustained rate
   * @param maxKeys map ceiling before insertion-order eviction
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly maxKeys = 10_000,
  ) {
    // `NaN` passed the previous `<= 0` guard, after which `b.tokens` became
    // NaN and `b.tokens < cost` was false forever - a silently disabled
    // limiter. Reject anything that is not a positive finite number.
    if (
      !Number.isFinite(capacity) ||
      capacity <= 0 ||
      !Number.isFinite(refillPerSec) ||
      refillPerSec <= 0
    ) {
      throw new Error('RateLimiter: capacity/rate must be positive finite numbers')
    }
  }

  /** Consume `cost` tokens; false = rate limited (caller must reject). */
  take(key: string, cost = 1, nowMs = Date.now()): boolean {
    let b = this.buckets.get(key)
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next()
        if (!oldest.done) this.buckets.delete(oldest.value)
      }
      b = { tokens: this.capacity, updatedMs: nowMs }
      this.buckets.set(key, b)
    } else {
      const elapsedSec = Math.max(0, nowMs - b.updatedMs) / 1000
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec)
      b.updatedMs = nowMs
    }
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  reset(): void {
    this.buckets.clear()
  }
}
