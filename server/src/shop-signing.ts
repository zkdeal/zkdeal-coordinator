import type { Hex } from 'viem'
import type { DemoAction, DemoRoom } from './demo-types.js'
import {
  legacyFixtureContractAddress,
  signFixtureCheckpointActions,
} from './fixture-signing.js'

export const SHOP_PRESET_ID = 'shop'
export const SHOP_FIXTURE_CONTRACT = legacyFixtureContractAddress()

/**
 * Make the canned persistent-shop path replayable from its first checkpoint.
 *
 * The historic shop request used two host-synthesized `blockCalls`, both from
 * fixture signer zero at 120,000 gas. Those calls were provable once but their
 * signed bytes never reached the room log, so a second checkpoint had nothing
 * exact to replay. Signing the same calls here preserves the opening behavior
 * and gives every later checkpoint the byte-for-byte history it needs.
 */
export async function signShopCheckpointActions(
  room: DemoRoom,
  actions: readonly DemoAction[],
  deploymentDomain: Hex,
): Promise<void> {
  const signed = actions.filter((action) => typeof action.signedTransaction === 'string').length
  if (signed > 0 && signed !== actions.length) {
    throw new Error(
      'a shop checkpoint cannot mix client-signed and canned unsigned actions; sign the whole batch or let the fixture signer sign it',
    )
  }
  if (signed === actions.length) return
  await signFixtureCheckpointActions(room, actions, deploymentDomain, {
    label: 'shop',
    target: SHOP_FIXTURE_CONTRACT,
    defaultSignerIndex: 0,
    defaultGasLimit: 120_000,
  })
}
