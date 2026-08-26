import { roomChainIdV5 } from '@zkdeal/protocol'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Erc4626RoomDeployment } from './erc4626-request.js'
import type { DemoAction, DemoRoom } from './demo-types.js'

function fixtureKey(index: number): Hex {
  if (!Number.isInteger(index) || index < 0) throw new Error('fixture signer index is invalid')
  return `0x${BigInt(index + 1).toString(16).padStart(64, '0')}` as Hex
}

/**
 * Convert the canned ERC-4626 calls into the same client-signed envelopes the
 * continuation path replays. Persisting the exact bytes on each action makes
 * checkpoint two and three reconstruct checkpoints one and two byte-for-byte.
 */
export async function signErc4626CheckpointActions(
  room: DemoRoom,
  actions: readonly DemoAction[],
  deploymentDomain: Hex,
  deployment: Erc4626RoomDeployment,
): Promise<void> {
  if (!room.chainRoomId) throw new Error('the ERC-4626 room must be deployed before signing')
  const derived = roomChainIdV5(deploymentDomain, BigInt(room.chainRoomId))
  if (derived > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the room chain id is not a safe integer')
  const chainId = Number(derived)
  for (const action of actions) {
    if (action.signedTransaction) continue
    const signerIndex = action.fixtureSignerIndex
    if (signerIndex === undefined || action.gasLimit === undefined) {
      throw new Error(`ERC-4626 action ${action.actionId} has no fixture signer or gas bound`)
    }
    const position = room.actions.findIndex((candidate) => candidate.id === action.id)
    if (position < 0) throw new Error(`ERC-4626 action ${action.id} is absent from the room log`)
    const nonce = room.actions
      .slice(0, position)
      .filter((candidate) => candidate.fixtureSignerIndex === signerIndex).length
    const account = privateKeyToAccount(fixtureKey(signerIndex))
    action.signedTransaction = await account.signTransaction({
      type: 'eip1559',
      chainId,
      nonce,
      to: deployment.vault.address,
      value: 0n,
      data: action.calldata as Hex,
      gas: BigInt(action.gasLimit),
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      accessList: [],
    })
  }
}
