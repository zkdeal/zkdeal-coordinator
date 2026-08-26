/**
 * Narrow classification of RoomManager revert reasons.
 *
 * `joinRoom` is the only lifecycle call the UI retries idempotently: a member
 * who is already registered on L1 can re-attach without re-depositing. Every
 * OTHER revert (WrongDeposit, RoomFull, DeadlinePassed, WrongState, BadParams,
 * user rejection, RPC failure) is a real failure and must reach the user -
 * suppressing them made "not a member, deposit never escrowed" look identical
 * to "already joined".
 */
import { keccak256, toBytes } from 'viem'

/** 4-byte selector of a Solidity custom error, e.g. `AlreadyMember()`. */
function errorSelector(signature: string): string {
  return keccak256(toBytes(signature)).slice(0, 10).toLowerCase()
}

const ALREADY_MEMBER_SELECTOR = errorSelector('AlreadyMember()')

/**
 * True only when the revert is RoomManager's `AlreadyMember()`.
 *
 * Matches the decoded error name (viem decodes it when the ABI carries the
 * error) and, when it does not, the raw revert data - which must BE the
 * selector, not merely contain it. Searching the flattened error text for
 * eight unanchored hex characters could match request bytes viem embeds in
 * its error blobs and swallow a real failure. Anything else - including an
 * undecodable failure - returns false so the caller fails closed.
 */
export function isAlreadyMemberError(e: unknown): boolean {
  const { text, revertData } = flattenError(e)
  if (text.includes('alreadymember')) return true
  return revertData.includes(ALREADY_MEMBER_SELECTOR)
}

interface FlattenedError {
  /** Lower-cased human-readable parts, joined. */
  text: string
  /** Lower-cased hex strings that are candidate revert data, unmerged. */
  revertData: string[]
}

/**
 * Flatten a viem error into message text plus raw revert-data candidates.
 *
 * `cause` chains are walked with a visited set: guarding only `cause !== e`
 * rejected a self-reference but recursed forever on a two-node cycle, turning
 * a classification question into a RangeError on the join path.
 */
function flattenError(e: unknown, seen: Set<object> = new Set()): FlattenedError {
  if (e === null || e === undefined) return { text: '', revertData: [] }
  if (typeof e === 'string') return { text: e.toLowerCase(), revertData: [] }
  if (typeof e !== 'object') return { text: '', revertData: [] }
  if (seen.has(e)) return { text: '', revertData: [] }
  seen.add(e)
  const err = e as { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown }
  const parts: string[] = []
  const revertData: string[] = []
  for (const v of [err.message, err.shortMessage, err.details]) {
    if (typeof v === 'string') parts.push(v)
  }
  const data = err.data
  if (typeof data === 'string') collectRevertData(data, parts, revertData)
  else if (data && typeof data === 'object') {
    const d = data as { errorName?: unknown; data?: unknown }
    if (typeof d.errorName === 'string') parts.push(d.errorName)
    if (typeof d.data === 'string') collectRevertData(d.data, parts, revertData)
  }
  if (err.cause) {
    const nested = flattenError(err.cause, seen)
    if (nested.text) parts.push(nested.text)
    revertData.push(...nested.revertData)
  }
  return { text: parts.join(' | ').toLowerCase(), revertData }
}

/** Hex data is a revert-data candidate; anything else is just more text. */
function collectRevertData(value: string, parts: string[], revertData: string[]): void {
  const normalized = value.toLowerCase()
  if (/^0x[0-9a-f]*$/.test(normalized)) revertData.push(normalized)
  else parts.push(value)
}

/** Human-readable single-line message for surfacing an L1/L2 failure in the UI. */
export function errorMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown }
  if (typeof err?.shortMessage === 'string' && err.shortMessage) return err.shortMessage
  if (typeof err?.message === 'string' && err.message) return err.message
  return String(e)
}
