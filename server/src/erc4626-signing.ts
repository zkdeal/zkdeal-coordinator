import type { Hex } from 'viem'
import type { Erc4626RoomDeployment } from './erc4626-request.js'
import type { DemoAction, DemoRoom } from './demo-types.js'
import { signFixtureCheckpointActions } from './fixture-signing.js'

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
  await signFixtureCheckpointActions(room, actions, deploymentDomain, {
    label: 'ERC-4626',
    target: deployment.vault.address,
  })
}
