/**
 * The card duel's privacy boundary, expressed as code rather than as a comment.
 *
 * In a VALIDITY_ONLY room every raw signed transaction is republished verbatim
 * as L1 calldata (`zkvm/crates/stf-types/src/batch_data.rs`
 * `canonical_batch_data_v5`). So the bytes this app hands to `callL2` are, for
 * confidentiality purposes, already public. Deck order, per-card salts, the
 * hand array, the Merkle siblings that open a deck leaf and the hand slot a
 * card came from must never appear in them.
 *
 * Nothing in the repository enforces that, so this module does two things:
 *
 *   1. `cardBundleSecrets` names, in one place, exactly which fields of a
 *      `CardWitnessBundle` are secret. It takes the bundle and returns the
 *      VALUES, so the audit below is a value comparison and not a hopeful
 *      inspection of field names on a payload that has already been flattened
 *      into bytes.
 *   2. `auditCardCalldata` runs inside the vault worker - the only realm that
 *      holds those values - immediately before the calldata is allowed out. It
 *      returns nothing and throws on a hit; a boolean would invite an ignored
 *      result on the one path where ignoring it publishes a deck.
 *
 * `assertNoWitnessFieldNames` is the complementary check for JSON payloads
 * (anything that would go to `fetch`), where field names survive.
 *
 * React-free and dependency-free apart from a type import, so it can be unit
 * tested directly and can run inside the worker.
 */
import type { CardWitnessBundle } from '@zkdeal/card'

/**
 * Property names that only ever appear on witness material. A serialized
 * payload carrying any of them has leaked, whatever its values happen to be.
 *
 * `handRoot`, `deckRoot`, `newHandRoot`, `actionCursor`, `deckCursor`,
 * `boardCount` and `publicCard` are deliberately absent: every one of them is a
 * public input of the circuits and a stored field of `CardDuelLibV5.Seat`.
 */
export const CARD_WITNESS_FIELD_NAMES: readonly string[] = Object.freeze([
  'deckCards',
  'deckSalts',
  'handCards',
  'handSalts',
  'cardSalt',
  'deckSiblings',
  'oldHandCards',
  'oldHandSalts',
  'newHandCards',
  'newHandSalts',
  'handSlot',
  'witness',
  'nextBundle',
])

/** Minimum width, in hex characters, a value must have to be worth scanning for. */
const MIN_SCAN_WIDTH = 8

function normalizedHexBody(value: string): string {
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
  return body.toLowerCase()
}

/**
 * Every hex spelling a secret could plausibly take inside ABI-encoded calldata:
 * its natural width, and the 32-byte word an `abi.encode` would pad it into.
 * Card ids are one byte and would produce false positives against any counter,
 * so a deck ORDER is scanned as the concatenation of its twelve ids rather than
 * id by id.
 */
function secretSpellings(value: bigint): string[] {
  const bare = value.toString(16)
  const even = bare.length % 2 === 0 ? bare : `0${bare}`
  const padded = bare.padStart(64, '0')
  return even.length >= MIN_SCAN_WIDTH ? [even, padded] : [padded]
}

/**
 * The exact secret values held by one witness bundle, as lowercase hex bodies
 * without an `0x` prefix.
 *
 * Salts are 254-bit field elements, so each is unmistakable inside calldata.
 * The deck order is included as the concatenated id sequence: a single card id
 * is one byte and matching it alone would flag every unrelated counter, while
 * the ordered sequence is what the commitment actually hides.
 */
export function cardBundleSecrets(bundle: CardWitnessBundle): string[] {
  const secrets: string[] = []
  for (const salt of bundle.deckSalts) {
    for (const spelling of secretSpellings(BigInt(salt))) secrets.push(spelling)
  }
  for (const salt of bundle.handSalts) {
    if (salt === '0') continue
    for (const spelling of secretSpellings(BigInt(salt))) secrets.push(spelling)
  }
  const deckOrder = bundle.deckCards.map((card) => card.toString(16).padStart(2, '0')).join('')
  if (deckOrder.length >= MIN_SCAN_WIDTH) secrets.push(deckOrder)
  // The HAND array is deliberately not scanned. Each entry is a card id in
  // [1, 12] - one byte - and a hand of eight slots is mostly zeros, so a byte
  // scan for it matches the zero padding of any ABI-encoded word and reports a
  // leak on every transaction. Hand contents are guarded structurally instead:
  // no `CardMoveRequest` field can carry them, and `card-calldata.test.ts`
  // pins the published argument list of every entry point. What DOES make a
  // hand card recoverable from the wire is its salt, and every salt above is
  // scanned.
  return [...new Set(secrets)]
}

