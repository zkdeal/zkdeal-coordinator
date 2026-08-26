/**
 * THE OWNERSHIP CHAIN, walked with real cryptography rather than asserted.
 *
 * `owner` is a public input of the card circuits (`CardDuelLibV5` puts it at
 * index 2, `inputs[2] = uint256(uint160(player))`) AND the address the L2
 * contract authenticates a move against. Four different addresses have to be
 * one address for a duel move to settle, and a mismatch fails nowhere useful:
 * the envelope is admitted at the edge, the batch is proved, and the guest
 * rejects it partway through a seventeen-second GPU run with no address in the
 * message.
 *
 * The four links, in the order a move travels them:
 *
 *   1. the key the browser signs with  - `cardRoomFixtureSigner(seat)` here,
 *      `cardDemoSeatKey(seat)` in `web/lib/card/identity.ts`, and
 *      `roster_signing_key(index)` in `v5_fixture/signing.rs`: all three are
 *      the 32-byte big-endian integer `seat + 1`;
 *   2. the address the room's COLD STATE funds and grants an ERC-20 allowance
 *      to - `CARD_ROOM_DUELIST_OWNERS`, which
 *      `buildCardStakeTokenStorage` writes into the opening storage. An
 *      envelope from any other key cannot pass `registerDuelist`'s
 *      `transferFrom`, whatever it proves;
 *   3. the address the envelope RECOVERS to, which is `msg.sender` inside the
 *      L2 EVM and therefore `participant.owner`, since
 *      `MerkleParticipants._registerParticipant` writes `owner: msg.sender`
 *      into the leaf and `participantHash` commits it to `participantRoot`;
 *   4. the Groth16 public input, because `CardDuelBase._seat` copies
 *      `seat.owner = player.owner` off the authorized leaf and
 *      `handActionInputs` publishes `seat.owner` as input 2.
 *
 * Every value below is computed, never pasted, except the two literal
 * addresses - which are pinned deliberately, so that a change to the
 * derivation is a failure here rather than a silent move to a seat the cold
 * state does not fund.
 */

import { describe, expect, it } from 'vitest'
import { participantLeafHash } from '@zkdeal/protocol'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  cardRoomFixtureSigner,
  CARD_ROOM_DUELIST_OWNERS,
  CARD_ROOM_ENTRY_STAKE,
} from '../src/card-request.js'

/** `MerkleParticipants._registerParticipant`'s entry point on the duel. */
const REGISTER_ABI = [
  {
    type: 'function',
    name: 'registerDuelist',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'index', type: 'uint64' },
      { name: 'sessionKey', type: 'address' },
      { name: 'sessionExpiry', type: 'uint64' },
      { name: 'fundedAmount', type: 'uint256' },
      { name: 'emptyLeafProof', type: 'bytes32[]' },
    ],
    outputs: [{ type: 'tuple', components: [] }],
  },
] as const

const DUEL = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Hex
const EXPIRY = 4_102_444_800n
const ZERO32 = `0x${'00'.repeat(32)}` as Hex
const SEATS = [0, 1] as const

/** The two well-known demo addresses, spelled out once so a drift is loud. */
const PINNED = [
  '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF',
] as const

/** Sign one real `registerDuelist` envelope for `seat` and recover its sender. */
async function signedRegistration(seat: number) {
  const account = privateKeyToAccount(numberToHex(BigInt(seat) + 1n, { size: 32 }))
  const calldata = encodeFunctionData({
    abi: REGISTER_ABI,
    functionName: 'registerDuelist',
    args: [BigInt(seat), account.address, EXPIRY, CARD_ROOM_ENTRY_STAKE, []],
  })
  const envelope = await account.signTransaction({
    type: 'eip1559',
    chainId: 424_242,
    nonce: 0,
    to: DUEL,
    value: 0n,
    gas: 700_000n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    accessList: [],
    data: calldata,
  })
  const sender = await recoverTransactionAddress({ serializedTransaction: envelope as `0x02${string}` })
  return { account, calldata, envelope, sender }
}

describe('the card room ownership chain', () => {
  it.each(SEATS)('holds unbroken for seat %i', async (seat) => {
    // LINK 1 -> LINK 2. The key the browser signs with derives the address the
    // cold state funds. Both sides derive it; neither pastes it.
    const account = privateKeyToAccount(numberToHex(BigInt(seat) + 1n, { size: 32 }))
    expect(cardRoomFixtureSigner(seat)).toBe(account.address)
    expect(CARD_ROOM_DUELIST_OWNERS[seat]).toBe(account.address)
    expect(account.address).toBe(PINNED[seat])

    // LINK 2 -> LINK 3. A real envelope, recovered the way the L2 EVM recovers
    // it before it sets `msg.sender`.
    const { calldata, envelope, sender } = await signedRegistration(seat)
    expect(sender).toBe(account.address)
    // The envelope carries the move it claims to carry, to this duel, unpaid.
    const decoded = parseTransaction(envelope)
    expect(decoded.data).toBe(calldata)
    expect(decoded.to?.toLowerCase()).toBe(DUEL.toLowerCase())
    expect(decoded.value ?? 0n).toBe(0n)

    // LINK 3 -> the participant leaf. `_registerParticipant` writes
    // `owner: msg.sender`, so the leaf is rebuilt from the RECOVERED address.
    const leaf = {
      index: BigInt(seat),
      owner: sender,
      sessionKey: sender,
      sessionExpiry: EXPIRY,
      spendLimit: CARD_ROOM_ENTRY_STAKE,
      paymentSpent: 0n,
      itemBalance: 0n,
      nonce: 0n,
      applicationData: ZERO32,
      active: true,
    }
    // Independently recomputed as the exact `abi.encode` in
    // `MerkleParticipants.participantHash`, so the mirror is checked against
    // the contract's own encoding rather than against itself.
    const solidity = keccak256(
      encodeAbiParameters(
        [
          { type: 'uint64' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint64' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint64' },
          { type: 'bytes32' },
          { type: 'bool' },
        ],
        [BigInt(seat), sender, sender, EXPIRY, CARD_ROOM_ENTRY_STAKE, 0n, 0n, 0n, ZERO32, true],
      ),
    )
    expect(participantLeafHash(leaf).toLowerCase()).toBe(solidity.toLowerCase())

    // the leaf -> LINK 4. `_seat` copies `seat.owner = player.owner` and
    // `handActionInputs` publishes it as `inputs[2] = uint160(player)`.
    expect(BigInt(leaf.owner).toString(10)).toBe(BigInt(sender).toString(10))
    expect(BigInt(sender) >> 160n).toBe(0n)
  })

  it('seats two DIFFERENT owners, which joinDuel requires', () => {
    expect(CARD_ROOM_DUELIST_OWNERS[0]).not.toBe(CARD_ROOM_DUELIST_OWNERS[1])
    expect(new Set(CARD_ROOM_DUELIST_OWNERS).size).toBe(CARD_ROOM_DUELIST_OWNERS.length)
  })

  it('breaks visibly when the signing key is not the seat key', async () => {
    // The failure this whole chain exists to prevent: seat 0's proof commits to
    // seat 0's owner while seat 1's key signs the envelope. Nothing at the edge
    // notices; the guest rejects the batch. Pinned here so it stays a test
    // rather than a seventeen-second GPU run.
    const impostor = await signedRegistration(1)
    expect(impostor.sender).not.toBe(CARD_ROOM_DUELIST_OWNERS[0])
    expect(BigInt(impostor.sender).toString(10)).not.toBe(
      BigInt(CARD_ROOM_DUELIST_OWNERS[0]).toString(10),
    )
  })
})
