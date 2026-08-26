/**
 * Admitting ONE move into a room.
 *
 * Split out of `demo-controller.ts` so the controller keeps only the
 * snapshot bookkeeping (idempotency, persistence, events) and the rules a move
 * has to satisfy live in one pure function that a table test can drive.
 *
 * PRIVACY. The three fields a caller supplies are an action id, an actor label
 * and public calldata, plus an optional EIP-2718 envelope carrying that same
 * calldata and a signature. There is no field here that could hold a deck
 * order, a salt, a hand or a Merkle path, and nothing on this path widens the
 * body: unknown properties are ignored rather than stored.
 */
import { DEMO_PRESETS } from './demo-presets.js'
import { cleanHex, now, shortId } from './demo-validation.js'
import type { DemoAction, DemoRoom, DemoTemplate } from './demo-types.js'

/** A room block holds at most this many PENDING actions. */
export const ACTIONS_PER_ROOM_BLOCK = 32

/** An EIP-2718 envelope is at least a type byte, an RLP header and a signature. */
export const MINIMUM_ENVELOPE_BYTES = 32

export interface DemoActionRequest {
  actionId: string
  actorId: string
  calldata?: string
  block?: 1 | 2
  signedTransaction?: string
}

/**
 * The action a room would accept for this request, or a throw naming the rule
 * it breaks. Pure apart from the id and timestamp it stamps, so the caller
 * decides whether to keep it.
 */
export function buildDemoAction(
  room: DemoRoom,
  template: DemoTemplate | undefined,
  input: DemoActionRequest,
): DemoAction {
  const preset = template?.presetId
    ? DEMO_PRESETS.find((item) => item.id === template.presetId)
    : null
  const presetAction = preset?.actions.find((item) => item.id === input.actionId)
  const calldata = cleanHex(input.calldata ?? presetAction?.calldata, null, 'action calldata')
  if (calldata.length < 10 || !template?.allowedSelectors.includes(calldata.slice(0, 10))) {
    throw new Error('action selector is not permitted by the cold template')
  }
  // The prover host decodes the envelope and admission-checks it - chain id,
  // fees, signer, selector - and refuses by name. Only the shape is checked
  // here, so a malformed envelope fails at the coordinator rather than after
  // seventeen seconds of GPU.
  const signedTransaction =
    input.signedTransaction === undefined
      ? undefined
      : cleanHex(input.signedTransaction, null, 'signed transaction')
  if (signedTransaction !== undefined && signedTransaction.length < 2 + MINIMUM_ENVELOPE_BYTES * 2) {
    throw new Error('a signed transaction must carry at least 32 bytes of envelope')
  }
  // Counted over PENDING actions, not every action the room ever accepted: a
  // batch must cover both L2 blocks, so each new batch has to start filling
  // block 1 again. Counting settled actions here would send every move after
  // the first checkpoint to block 2 and no later batch could ever be legal.
  const pending = room.actions.filter((item) => item.checkpointSequence === null)
  const block = input.block ?? presetAction?.recommendedBlock ?? (pending.length === 0 ? 1 : 2)
  if (block !== 1 && block !== 2) throw new Error('action block must be one or two')
  // The cap is per PENDING batch: moves already proved by a checkpoint have
  // left the batch and no longer occupy one of the 32 slots a room block has.
  const pendingInBlock = pending.filter((item) => item.block === block).length
  if (pendingInBlock >= ACTIONS_PER_ROOM_BLOCK) {
    throw new Error('the selected room block already contains 32 actions')
  }
  return {
    id: shortId('act'),
    actionId: input.actionId,
    label: presetAction?.label ?? input.actionId,
    actorId: input.actorId || presetAction?.actor || 'operator',
    calldata,
    ...(presetAction?.fixtureSignerIndex === undefined
      ? {}
      : { fixtureSignerIndex: presetAction.fixtureSignerIndex }),
    ...(presetAction?.gasLimit === undefined ? {} : { gasLimit: presetAction.gasLimit }),
    block,
    acceptedAt: now(),
    ...(signedTransaction === undefined ? {} : { signedTransaction }),
    checkpointSequence: null,
  }
}
