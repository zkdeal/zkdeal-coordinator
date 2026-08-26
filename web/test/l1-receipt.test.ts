import { describe, expect, it } from 'vitest'
import { l1ReceiptLabel, l1ReceiptLink, l1Receipt } from '../lib/l1-receipt'
import { cardCheckpointReceipt, cardRoomCheckpoints } from '../lib/card/settlement'
import {
  demoCheckpointEntry,
  demoDeploymentEntry,
  demoRoomCheckpoints,
} from '../lib/applications/log'
import type { Room } from '../components/demo-console/api'

/**
 * The rule every action log on this site depends on.
 *
 * A row that says "on L1" is a claim, and a claim like that is only worth
 * making if a viewer can check it INDEPENDENTLY. So the only two outcomes
 * allowed here are:
 *
 *   - a complete 32-byte hash, rendered whole, linked into the explorer the
 *     COORDINATOR advertises; or
 *   - an explicit statement that it cannot be looked up, and NO link.
 *
 * The thing this suite exists to prevent is the third outcome: an anchor whose
 * href carries the coordinator's abbreviation. `publicDemoView` truncates every
 * long hex string it publishes, so `0x05d3ac...ce78` is exactly what a naive
 * reader would put in a link, and it is a 404 dressed as evidence.
 */

const FULL = '0x07fe97e390d52372ff7d59750b477fb9179f38756cfc93bc417ad34f81fec66b'
const ABBREVIATED = '0x07fe97...c66b'
const EXPLORER = 'http://192.168.0.11:3200'

describe('an L1 receipt', () => {
  it('prefers the hash the coordinator publishes whole', () => {
    const receipt = l1Receipt({ hash: FULL, transaction: ABBREVIATED }, EXPLORER)
    expect(receipt.complete).toBe(true)
    expect(receipt.hash).toBe(FULL)
    expect(receipt.note).toBeNull()
    expect(receipt.url).toBe(`${EXPLORER}/tx/${FULL}`)
  })

  it('recovers the full hash out of the explorer URL when no whole field exists', () => {
    const receipt = l1Receipt(
      { transaction: ABBREVIATED, explorerUrl: `${EXPLORER}/tx/${FULL}` },
      EXPLORER,
    )
    expect(receipt.complete).toBe(true)
    expect(receipt.hash).toBe(FULL)
    // The coordinator's own URL wins, because it is the destination the
    // operator configured for this stand.
    expect(receipt.url).toBe(`${EXPLORER}/tx/${FULL}`)
  })

  it('refuses to link an abbreviation, and says why instead', () => {
    const receipt = l1Receipt({ transaction: ABBREVIATED }, EXPLORER)
    expect(receipt.complete).toBe(false)
    expect(receipt.url).toBeNull()
    expect(receipt.note).toMatch(/abbreviated/i)
    // And nothing downstream can turn it into an anchor.
    expect(l1ReceiptLink(receipt)).toBeNull()
  })

  it('takes the explorer base from the coordinator and never from a constant', () => {
    // Two different stands, one build. Neither host appears anywhere but in the
    // value the caller was handed.
    const first = l1Receipt({ hash: FULL }, 'http://192.168.0.11:3200')
    const second = l1Receipt({ hash: FULL }, 'https://explorer.example.test/')
    expect(first.url).toBe(`http://192.168.0.11:3200/tx/${FULL}`)
    expect(second.url).toBe(`https://explorer.example.test/tx/${FULL}`)

    // A coordinator that advertises no explorer yields no link and says so,
    // rather than defaulting to somebody else's host.
    const none = l1Receipt({ hash: FULL }, null)
    expect(none.complete).toBe(true)
    expect(none.url).toBeNull()
    expect(none.note).toMatch(/no block explorer/i)
  })

  it('drops a link destination that is not http(s)', () => {
    const receipt = l1Receipt(
      { hash: FULL, explorerUrl: `javascript:alert(1)//${FULL}` },
      null,
    )
    expect(receipt.url).toBeNull()
  })

  it('abbreviates only the visible label, never the href', () => {
    const receipt = l1Receipt({ hash: FULL }, EXPLORER)
    const link = l1ReceiptLink(receipt)!
    expect(link.text).toBe(l1ReceiptLabel(FULL))
    expect(link.text.length).toBeLessThan(FULL.length)
    // The two places a reader or a script can recover the whole hash from.
    expect(link.href).toContain(FULL)
    expect(link.title).toBe(FULL)
  })
})

