/**
 * The single proving slot.
 *
 * The stand has ONE GPU. These tests are about the property that matters:
 * whatever the arrival order, no two proofs ever overlap, and a caller that has
 * to wait can be told where it is in the line.
 */

import { describe, expect, it } from 'vitest'
import { ProvingSlot } from '../src/demo-proving-queue.js'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('the single proving slot', () => {
  it('never runs two proofs at once', async () => {
    const slot = new ProvingSlot()
    let concurrent = 0
    let peak = 0
    const order: string[] = []
    const work = (id: string) => async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(id)
      concurrent -= 1
    }
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        slot.run({ id, kind: 'CHECKPOINT_ROOM', subjectId: `room-${id}` }, work(id)),
      ),
    )
    expect(peak).toBe(1)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(slot.status()).toEqual({ active: null, waiting: [] })
  })

  it('reports the position of a proof that has to wait', async () => {
    const slot = new ProvingSlot()
    const first = deferred()
    const positions: Record<string, number> = {}
    const started = slot.run({ id: 'first', kind: 'PREPARE_TEMPLATE', subjectId: 'tpl-1' }, () =>
      first.promise,
    )
    // Let the first entry take the slot before the others arrive.
    await new Promise((resolve) => setImmediate(resolve))
    expect(slot.busy).toBe(true)
    expect(slot.status().active?.subjectId).toBe('tpl-1')

    const queued = [
      slot.run(
        { id: 'second', kind: 'CHECKPOINT_ROOM', subjectId: 'room-2' },
        async () => undefined,
        (position) => {
          positions.second = position
        },
      ),
      slot.run(
        { id: 'third', kind: 'CHECKPOINT_ROOM', subjectId: 'room-3' },
        async () => undefined,
        (position) => {
          positions.third = position
        },
      ),
    ]
    await new Promise((resolve) => setImmediate(resolve))
    expect(positions).toEqual({ second: 1, third: 2 })
    expect(slot.positionOf('room-3')).toBe(2)
    expect(slot.status().waiting.map((entry) => entry.subjectId)).toEqual(['room-2', 'room-3'])

    first.release()
    await Promise.all([started, ...queued])
    expect(slot.positionOf('room-3')).toBeNull()
  })

  it('hands the slot on when a proof fails, so one failure does not wedge the queue', async () => {
    const slot = new ProvingSlot()
    const failing = slot.run({ id: 'a', kind: 'CHECKPOINT_ROOM', subjectId: 'room-a' }, async () => {
      throw new Error('proof worker stopped')
    })
    const following = slot.run(
      { id: 'b', kind: 'CHECKPOINT_ROOM', subjectId: 'room-b' },
      async () => 'ran',
    )
    await expect(failing).rejects.toThrow(/proof worker stopped/)
    await expect(following).resolves.toBe('ran')
    expect(slot.busy).toBe(false)
  })

  it('does not strand an entry when its queue-position report throws', async () => {
    const slot = new ProvingSlot()
    const first = deferred()
    const held = slot.run({ id: 'a', kind: 'CHECKPOINT_ROOM', subjectId: 'room-a' }, () => first.promise)
    await new Promise((resolve) => setImmediate(resolve))
    const second = slot.run(
      { id: 'b', kind: 'CHECKPOINT_ROOM', subjectId: 'room-b' },
      async () => 'ran',
      () => {
        throw new Error('persisting the queue position failed')
      },
    )
    first.release()
    await held
    await expect(second).resolves.toBe('ran')
  })
})
