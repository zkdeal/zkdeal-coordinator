/**
 * Publishing the duel a card template was prepared against - and getting back
 * to it after the process that deployed it is gone.
 *
 * TWO FAILURES THIS COVERS, both silent and both fatal.
 *
 * 1. A CONSOLE THAT HAS TO GUESS. A duel move is signed with `to = duel`, and
 *    `proofDomain` - public input 0 of every card circuit - is
 *    `keccak256(abi.encode(roomApplicationDomain, duel)) % p`. Nothing on
 *    `/demo/v1` used to carry the deployed address, so an operator had to type
 *    it in; a wrong address means every envelope targets the wrong contract AND
 *    every proof commits to the wrong domain, and neither is visible until the
 *    guest rejects the batch. Publishing it is only useful if it survives the
 *    response redaction, which truncates every long hex string by default - a
 *    `0x5FbDB2...0aa3` is a fine thing to print and a useless thing to sign for.
 *
 * 2. A ROOM THAT DIES WITH THE PROCESS. The deployment cache is process memory.
 *    A restarted coordinator could not checkpoint an existing card room at all,
 *    which makes "long-lived room" untrue in the one way that matters. The
 *    addresses are on L1 and the code is at those addresses, so the deployment
 *    is re-readable rather than re-rememberable.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { cardRoomDocument, restoreCardRoom } from '../src/card-deployment.js'
import { CARD_ROOM_DUELIST_OWNERS } from '../src/card-request.js'
import { publicDemoView } from '../src/demo-routes.js'
import { cardRoomFixture } from './helpers/card-room-fixture.js'

/** A chain that answers `getCode` from a table, and nothing else. */
function chain(code: Record<string, string>) {
  return {
    publicClient: {
      getCode: async ({ address }: { address: Hex }) => code[address.toLowerCase()],
    },
  } as never
}

function chainHolding(deployment = cardRoomFixture()) {
  return chain({
    [deployment.duel.address.toLowerCase()]: deployment.duel.runtimeCode,
    [deployment.adapter.address.toLowerCase()]: deployment.adapter.runtimeCode,
    [deployment.deckVerifier.address.toLowerCase()]: deployment.deckVerifier.runtimeCode,
    [deployment.handVerifier.address.toLowerCase()]: deployment.handVerifier.runtimeCode,
    [deployment.stakeToken.address.toLowerCase()]: deployment.stakeToken.runtimeCode,
  })
}

describe('the published card-room document', () => {
  it('names every address a console has to address, and the domain behind proofDomain', () => {
    const deployment = cardRoomFixture()
    const document = cardRoomDocument(deployment)
    expect(document.duelAddress).toBe(deployment.duel.address)
    expect(document.stakeTokenAddress).toBe(deployment.stakeToken.address)
    expect(document.proofAdapterAddress).toBe(deployment.adapter.address)
    expect(document.deckVerifierAddress).toBe(deployment.deckVerifier.address)
    expect(document.handVerifierAddress).toBe(deployment.handVerifier.address)
    expect(document.roomApplicationDomain).toBe(deployment.roomApplicationDomain)
    // The seats the cold state funds, so a console can say which one it plays.
    expect(document.duelistOwners).toEqual([...CARD_ROOM_DUELIST_OWNERS])
  })

  it('carries the escrow terms as decimal strings, because JSON has no bigint', () => {
    const deployment = cardRoomFixture()
    const document = cardRoomDocument(deployment)
    expect(BigInt(document.entryStake)).toBe(deployment.entryStake)
    expect(BigInt(document.fundedAmount)).toBe(deployment.fundedAmount)
    expect(document.sessionExpiry).toBe(deployment.sessionExpiry)
    expect(document.participantCapacity).toBe(deployment.participantCapacity)
    // Survives a JSON round trip unchanged; it is a response body.
    expect(JSON.parse(JSON.stringify(document))).toEqual(document)
  })

  it('publishes no runtime code: it is megabytes the browser cannot use', () => {
    const serialized = JSON.stringify(cardRoomDocument(cardRoomFixture()))
    expect(serialized).not.toContain('runtimeCode')
    // The duel's real compiled body must not be in there either.
    const body = cardRoomFixture().duel.runtimeCode.slice(2, 42)
    expect(serialized.toLowerCase()).not.toContain(body.toLowerCase())
  })
})

describe('the response redaction', () => {
  it('leaves every card-room address whole, because they are signed for', () => {
    const document = cardRoomDocument(cardRoomFixture())
    const published = publicDemoView({ preparation: { cardRoom: document } }).preparation.cardRoom
    expect(published.duelAddress).toBe(document.duelAddress)
    expect(published.roomApplicationDomain).toBe(document.roomApplicationDomain)
    expect(published.stakeTokenAddress).toBe(document.stakeTokenAddress)
    expect(published.proofAdapterAddress).toBe(document.proofAdapterAddress)
    expect(published.duelistOwners).toEqual(document.duelistOwners)
    // Nothing truncated: an ellipsis anywhere here is an unusable address.
    expect(JSON.stringify(published)).not.toContain('...')
  })

  it('still truncates the long identifiers it always did', () => {
    const root = `0x${'ab'.repeat(32)}`
    const view = publicDemoView({ initialStateRoot: root, l1TransactionHash: root })
    expect(view.initialStateRoot).not.toBe(root)
    expect(view.initialStateRoot).toContain('...')
    expect(view.l1TransactionHash).toBe(root)
  })
})

describe('restoring a deployment after a coordinator restart', () => {
  it('reproduces the exact deployment by reading code back off the chain', async () => {
    const deployment = cardRoomFixture()
    const restored = await restoreCardRoom(cardRoomDocument(deployment), chainHolding())
    expect(restored).toEqual(deployment)
  })

  it('refuses an address that holds no code, naming the role and the address', async () => {
    const deployment = cardRoomFixture()
    const missing = chain({
      [deployment.duel.address.toLowerCase()]: deployment.duel.runtimeCode,
      [deployment.adapter.address.toLowerCase()]: '0x',
    })
    await expect(restoreCardRoom(cardRoomDocument(deployment), missing)).rejects.toThrow(
      new RegExp(`'adapter' account at ${deployment.adapter.address} holds no runtime code`),
    )
  })

  it('refuses an address the chain does not know at all', async () => {
    await expect(
      restoreCardRoom(cardRoomDocument(cardRoomFixture()), chain({})),
    ).rejects.toThrow(/holds no runtime code on this chain/)
  })
})