export class CardPrivacyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardPrivacyError'
  }
}

/**
 * The same secrets rendered the way a THROWN STRING or a log line would carry
 * them, rather than the way ABI-encoded bytes would.
 *
 * `auditCardCalldata` scans hex NIBBLES, which is right for calldata and
 * useless for text: a message reading `salt 12345678901234567890 rejected`
 * hex-encodes to the ASCII of those digits, and the ASCII of a number never
 * contains that number's own hex spelling. Text therefore needs its own
 * renderings - decimal (how every salt is stored in a bundle) and `0x` hex.
 *
 * The deck ORDER is included as its concatenated id sequence for the same
 * reason it is in `cardBundleSecrets`, and single card ids are excluded for
 * the same reason: one byte matches everything.
 */
export function cardBundleSecretTexts(bundle: CardWitnessBundle): string[] {
  const texts: string[] = []
  const push = (decimalValue: string): void => {
    const value = BigInt(decimalValue)
    if (value === 0n) return
    const bare = value.toString(16)
    texts.push(value.toString(10), bare, `0x${bare}`, bare.padStart(64, '0'))
  }
  for (const salt of bundle.deckSalts) push(salt)
  for (const salt of bundle.handSalts) push(salt)
  texts.push(bundle.deckCards.join(','))
  texts.push(`[${bundle.deckCards.join(',')}]`)
  return [...new Set(texts.filter((text) => text.length >= MIN_SCAN_WIDTH))]
}

/**
 * Refuse to release a diagnostic string that quotes hidden material. Case
 * insensitive because hex is spelled both ways, and the thrown message names
 * only the index, never the match.
 */
export function auditCardText(
  texts: readonly string[],
  text: string,
  label = 'card diagnostic',
): void {
  const haystack = text.toLowerCase()
  texts.forEach((secret, index) => {
    if (secret.length >= MIN_SCAN_WIDTH && haystack.includes(secret.toLowerCase())) {
      throw new CardPrivacyError(
        `${label} quotes hidden witness material (secret #${index}); it was not released`,
      )
    }
  })
}

/**
 * Refuse to release `calldata` if it contains any of `secrets`.
 *
 * The thrown message names WHICH class of material matched and where, but never
 * the matched value: an error string is the classic accidental transport, and
 * this one is rendered in the UI.
 */
export function auditCardCalldata(
  secrets: readonly string[],
  calldata: string,
  label = 'card move calldata',
): void {
  const body = normalizedHexBody(calldata)
  if (!/^[0-9a-f]*$/.test(body)) {
    throw new CardPrivacyError(`${label} is not plain hex, so it cannot be audited`)
  }
  secrets.forEach((secret, index) => {
    if (secret.length >= MIN_SCAN_WIDTH && body.includes(secret)) {
      throw new CardPrivacyError(
        `${label} contains hidden witness material (secret #${index} at byte ${
          body.indexOf(secret) / 2
        }); the transaction was not released`,
      )
    }
  })
}

/**
 * Refuse a JSON-shaped payload that carries a witness property name. Applied to
 * anything destined for `fetch` or for persistence, where names survive.
 */
export function assertNoWitnessFieldNames(payload: unknown, label = 'payload'): void {
  const seen = new WeakSet<object>()
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value as object)) return
    seen.add(value as object)
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (CARD_WITNESS_FIELD_NAMES.includes(key)) {
        throw new CardPrivacyError(`${label}${path}.${key} is hidden witness material`)
      }
      walk(item, `${path}.${key}`)
    }
  }
  walk(payload, '')
}
