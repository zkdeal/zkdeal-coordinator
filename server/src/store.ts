import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { RoomDeploymentManifest, SnapshotPayload } from '@zkdeal/protocol'

/** Canonical decimal room id: no sign, no leading zeros, uint64-ish bound. */
const ROOM_ID_RE = /^(0|[1-9][0-9]{0,19})$/

/**
 * Room ids are used as filesystem path components AND as store keys.
 * `JsonFileStore` collapses non-alphanumerics, so accepting free-form ids lets
 * distinct ids alias onto one directory. Reject anything non-canonical.
 */
export function isCanonicalRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id)
}

/**
 * JSON file store under DATA_DIR - no better-sqlite3.
 * Snapshots / genesis dumps are convenience only; clients must re-verify.
 *
 * Room ids MUST be canonical decimal (`isCanonicalRoomId`): the directory name
 * is the id itself, so any other spelling could alias onto another room's
 * files. Writes are temp-file + fsync + rename so a crash or a concurrent read
 * can never observe a half-written JSON document.
 */
export class JsonFileStore {
  constructor(private readonly dataDir: string) {
    mkdirSync(this.roomsDir, { recursive: true })
  }

  private get roomsDir(): string {
    return join(this.dataDir, 'rooms')
  }

  /** Path of a room file. `create` controls whether the directory is made. */
  private roomFile(roomId: string, name: string, create: boolean): string {
    if (!isCanonicalRoomId(roomId)) {
      throw new Error(`invalid room id ${JSON.stringify(roomId)}`)
    }
    const dir = join(this.roomsDir, roomId)
    if (create) mkdirSync(dir, { recursive: true })
    return join(dir, name)
  }

  private readJson<T>(roomId: string, name: string): T | null {
    const path = this.roomFile(roomId, name, false)
    if (!existsSync(path)) return null
    // Corruption must surface, not be swallowed into a "missing" answer.
    return JSON.parse(readFileSync(path, 'utf8')) as T
  }

  /** temp-write + fsync + atomic rename (same directory → rename is atomic). */
  private writeJson(roomId: string, name: string, value: unknown): void {
    const path = this.roomFile(roomId, name, true)
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(value), 'utf8')
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best effort cleanup */
      }
      throw err
    }
  }

  getGenesis(roomId: string): Record<string, unknown> | null {
    return this.readJson<Record<string, unknown>>(roomId, 'genesis.json')
  }

  putGenesis(roomId: string, genesis: Record<string, unknown>): void {
    this.writeJson(roomId, 'genesis.json', genesis)
  }

  getManifest(roomId: string): RoomDeploymentManifest | null {
    return this.readJson<RoomDeploymentManifest>(roomId, 'manifest.json')
  }

  putManifest(roomId: string, manifest: RoomDeploymentManifest): void {
    this.writeJson(roomId, 'manifest.json', manifest)
  }

  getSnapshot(roomId: string): SnapshotPayload | null {
    return this.readJson<SnapshotPayload>(roomId, 'snapshot.json')
  }

  putSnapshot(roomId: string, snapshot: SnapshotPayload): void {
    this.writeJson(roomId, 'snapshot.json', snapshot)
  }

}
