/**
 * Which duel contract the console signs for, and where that address comes
 * from.
 *
 * THE FAILURE THIS EXISTS FOR. The duel's address is a public input, not just a
 * destination: `proofDomain` - public input 0 of every card circuit - is
 * `keccak256(abi.encode(roomApplicationDomain, duel)) % p`, written by
 * `HiddenCardDuelV5`'s constructor, and the cold template id commits to it. A
 * console pointed at the wrong address therefore signs envelopes for the wrong
 * contract AND produces proofs bound to the wrong domain. Neither is visible at
 * the edge: the move is admitted, the batch is proved, and the guest rejects it
 * partway through a seventeen-second GPU run.
 *
 * The coordinator now publishes the address it prepared the template against
 * (`DemoPreparedTemplate.cardRoom`), exempt from the response redaction that
 * truncates every other long hex string. This pins that the console adopts a
 * published address, refuses a malformed or truncated one rather than signing
 * for it, and reports honestly when there is none.
 */

import { describe, expect, it } from 'vitest'
import { cardRoomTemplate } from '../lib/card/demo-room'
import { cardDemoIdentity } from '../lib/card/identity'
import type { PreparedCardRoom, Template } from '@/components/demo-console/api'

const DEPLOYED = '0x8464135c8F25Da09e49BC8782676a84730C318bC'
const DOMAIN = `0x${'c1'.repeat(32)}`

function cardRoom(overrides: Partial<PreparedCardRoom> = {}): PreparedCardRoom {
  return {
    duelAddress: DEPLOYED,
    stakeTokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    proofAdapterAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    deckVerifierAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    handVerifierAddress: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    roomApplicationDomain: DOMAIN,
    entryStake: '1000000000000000000',
    fundedAmount: '4000000000000000000',
    sessionExpiry: 2_000_000_000,
    participantCapacity: 128,
    duelistOwners: [
      '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF',
    ],
    ...overrides,
  }
}

function template(cardRoomDocument?: PreparedCardRoom): Template {
  return {
    id: 'tpl-card',
    name: 'Hidden card duel',
    presetId: 'card-game',
    source: 'preset',
    phase: 'ROOM_READY',
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 128,
    activeApprovers: 0,
    selectedState: [],
    preparation: {
      templateId: `0x${'ab'.repeat(32)}`,
      coldProofMs: 1,
      registrationTransaction: `0x${'cd'.repeat(32)}`,
      contractAddress: null,
      ...(cardRoomDocument ? { cardRoom: cardRoomDocument } : {}),
    },
  } as Template
}

describe('the duel address a card template names', () => {
  it('is taken from the coordinator, not from the console default', () => {
    const read = cardRoomTemplate(template(cardRoom()))
    expect(read.duelAddress).toBe(DEPLOYED)
    expect(read.roomApplicationDomain).toBe(DOMAIN)
    expect(read.id).toBe('tpl-card')
    expect(read.name).toBe('Hidden card duel')
    // It really is a different contract from the console's built-in default,
    // so adopting it changes public input 0.
    expect(read.duelAddress).not.toBe(cardDemoIdentity().duelAddress)
  })

  it('changes proofDomain, which is the whole reason it must not be guessed', () => {
    const published = cardDemoIdentity(DEPLOYED)
    const defaulted = cardDemoIdentity()
    expect(published.proofDomainField).not.toBe(defaulted.proofDomainField)
    // Same address in, same domain out: the derivation is a pure function of
    // the address, so adopting the published one is the whole fix.
    expect(cardDemoIdentity(DEPLOYED).proofDomainField).toBe(published.proofDomainField)
  })

  it('is null, not a guess, when the coordinator publishes no card room', () => {
    const read = cardRoomTemplate(template())
    expect(read.duelAddress).toBeNull()
    expect(read.roomApplicationDomain).toBeNull()
  })

  it('refuses a redacted address rather than signing for it', () => {
    // What `publicDemoView` produces for any long hex NOT on its published-in-
    // full list. Signing `to = 0x846413...18bC` is not a wrong address, it is
    // not an address, and it must never reach a transaction.
    const truncated = `${DEPLOYED.slice(0, 8)}...${DEPLOYED.slice(-4)}`
    expect(cardRoomTemplate(template(cardRoom({ duelAddress: truncated }))).duelAddress).toBeNull()
  })

  it('refuses malformed addresses and domains of the wrong width', () => {
    const cases = ['', '0x', DEPLOYED.slice(0, -2), `${DEPLOYED}00`, 'not an address']
    for (const duelAddress of cases) {
      expect(cardRoomTemplate(template(cardRoom({ duelAddress }))).duelAddress).toBeNull()
    }
    for (const roomApplicationDomain of ['0x', DOMAIN.slice(0, -2), `${DOMAIN}ff`]) {
      expect(
        cardRoomTemplate(template(cardRoom({ roomApplicationDomain }))).roomApplicationDomain,
      ).toBeNull()
    }
  })

  it('rejects a non-string address that survived JSON', () => {
    const broken = cardRoom()
    // A coordinator that answered `null` or a number must not become `"null"`.
    expect(
      cardRoomTemplate(template({ ...broken, duelAddress: null as never })).duelAddress,
    ).toBeNull()
    expect(
      cardRoomTemplate(template({ ...broken, duelAddress: 1234 as never })).duelAddress,
    ).toBeNull()
  })
})
