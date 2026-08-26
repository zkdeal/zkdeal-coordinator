/**
 * The single proving slot.
 *
 * The stand has ONE GPU. The prover host already refuses to run two proofs at
 * once - `http.rs` holds a `tokio::sync::Semaphore::new(1)` gpu_gate - so this
 * queue is NOT what makes proving exclusive. It is what makes waiting honest.
 *
 * Without it, a checkpoint reads the chain head, computes
 * `l1InclusionDeadline = head + deadlineBlocksFromStart`, posts to the prover,
 * and only THEN blocks on the host's semaphore: the whole wait comes out of the
 * batch's own inclusion window, which at seventeen seconds a proof and twelve
 * seconds a block is most of it. Queueing here instead means the head is read
 * after the slot is held, so the window covers the checkpoint and nothing else.
 * The queue is also observable, so a caller that has to wait learns its
 * position and the UI can say "queued behind one proof" rather than "nothing is
 * happening".
 *
 * Deliberately not a semaphore of size one: the queue is observable. `status()`
 * is what `/demo/v1` publishes.
 */

export interface ProvingTicket {
  /** Job id, so a queued entry can be matched to the job that owns it. */
  id: string
  kind: string
  subjectId: string
}

export interface ProvingSlotEntry extends ProvingTicket {
  enqueuedAt: string
  startedAt: string | null
  /** 0 while running, 1 for the next in line, and so on. */
  position: number
}

export interface ProvingSlotStatus {
  active: ProvingSlotEntry | null
  waiting: ProvingSlotEntry[]
}

interface QueuedEntry extends ProvingTicket {
  enqueuedAt: string
  startedAt: string | null
  release: (() => void) | null
}

function stamp(): string {
  return new Date().toISOString()
}

export class ProvingSlot {
  /** Head is the running entry once `running` is true; the rest are waiting. */
  private queue: QueuedEntry[] = []
  private running = false

  /**
   * Run `work` with the slot held. When the slot is busy, `onQueued` is called
   * once with this caller's position (1 = next) before the wait begins, and the
   * returned promise settles only after `work` has finished and the slot has
   * been handed to the next caller.
   */
  async run<T>(
    ticket: ProvingTicket,
    work: () => Promise<T>,
    onQueued?: (position: number) => void | Promise<void>,
  ): Promise<T> {
    const entry: QueuedEntry = {
      ...ticket,
      enqueuedAt: stamp(),
      startedAt: null,
      release: null,
    }
    const gate = new Promise<void>((resolve) => {
      entry.release = resolve
    })
    this.queue.push(entry)
    const mustWait = this.running || this.queue[0] !== entry
    if (mustWait) {
      try {
        // A reporting failure must not strand the entry in the queue and wedge
        // every later proof behind it.
        await onQueued?.(this.queue.indexOf(entry))
      } catch {
        // The wait itself is what matters; the report is best effort.
      }
      await gate
    }
    this.running = true
    entry.startedAt = stamp()
    try {
      return await work()
    } finally {
      this.running = false
      const index = this.queue.indexOf(entry)
      if (index >= 0) this.queue.splice(index, 1)
      this.queue[0]?.release?.()
    }
  }

  /** How many proofs are ahead of `subjectId`, or null when it is not queued. */
  positionOf(subjectId: string): number | null {
    const index = this.queue.findIndex((entry) => entry.subjectId === subjectId)
    return index < 0 ? null : index
  }

  /** True while a proof holds the slot. */
  get busy(): boolean {
    return this.running
  }

  status(): ProvingSlotStatus {
    const view = (entry: QueuedEntry, position: number): ProvingSlotEntry => ({
      id: entry.id,
      kind: entry.kind,
      subjectId: entry.subjectId,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
      position,
    })
    const active = this.running && this.queue[0] ? view(this.queue[0], 0) : null
    const waiting = this.queue
      .slice(active ? 1 : 0)
      .map((entry, index) => view(entry, index + (active ? 1 : 0)))
    return { active, waiting }
  }
}