describe('a landed action renders a link carrying the full hash', () => {
  it('for a checkpoint in an application room', () => {
    const entry = demoCheckpointEntry(
      {
        transaction: ABBREVIATED,
        l1TransactionHash: FULL,
        l1Block: '492',
        proofMs: 63_261,
        explorerUrl: `${EXPLORER}/tx/${FULL}`,
      },
      EXPLORER,
      'the auction cleared',
    )
    expect(entry.status).toBe('landed')
    const link = l1ReceiptLink(entry.receipt!)!
    expect(link.href).toContain(FULL)
    expect(link.title).toBe(FULL)
    expect(entry.title).toContain('492')
  })

  it('for a checkpoint in the hidden-card duel', () => {
    const receipt = cardCheckpointReceipt(
      { transaction: ABBREVIATED, l1TransactionHash: FULL, explorerUrl: null },
      EXPLORER,
    )
    expect(receipt.complete).toBe(true)
    // The duel's historical field name and the shared one are the same value.
    expect(receipt.transaction).toBe(FULL)
    expect(receipt.hash).toBe(FULL)
    expect(l1ReceiptLink(receipt)!.href).toContain(FULL)
  })

  it('for the room deployment, or says the hash cannot be looked up', () => {
    const room = {
      id: 'room-d9a6ea2a0e',
      name: 'Card duel live',
      chainRoomId: '2',
      deploymentTransaction: '0x05d3ac...ce78',
      actions: [],
    } as unknown as Room

    // As the coordinator publishes it today: abbreviated, no link beside it.
    const asPublished = demoDeploymentEntry(room, EXPLORER)
    expect(asPublished.status).toBe('landed')
    expect(asPublished.receipt!.complete).toBe(false)
    expect(l1ReceiptLink(asPublished.receipt!)).toBeNull()
    expect(asPublished.receipt!.note).toMatch(/cannot be looked up/i)

    // And the moment it publishes the hash whole, the same row becomes a link
    // with no other change anywhere.
    const upgraded = demoDeploymentEntry(
      { ...room, deploymentTransactionHash: FULL },
      EXPLORER,
    )
    expect(l1ReceiptLink(upgraded.receipt!)!.href).toContain(FULL)
    expect(upgraded.title).toContain('#2')
  })
})

describe('checkpoint attempts are not checkpoint receipts', () => {
  // `/demo/v1/rooms/:id` publishes `checkpoints` as ATTEMPTS: sequence, the
  // action ids it tried to prove, an outcome, and a `result` only once one was
  // accepted. Read as receipts they produce "L1 block undefined" and a hash
  // nobody can look up, which is precisely the claim this whole module refuses.
  const accepted = {
    sequence: 1,
    outcome: 'ACCEPTED' as const,
    actionIds: ['act-1'],
    result: {
      transaction: ABBREVIATED,
      l1TransactionHash: FULL,
      l1Block: '492',
      proofMs: 63_261,
      localVerificationMs: 5,
      postStateRoot: '0x33ba35',
      explorerUrl: `${EXPLORER}/tx/${FULL}`,
    },
  }
  const running = { sequence: 2, outcome: 'RUNNING' as const, actionIds: ['act-2'] }

  it('unwraps accepted attempts and drops the ones still running', () => {
    expect(cardRoomCheckpoints({ checkpoints: [accepted, running] })).toEqual([accepted.result])
    expect(demoRoomCheckpoints({ checkpoints: [accepted, running] })).toEqual([accepted.result])
  })

  it('still accepts a flat list of receipts', () => {
    expect(cardRoomCheckpoints({ checkpoints: [accepted.result] })).toEqual([accepted.result])
    expect(demoRoomCheckpoints({ checkpoints: [accepted.result] })).toEqual([accepted.result])
  })

  it('falls back to the latest receipt while every attempt is still running', () => {
    expect(cardRoomCheckpoints({ checkpoint: accepted.result, checkpoints: [running] })).toEqual([
      accepted.result,
    ])
    expect(
      demoRoomCheckpoints({ checkpoint: accepted.result, checkpoints: [running] }),
    ).toEqual([accepted.result])
  })
})
