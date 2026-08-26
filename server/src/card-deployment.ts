/**
 * Deploying the five accounts a hidden-card duel room pins, and reading their
 * runtime code back off the chain.
 *
 * WHY A DEPLOYMENT AND NOT AN ARTIFACT READ. `HiddenCardDuelV5`,
 * `CardProofVerifierAdapterV5` and `RoomToken` all carry constructor
 * immutables - the stake token, both proof verifiers, the entry stake and the
 * minter live in CODE, not storage. A Foundry artifact's `deployedBytecode`
 * therefore has zero words exactly where those addresses belong
 * (`immutableReferences` names four spans in the duel alone), so a room built
 * from it would `STATICCALL` `address(0)` for every proof and `transferFrom`
 * a token that does not exist. `v5_fixture/card.rs` says the same thing from
 * the other side: "a duel room's code is the real compiled runtime read back
 * from the chain, never host-synthesized bytecode".
 *
 * The creation bytecode and ABI still come from `contracts/out`, through the
 * same artifact loader the runtime already uses for the room manager and the
 * cold-template registry. Nothing here is hand-pasted hex.
 *
 * WHY THE CACHE. The room's cold template id commits to the duel's address (it
 * is hashed into `proofDomain`, into every stake-token mapping slot and into
 * the certified policy), so preparing and later checkpointing the same template
 * MUST reuse one deployment. A second deployment is a different room.
 */

import { CARD_APPLICATION_DOMAIN } from '@zkdeal/protocol'
import type { Account, Hex, PublicClient, WalletClient } from 'viem'
import { CARD_ROOM_WORKLOAD } from './card-room.js'
import {
  CARD_ROOM_DUELIST_OWNERS,
  CARD_ROOM_ENTRY_STAKE,
  CARD_ROOM_FUNDED_AMOUNT,
  CARD_ROOM_SESSION_EXPIRY,
  type CardRoomAccount,
  type CardRoomDeployment,
} from './card-request.js'
import { presetOf } from './demo-runtime-spec.js'
import type { Artifact } from './demo-runtime-types.js'
import type { DemoCardRoom, DemoTemplate } from './demo-types.js'

/** Everything the deployment needs from the live runtime, and nothing more. */
export interface CardRoomDeployContext {
  publicClient: PublicClient
  wallet: WalletClient
  account: Account
  artifact(name: string, alternatives?: string[]): Promise<Artifact>
}

/** Demo stake-token identity. Only its address and code reach the room. */
const STAKE_TOKEN_NAME = 'Room USD'
const STAKE_TOKEN_SYMBOL = 'rUSD'

