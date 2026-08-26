import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface FinalizedAnchor {
  block: bigint
  hash: `0x${string}`
}

/**
 * Coordinator-owned marker of the highest finalized L1 block it has read.
 *
 * The anchor decides which archived facts the observer write surface treats
 * as immutable, so it lives outside the archive an external indexer rewrites
 * (the AdmissionIdStore pattern): it is advanced only from the coordinator's
 * own finalized-tag quorum reads, never from a PUT body - an archive-fed
 * anchor would let a two-step rewind lower the marker first and rewrite
 * "unfinalized" facts second. Reads never touch L1.
 */
export class FinalizedAnchorStore {
  private anchor: FinalizedAnchor | null = null

  /** `path` null keeps the anchor in memory only (tests, ephemeral runs). */
  constructor(private readonly path: string | null = null) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (
        typeof parsed.block === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(parsed.block) &&
        typeof parsed.hash === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(parsed.hash)
      ) {
        this.anchor = { block: BigInt(parsed.block), hash: parsed.hash as `0x${string}` }
      }
    } catch (error) {
      // A missing record is the normal first-run state. Anything else must not
      // be silently treated as "nothing finalized yet".
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  current(): FinalizedAnchor | null {
    return this.anchor
  }

  /** Monotonic: a lower or equal block never moves the anchor. */
  advance(block: bigint, hash: `0x${string}`): void {
    if (this.anchor && block <= this.anchor.block) return
    this.anchor = { block, hash }
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ block: block.toString(), hash })}\n`, 'utf8')
    renameSync(temporary, this.path)
  }
}
