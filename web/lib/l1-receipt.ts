/**
 * Turning a published transaction reference into something a viewer can look up
 * INDEPENDENTLY.
 *
 * This is the one rule the whole module exists for: a hash a reader cannot
 * paste into an explorer is worse than no hash at all, because it looks like
 * evidence and is not. So every value here is either a complete 32-byte hash -
 * rendered in full, linked to the explorer the COORDINATOR advertises - or it
 * is explicitly reported as incomplete, with no link at all. There is no third
 * outcome and in particular there is no anchor whose href is an abbreviation.
 *
 * WHY ANYTHING IS INCOMPLETE. `publicDemoView` in `server/src/demo-routes.ts`
 * abbreviates every hex string of 40+ characters it publishes, except the keys
 * on its `PUBLISHED_IN_FULL` list. A checkpoint therefore arrives with
 * `transaction` abbreviated and `l1TransactionHash` whole, and the full hash
 * also survives inside `explorerUrl` - which is where it is recovered from when
 * the coordinator publishes no whole field. A room's `deploymentTransaction` is
 * on neither list today, so it arrives abbreviated with no explorer URL beside
 * it and is reported as unlookupable rather than linked to a guess.
 *
 * WHY THE BASE IS NEVER HARDCODED. The explorer root is read from
 * `/demo/v1/system` -> `explorerUrl` (see `lib/demo-system.ts`). A host and port
 * baked in here would be right on exactly one stand and silently wrong on every
 * other, and "silently wrong link to a block explorer" is indistinguishable
 * from a fabricated receipt.
 *
 * React-free so the link a row renders can be asserted in a unit test.
 */
import { httpLink } from './demo-console'

/** A complete 32-byte transaction hash. */
const FULL_HASH = /^0x[0-9a-fA-F]{64}$/

/** The hash inside an explorer transaction URL, which is never abbreviated. */
const HASH_IN_URL = /\/tx\/(0x[0-9a-fA-F]{64})(?:[/?#]|$)/

export interface L1Receipt {
  /** The full hash when one could be recovered, otherwise what was published. */
  readonly hash: string
  /** True only when `hash` is a complete 32-byte hash. */
  readonly complete: boolean
  /** An http(s) explorer URL carrying the FULL hash, or null. Never a guess. */
  readonly url: string | null
  /** Why this cannot be looked up, when it cannot. Null when it can. */
  readonly note: string | null
}

/**
 * Every place a transaction reference can hide, in order of trust.
 *
 * `hash` is a field the coordinator publishes whole (`l1TransactionHash`);
 * `transaction` is the historically abbreviated one; `explorerUrl` is the
 * coordinator's own link. A caller passes whatever it has and gets back the
 * best complete answer available, or an honest incomplete one.
 */
export interface L1ReceiptSource {
  readonly hash?: string | null
  readonly transaction?: string | null
  readonly explorerUrl?: string | null
}

const ABBREVIATED_NOTE =
  'The coordinator publishes this hash abbreviated and advertises no link for it, so it cannot be looked up from here.'

const NO_EXPLORER_NOTE =
  'This coordinator advertises no block explorer, so there is nothing to link the full hash to.'

/**
 * The link for one transaction, or the reason there is none.
 *
 * `explorerBase` is the coordinator's advertised explorer root and is only used
 * to BUILD a URL for a hash that is already complete. It can never rescue an
 * abbreviated hash: `${base}/tx/0x05d3ac...ce78` is a 404 dressed as evidence.
 */
export function l1Receipt(
  source: L1ReceiptSource,
  explorerBase?: string | null,
): L1Receipt {
  const link = httpLink(source.explorerUrl)
  const base = httpLink(explorerBase)?.replace(/\/+$/, '') ?? null
  const published = source.hash ?? source.transaction ?? ''
  const full =
    (typeof source.hash === 'string' && FULL_HASH.test(source.hash) ? source.hash : null) ??
    (link ? (HASH_IN_URL.exec(link)?.[1] ?? null) : null) ??
    (typeof source.transaction === 'string' && FULL_HASH.test(source.transaction)
      ? source.transaction
      : null)
  if (full === null) {
    return {
      hash: published,
      complete: false,
      url: null,
      note: ABBREVIATED_NOTE,
    }
  }
  // Prefer the coordinator's own URL when it already carries this hash; it is
  // the destination the operator configured. Otherwise compose one from the
  // advertised root.
  const url = link && link.includes(full) ? link : base !== null ? `${base}/tx/${full}` : null
  return {
    hash: full,
    complete: true,
    url,
    note: url === null ? NO_EXPLORER_NOTE : null,
  }
}

/**
 * A label short enough for a dense log row. It is only ever used as the TEXT of
 * a link whose href carries the whole hash, which is why `l1ReceiptLabel` is
 * not exported for use anywhere a link is absent - an abbreviation on its own
 * is the thing this module refuses to render.
 */
export function l1ReceiptLabel(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash
}

export interface L1ReceiptLink {
  readonly href: string
  /** Short enough for a log row; the href carries the full hash. */
  readonly text: string
  /** The full hash, for the tooltip and for anyone reading it off the screen. */
  readonly title: string
}

/**
 * The anchor a log row renders, or null when there is nothing lookupable.
 *
 * A caller that gets null must say WHY (the receipt's `note`) rather than
 * rendering the abbreviation as though it were a reference.
 */
export function l1ReceiptLink(receipt: L1Receipt): L1ReceiptLink | null {
  if (!receipt.complete || receipt.url === null) return null
  return {
    href: receipt.url,
    text: l1ReceiptLabel(receipt.hash),
    title: receipt.hash,
  }
}