async function deployed(
  context: CardRoomDeployContext,
  name: string,
  alternatives: string[],
  args: readonly unknown[],
): Promise<CardRoomAccount> {
  const artifact = await context.artifact(name, alternatives)
  const value = artifact.bytecode
  const bytecode = typeof value === 'string' ? value : value?.object
  if (!bytecode || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length <= 2) {
    throw new Error(`the ${name} artifact has no usable creation bytecode`)
  }
  const hash = await context.wallet.deployContract({
    account: context.account,
    abi: artifact.abi,
    bytecode: bytecode as Hex,
    args: args as never,
    chain: null,
  } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${name} did not deploy on local Ethereum`)
  }
  const runtimeCode = await context.publicClient.getCode({ address: receipt.contractAddress })
  if (!runtimeCode || runtimeCode === '0x') {
    throw new Error(`${name} deployed with empty runtime code`)
  }
  return { address: receipt.contractAddress, runtimeCode }
}

/**
 * Deploy the duel room's accounts once per template and return the descriptor
 * `baseSpec` turns into a `card-duel` request. Returns null - deploying
 * nothing - for every template whose preset is not a duel.
 */
export async function prepareCardRoom(
  template: DemoTemplate,
  context: CardRoomDeployContext,
  cache: Map<string, CardRoomDeployment>,
): Promise<CardRoomDeployment | null> {
  if (presetOf(template)?.workload !== CARD_ROOM_WORKLOAD) return null
  const cached = cache.get(template.id)
  if (cached) return cached
  const deckVerifier = await deployed(context, 'CardDeckInitGroth16VerifierV5', [], [])
  const handVerifier = await deployed(context, 'CardHandActionGroth16VerifierV5', [], [])
  // One adapter owns both generated verifiers, so the cold template pins one
  // adapter address plus two verifier code hashes.
  const adapter = await deployed(
    context,
    'CardProofVerifierAdapterV5',
    ['CardProofVerifierAdapter.sol/CardProofVerifierAdapterV5.json'],
    [deckVerifier.address, handVerifier.address],
  )
  const stakeToken = await deployed(context, 'RoomToken', [], [STAKE_TOKEN_NAME, STAKE_TOKEN_SYMBOL])
  // `CardDuelBaseV5` takes the ADAPTER as both proof verifiers: the duel
  // STATICCALLs `verify(bytes,uint256[])`, and the adapter is what fans that
  // out to the deck and hand circuits.
  const duel = await deployed(
    context,
    'HiddenCardDuelV5',
    ['HiddenCardDuel.sol/HiddenCardDuelV5.json'],
    [
      BigInt(template.participantCapacity),
      stakeToken.address,
      adapter.address,
      adapter.address,
      CARD_ROOM_ENTRY_STAKE,
      CARD_APPLICATION_DOMAIN as Hex,
    ],
  )
  const deployment: CardRoomDeployment = {
    duel,
    adapter,
    deckVerifier,
    handVerifier,
    stakeToken,
    entryStake: CARD_ROOM_ENTRY_STAKE,
    fundedAmount: CARD_ROOM_FUNDED_AMOUNT,
    participantCapacity: template.participantCapacity,
    sessionExpiry: CARD_ROOM_SESSION_EXPIRY,
    roomApplicationDomain: CARD_APPLICATION_DOMAIN as Hex,
  }
  cache.set(template.id, deployment)
  return deployment
}

/**
 * The public half of a deployment, for the prepared-template document.
 *
 * Runtime code is deliberately left out: it is megabytes of hex the browser has
 * no use for, and it is readable from the chain by anyone who wants it. What a
 * client cannot derive - WHICH addresses this template was prepared against -
 * is exactly what is published.
 */
export function cardRoomDocument(deployment: CardRoomDeployment): DemoCardRoom {
  return {
    duelAddress: deployment.duel.address,
    stakeTokenAddress: deployment.stakeToken.address,
    proofAdapterAddress: deployment.adapter.address,
    deckVerifierAddress: deployment.deckVerifier.address,
    handVerifierAddress: deployment.handVerifier.address,
    roomApplicationDomain: deployment.roomApplicationDomain,
    entryStake: deployment.entryStake.toString(10),
    fundedAmount: deployment.fundedAmount.toString(10),
    sessionExpiry: deployment.sessionExpiry,
    participantCapacity: deployment.participantCapacity,
    duelistOwners: [...CARD_ROOM_DUELIST_OWNERS],
  }
}

/**
 * Rebuild a deployment from a published document by reading each account's
 * runtime code back off the chain.
 *
 * WHY THIS EXISTS. The deployment cache is process memory. A coordinator that
 * restarted mid-room used to have no way back to the duel it had already
 * registered a cold template for, so the room's next checkpoint failed with
 * "a card-duel room request needs the deployed duel ..." and a long-lived room
 * was only as long-lived as the process. The addresses are on L1 and the code
 * is at those addresses, so nothing has to be remembered - only re-read.
 *
 * A missing or empty account is a loud failure: continuing with `0x` would
 * prepare a room whose contracts have no code and whose cold template id
 * therefore differs from the registered one.
 */
export async function restoreCardRoom(
  document: DemoCardRoom,
  context: Pick<CardRoomDeployContext, 'publicClient'>,
): Promise<CardRoomDeployment> {
  const account = async (role: string, address: string): Promise<CardRoomAccount> => {
    const runtimeCode = await context.publicClient.getCode({ address: address as Hex })
    if (!runtimeCode || runtimeCode === '0x') {
      throw new Error(
        `the card room's '${role}' account at ${address} holds no runtime code on this chain. ` +
          'This template was prepared against a different deployment, so its cold template id ' +
          'cannot be reproduced and no checkpoint was attempted.',
      )
    }
    return { address: address as Hex, runtimeCode }
  }
  return {
    duel: await account('duel', document.duelAddress),
    adapter: await account('adapter', document.proofAdapterAddress),
    deckVerifier: await account('deckVerifier', document.deckVerifierAddress),
    handVerifier: await account('handVerifier', document.handVerifierAddress),
    stakeToken: await account('stakeToken', document.stakeTokenAddress),
    entryStake: BigInt(document.entryStake),
    fundedAmount: BigInt(document.fundedAmount),
    participantCapacity: document.participantCapacity,
    sessionExpiry: document.sessionExpiry,
    roomApplicationDomain: document.roomApplicationDomain as Hex,
  }
}
