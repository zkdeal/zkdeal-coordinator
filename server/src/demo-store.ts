/**
 * Persistence and restart repair for the demo control plane.
 *
 * The snapshot is the whole truth about what the stand has done, so it is
 * written atomically (temp file plus rename) and repaired on load: anything the
 * previous process left mid-flight is marked failed with a readable reason
 * rather than left claiming to be running. A checkpoint recorded as RUNNING is
 * the one that matters - the process holding the proving slot is gone, so the
 * moves it carried must go back to pending instead of being reported settled.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { migrateRoom } from './demo-checkpoint-state.js'
import { now } from './demo-validation.js'
import type { DemoSnapshot } from './demo-types.js'

export class DemoFileStore {
  readonly path: string
  constructor(dataDir: string) {
    this.path = join(dataDir, 'demo-v1', 'state.json')
  }
  async load(): Promise<DemoSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as DemoSnapshot
      if (parsed.version !== 1) throw new Error('unsupported demo state version')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, templates: [], rooms: [], jobs: [], idempotency: {} }
    }
  }
  async save(snapshot: DemoSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}

/** Migrate older rooms and fail everything the previous process left running. */
export function restoreSnapshot(snapshot: DemoSnapshot): DemoSnapshot {
  for (const room of snapshot.rooms) {
    migrateRoom(room)
    for (const record of room.checkpoints.filter((item) => item.outcome === 'RUNNING')) {
      record.outcome = 'FAILED'
      record.finishedAt = now()
      record.failure = {
        explanation: 'The controller restarted while this checkpoint was proving.',
        effect: 'Nothing was accepted on Ethereum; the moves it carried are pending again.',
        recovery: 'Checkpoint the room again; exactly the same moves will be proved.',
      }
    }
  }
  for (const job of snapshot.jobs.filter((item) => item.finishedAt === null)) {
    job.phase = 'FAILED'
    job.finishedAt = now()
    job.updatedAt = job.finishedAt
    job.queuePosition ??= null
    job.failure = {
      explanation: 'The controller restarted while this job was active.',
      effect: 'The last accepted L1 checkpoint is unchanged.',
      recovery: 'Retry the operation; its idempotency key will prevent a duplicate accepted transition.',
    }
  }
  return snapshot
}
