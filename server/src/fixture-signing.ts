import { concat, keccak256, pad, stringToBytes, toBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { roomChainIdV5 } from '@zkdeal/protocol'
import type { DemoAction, DemoRoom } from './demo-types.js'

function fixtureKey(index: number): Hex {
  if (!Number.isInteger(index) || index < 0) throw new Error('fixture signer index is invalid')
  return `0x${BigInt(index + 1).toString(16).padStart(64, '0')}` as Hex
}

/**
 * The implicit clone address used by the prover host's legacy request shape.
 *
 * Mirrors `fixture_address(b"room-contract", index)` in
 * `zkdeal-prover/zkvm/crates/risc0/host/src/v5_fixture/bytecode.rs`. Keeping the
 * derivation here, instead of pinning an unexplained address literal, lets the
 * coordinator sign the exact transaction the host used to synthesize from a
 * `blockCalls` request.
 */
export function legacyFixtureContractAddress(index = 0): Hex {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('fixture contract index is invalid')
  }
  const digest = keccak256(
    concat([stringToBytes('room-contract'), pad(toBytes(BigInt(index)), { size: 8 })]),
  )
  return `0x${digest.slice(-40)}` as Hex
}

export interface FixtureSigningOptions {
  label: string
  target: Hex
  defaultSignerIndex?: number
  defaultGasLimit?: number
}

/**
 * Turn deterministic preset calls into replayable EIP-2718 envelopes.
 *
 * The prover's continuation request is stateless: it rebuilds batch N by
 * replaying every earlier envelope before executing the two new blocks. The
 * signed bytes therefore live on the actions themselves and nonces are counted
 * over the room's complete, append-only action log.
 */
export async function signFixtureCheckpointActions(
  room: DemoRoom,
  actions: readonly DemoAction[],
  deploymentDomain: Hex,
  options: FixtureSigningOptions,
): Promise<void> {
  if (!room.chainRoomId) throw new Error(`the ${options.label} room must be deployed before signing`)
  const derived = roomChainIdV5(deploymentDomain, BigInt(room.chainRoomId))
  if (derived > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the room chain id is not a safe integer')
  const chainId = Number(derived)
  const signerOf = (action: DemoAction): number | undefined =>
    action.fixtureSignerIndex ?? options.defaultSignerIndex

  for (const action of actions) {
    if (action.signedTransaction) continue
    const signerIndex = signerOf(action)
    const gasLimit = action.gasLimit ?? options.defaultGasLimit
    if (signerIndex === undefined || gasLimit === undefined) {
      throw new Error(`${options.label} action ${action.actionId} has no fixture signer or gas bound`)
    }
    if (!Number.isInteger(gasLimit) || gasLimit <= 0) {
      throw new Error(`${options.label} action ${action.actionId} has an invalid gas bound`)
    }
    const position = room.actions.findIndex((candidate) => candidate.id === action.id)
    if (position < 0) throw new Error(`${options.label} action ${action.id} is absent from the room log`)
    const nonce = room.actions
      .slice(0, position)
      .filter((candidate) => signerOf(candidate) === signerIndex).length
    const account = privateKeyToAccount(fixtureKey(signerIndex))
    action.signedTransaction = await account.signTransaction({
      type: 'eip1559',
      chainId,
      nonce,
      to: options.target,
      value: 0n,
      data: action.calldata as Hex,
      gas: BigInt(gasLimit),
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      accessList: [],
    })
  }
}
