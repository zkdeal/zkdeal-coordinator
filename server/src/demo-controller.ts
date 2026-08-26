import type { DemoMetricsView } from './metrics.js'
import { checkpointPolicyDocument, type CheckpointTrigger } from './demo-checkpoint-policy.js'
import {
  assertCheckpointable,
  checkpointPlan,
  completeCheckpoint,
  failCheckpoint,
  migrateRoom,
  roomIsOpen,
  startCheckpoint,
} from './demo-checkpoint-state.js'
import { buildDemoAction, type DemoActionRequest } from './demo-action.js'
import { ProvingSlot } from './demo-proving-queue.js'
import { DEMO_PRESETS } from './demo-presets.js'
import { MAXIMUM_ROOM_NAME_LENGTH, uniqueRoomName } from './demo-room-names.js'
import {
  roomSettingsDocument,
  validateDeadlineBlocks,
  type DemoRoomSettingsDocument,
} from './demo-room-settings.js'
import { closedRoomExplanation, roomView, type DemoRoomView } from './demo-room-view.js'
import { DemoFileStore, restoreSnapshot } from './demo-store.js'
import {
  now,
  positiveInteger,
  safeFailure,
  shortId,
  validateTemplateRequest,
} from './demo-validation.js'
import type {
  DemoAction,
  DemoCheckpointStatus,
  DemoFailure,
  DemoJob,
  DemoPhase,
  DemoPreset,
  DemoRoom,
  DemoRoomRequest,
  DemoRuntime,
  DemoSnapshot,
  DemoSystemStatus,
  DemoTemplate,
  DemoTemplateRequest,
} from './demo-types.js'

export class DemoController {
  readonly runtime: DemoRuntime
  readonly store: DemoFileStore
  private snapshot: DemoSnapshot = { version: 1, templates: [], rooms: [], jobs: [], idempotency: {} }
  private writes: Promise<void> = Promise.resolve()
  private degraded: DemoFailure | null = null
  private workers = new Map<string, Promise<void>>()
  private listeners = new Set<(event: unknown) => void>()
  /**
   * One GPU, one proof at a time. Cold template preparation and room
   * checkpoints share it: both spend roughly the same seventeen seconds of it,
   * and a checkpoint that started while another proof held the card would burn
   * its own L1 inclusion window waiting inside the prover.
   */
  private readonly provingSlot = new ProvingSlot()
  /** Events pushed through `emit` since this process started. */
  private eventsEmitted = 0
  /** Wall-clock seconds spent holding the proving slot, and how often. */
  private proofSecondsSum = 0
  private proofSecondsCount = 0

  constructor(dataDir: string, runtime: DemoRuntime) {
    this.runtime = runtime
    this.store = new DemoFileStore(dataDir)
  }

  async initialize(): Promise<void> {
    this.snapshot = restoreSnapshot(await this.store.load())
    await this.persist()
  }

  /**
   * The runtime probes the services; the queue belongs to this process, so it
   * is merged in here rather than invented by the runtime.
   */
  async system(): Promise<DemoSystemStatus> {
    const status = await this.runtime.systemStatus()
    return { ...status, provingQueue: this.provingSlot.status() }
  }

  provingQueue() {
    return this.provingSlot.status()
  }

  /** Checkpoint history, the current policy decision and the GPU queue. */
  checkpointStatus(id: string, currentBlock: number | null = null): DemoCheckpointStatus | null {
    const room = this.snapshot.rooms.find((item) => item.id === id)
    if (!room) return null
    return {
      roomId: room.id,
      chainRoomId: room.chainRoomId,
      checkpoints: structuredClone(room.checkpoints),
      plan: checkpointPlan(room, Date.now(), currentBlock),
      queue: this.provingSlot.status(),
      policy: checkpointPolicyDocument(),
    }
  }

  async recentBlocks() {
    return this.runtime.recentBlocks()
  }

  presets(): readonly DemoPreset[] {
    return DEMO_PRESETS
  }

  /** Bounds and per-preset defaults for the settings a client may choose. */
  roomSettings(): DemoRoomSettingsDocument {
    return roomSettingsDocument()
  }

  listTemplates(): DemoTemplate[] {
    return structuredClone(this.snapshot.templates)
  }

  template(id: string): DemoTemplate | null {
    const found = this.snapshot.templates.find((item) => item.id === id)
    return found ? structuredClone(found) : null
  }

  /** A stored room as it is PUBLISHED; `demo-room-view.ts` says what it adds. */
  private view(room: DemoRoom): DemoRoomView {
    return roomView(structuredClone(room), {
      template: this.snapshot.templates.find((item) => item.id === room.templateId),
      rooms: this.snapshot.rooms,
      transactionUrl: (hash) => this.runtime.transactionUrl?.(hash) ?? null,
    })
  }

  listRooms(): DemoRoomView[] {
    return this.snapshot.rooms.map((room) => this.view(room))
  }

  room(id: string): DemoRoomView | null {
    const found = this.snapshot.rooms.find((item) => item.id === id)
    return found ? this.view(found) : null
  }

  job(id: string): DemoJob | null {
    const found = this.snapshot.jobs.find((item) => item.id === id)
    return found ? structuredClone(found) : null
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Live stream listeners right now - `/metrics` reads this, nothing else. */
  subscriberCount(): number {
    return this.listeners.size
  }

  private emit(event: unknown): void {
    this.eventsEmitted += 1
    for (const listener of this.listeners) listener(event)
  }

  /**
   * The counters and folded gauges `/metrics` publishes. Numbers only - the
   * exposition must never carry room, action or job payload bytes. Checkpoint
   * outcomes come straight from each room's attempt records (`ACCEPTED` /
   * `FAILED`; a `RUNNING` attempt is in flight, not an outcome yet).
   */
  metricsView(): DemoMetricsView {
    const roomPhases: Record<string, number> = {}
    const checkpoints = { accepted: 0, failed: 0 }
    for (const room of this.snapshot.rooms) {
      roomPhases[room.phase] = (roomPhases[room.phase] ?? 0) + 1
      for (const record of room.checkpoints) {
        if (record.outcome === 'ACCEPTED') checkpoints.accepted += 1
        else if (record.outcome === 'FAILED') checkpoints.failed += 1
      }
    }
    const jobs = { running: 0, finished: 0, failed: 0 }
    for (const job of this.snapshot.jobs) {
      if (job.phase === 'FAILED') jobs.failed += 1
      else if (job.finishedAt === null) jobs.running += 1
      else jobs.finished += 1
    }
    const slot = this.provingSlot.status()
    return {
      roomPhases,
      templates: this.snapshot.templates.length,
      jobs,
      provingSlot: { active: slot.active !== null, waiting: slot.waiting.length },
      checkpoints,
      eventsEmitted: this.eventsEmitted,
      sseSubscribers: this.subscriberCount(),
      proofSeconds: { sum: this.proofSecondsSum, count: this.proofSecondsCount },
    }
  }

  /**
   * Serialise demo state writes.
   *
   * `this.writes.then(...)` on an already-rejected promise forwards the
   * rejection WITHOUT running `save`, so one ENOSPC/EPERM permanently stopped
   * every later persist with the original error - and because `launch`'s catch
   * handler itself awaits `persist()`, the failure path rethrew into a stored,
   * then-deleted promise, i.e. an unhandled rejection that is fatal on Node 22.
   * The chain is reset on failure and the controller is marked degraded so the
   * fault is visible instead of silent.
   */
  private async persist(): Promise<void> {
    const attempt = this.writes.catch(() => {}).then(() => this.store.save(this.snapshot))
    this.writes = attempt.catch(() => {})
    try {
      await attempt
      this.degraded = null
    } catch (error) {
      this.degraded = safeFailure(error)
      throw error
    }
  }

  /** Last persistence failure, or null while demo state is being written. */
  persistenceFailure(): DemoFailure | null {
    return this.degraded
  }

  /**
   * Wrap `work` so it runs only while this job holds the single proving slot,
   * publishing its queue position while it waits.
   */
  private provable(job: DemoJob, subjectId: string, work: () => Promise<void>): Promise<void> {
    const timed = async (): Promise<void> => {
      // Slot-held wall time only: queue wait is excluded, and a failed proof
      // still counts - it spent the GPU just the same. The sum/count pair is
      // what `/metrics` publishes as the proof-seconds summary.
      const startedAtMs = Date.now()
      try {
        await work()
      } finally {
        this.proofSecondsSum += (Date.now() - startedAtMs) / 1_000
        this.proofSecondsCount += 1
      }
    }
    return this.provingSlot.run({ id: job.id, kind: job.kind, subjectId }, timed, async (position) => {
      job.queuePosition = position
      job.updatedAt = now()
      await this.persist()
      this.emit({ type: 'queued', jobId: job.id, subjectId, position })
    })
  }

  private idempotent(key: string): string | null {
    return this.snapshot.idempotency[key] ?? null
  }

  private async phase(subject: DemoTemplate | DemoRoom, phase: DemoPhase): Promise<void> {
    subject.phase = phase
    subject.updatedAt = now()
    await this.persist()
    this.emit({ type: 'phase', subjectId: subject.id, phase, at: subject.updatedAt })
  }

  async createTemplate(input: DemoTemplateRequest, idempotencyKey: string): Promise<{ template: DemoTemplate; job: DemoJob }> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const template = this.snapshot.templates.find((item) => item.id === prior)
      const job = this.snapshot.jobs.find((item) => item.subjectId === prior)
      if (template && job) return { template: structuredClone(template), job: structuredClone(job) }
    }
    const validated = validateTemplateRequest(input)
    const createdAt = now()
    const template: DemoTemplate = {
      ...validated,
      id: shortId('tpl'),
      phase: 'VALIDATED',
      createdAt,
      updatedAt: createdAt,
    }
    const job: DemoJob = {
      id: shortId('job'),
      kind: 'PREPARE_TEMPLATE',
      subjectId: template.id,
      phase: 'VALIDATED',
      startedAt: createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      queuePosition: null,
    }
    this.snapshot.templates.push(template)
    this.snapshot.jobs.push(job)
    this.snapshot.idempotency[idempotencyKey] = template.id
    await this.persist()
    // A cold-template proof is the same seventeen seconds of the same GPU a
    // checkpoint needs, so it queues in the same slot.
    this.launch(job, () =>
      this.provable(job, template.id, async () => {
        template.preparation = await this.runtime.prepareTemplate(template, async (phase) => {
          job.phase = phase
          job.updatedAt = now()
          await this.phase(template, phase)
        })
        await this.phase(template, 'ROOM_READY')
      }),
    )
    return { template: structuredClone(template), job: structuredClone(job) }
  }

  async createRoom(input: DemoRoomRequest, idempotencyKey: string): Promise<DemoRoomView> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const found = this.snapshot.rooms.find((item) => item.id === prior)
      if (found) return this.view(found)
    }
    const template = this.snapshot.templates.find((item) => item.id === input.templateId)
    if (!template || template.phase !== 'ROOM_READY' || !template.preparation) {
      throw new Error('the selected cold template is not ready')
    }
    const base = typeof input.name === 'string' ? input.name.trim() : ''
    if (base.length < 3 || base.length > MAXIMUM_ROOM_NAME_LENGTH) {
      throw new Error(`room name must contain 3 to ${MAXIMUM_ROOM_NAME_LENGTH} characters`)
    }
    // Two rooms called the same thing are the confusion this demo actually
    // hit, so a readable suffix is the DEFAULT and opting out is explicit --
    // and an opt-out that would duplicate an existing name is refused by name
    // rather than accepted into the same ambiguity.
    const taken = new Set(this.snapshot.rooms.map((item) => item.name))
    const name = input.uniqueName === false ? base : uniqueRoomName(base, taken)
    if (input.uniqueName === false && taken.has(name)) {
      const clash = this.snapshot.rooms.find((item) => item.name === name)!
      throw new Error(
        `room '${name}' already exists (${clash.id}, ${clash.phase}); two rooms with one name ` +
          'cannot be told apart, so either choose another name or drop uniqueName: false and let ' +
          'a readable suffix be added',
      )
    }
    // Blocks, not seconds: `deadlineBlocksFromStart` is an L1 INCLUSION
    // allowance recomputed from the head at every checkpoint. A card room's
    // preset default is the two minutes of proving headroom a duel batch needs.
    const deadline = validateDeadlineBlocks(input.deadlineBlocksFromStart, template.presetId)
    const createdAt = now()
    const room: DemoRoom = {
      id: shortId('room'),
      name,
      templateId: template.id,
      managed: input.managed ?? false,
      deadlineBlocksFromStart: deadline,
      phase: 'ROOM_READY',
      createdAt,
      updatedAt: createdAt,
      chainRoomId: null,
      deploymentTransaction: null,
      actions: [],
      checkpoints: [],
      proofDeadlineBlock:
        input.proofDeadlineBlock === undefined
          ? null
          : String(positiveInteger(input.proofDeadlineBlock, 0, 'proof deadline block')),
      lastCheckpointAt: null,
      closedAt: null,
    }
    this.snapshot.rooms.push(room)
    this.snapshot.idempotency[idempotencyKey] = room.id
    await this.persist()
    return this.view(room)
  }

  async deployRoom(id: string, idempotencyKey: string): Promise<DemoJob> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const found = this.snapshot.jobs.find((item) => item.id === prior)
      if (found) return structuredClone(found)
    }
    const room = this.snapshot.rooms.find((item) => item.id === id)
    if (!room || room.phase !== 'ROOM_READY') throw new Error('room is not ready to deploy')
    const template = this.snapshot.templates.find((item) => item.id === room.templateId)
    if (!template?.preparation) throw new Error('room template is unavailable')
    const job: DemoJob = {
      id: shortId('job'),
      kind: 'DEPLOY_ROOM',
      subjectId: room.id,
      phase: room.phase,
      startedAt: now(),
      updatedAt: now(),
      finishedAt: null,
      // Room deployment is a plain L1 transaction; it needs no proof and
      // therefore never queues for the GPU.
      queuePosition: null,
    }
    this.snapshot.jobs.push(job)
    this.snapshot.idempotency[idempotencyKey] = job.id
    await this.persist()
    this.launch(job, async () => {
      const deployed = await this.runtime.deployRoom(room, template, async (phase) => {
        job.phase = phase
        job.updatedAt = now()
        await this.phase(room, phase)
      })
      room.chainRoomId = deployed.chainRoomId
      room.deploymentTransaction = deployed.transaction
      await this.phase(room, 'ACTIVE')
    })
    return structuredClone(job)
  }

  async addAction(
    roomId: string,
    input: DemoActionRequest,
    idempotencyKey: string,
  ): Promise<DemoAction> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const found = this.snapshot.rooms.flatMap((room) => room.actions).find((item) => item.id === prior)
      if (found) return structuredClone(found)
    }
    const room = this.snapshot.rooms.find((item) => item.id === roomId)
    if (!room) throw new Error('room is not active')
    // Only ACTIVE and L1_FINALIZED accept moves. L1_ACCEPTED is still
    // provisional: keep the room closed to new moves until the accepted block
    // remains canonical through the finalized checkpoint. A retraction returns
    // the same room to its rollback/retry path; finality reopens it for the next
    // checkpoint. Other refusals distinguish a checkpoint in flight from a room
    // that has actually closed or been superseded.
    if (!roomIsOpen(room)) throw new Error(closedRoomExplanation(room, this.snapshot.rooms))
    const template = this.snapshot.templates.find((item) => item.id === room.templateId)
    const action = buildDemoAction(room, template, input)
    room.actions.push(action)
    room.updatedAt = now()
    this.snapshot.idempotency[idempotencyKey] = action.id
    await this.persist()
    this.emit({ type: 'action', roomId, action: structuredClone(action) })
    return structuredClone(action)
  }

  /**
   * Close a demo room to further actions.
   *
   * This is a control-plane close, not a fabricated L1 checkpoint: accepted
   * actions and receipts remain published, while `roomIsOpen` immediately
   * refuses any later mutation. The client waits for its current coordinator
   * step before calling this endpoint; the guard below also prevents a second
   * caller from closing underneath a deployment or proof still in flight.
   */
  async closeRoom(id: string, idempotencyKey: string): Promise<DemoRoomView> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const found = this.snapshot.rooms.find((item) => item.id === prior)
      if (found) return this.view(found)
    }
    const room = this.snapshot.rooms.find((item) => item.id === id)
    if (!room) throw new Error('room not found')
    const activeJob = this.snapshot.jobs.find(
      (job) => job.subjectId === room.id && this.workers.has(job.id),
    )
    if (activeJob) {
      throw new Error(
        `room cannot close while its ${activeJob.kind.toLowerCase().replace(/_/g, ' ')} job is still running`,
      )
    }
    if (room.phase !== 'CLOSED') {
      const closedAt = now()
      room.phase = 'CLOSED'
      room.closedAt = closedAt
      room.updatedAt = closedAt
    }
    this.snapshot.idempotency[idempotencyKey] = room.id
    await this.persist()
    this.emit({ type: 'phase', subjectId: room.id, phase: room.phase, at: room.updatedAt })
    return this.view(room)
  }

  /**
   * Start ONE checkpoint carrying every move accepted since the last accepted
   * one. `force` skips the "is it due yet" arm of the policy - an operator
   * pressing the button, or the existing single-checkpoint flow - but never the
   * structural rules: a room still needs a move in each of its two blocks, and
   * a second checkpoint never starts while one is running.
   */
  async checkpointRoom(
    id: string,
    idempotencyKey: string,
    options: { force?: boolean } = {},
  ): Promise<DemoJob> {
    const prior = this.idempotent(idempotencyKey)
    if (prior) {
      const found = this.snapshot.jobs.find((item) => item.id === prior)
      if (found) return structuredClone(found)
    }
    const room = this.snapshot.rooms.find((item) => item.id === id)
    if (!room) throw new Error('room is not ready to checkpoint')
    const template = this.snapshot.templates.find((item) => item.id === room.templateId)
    if (!template?.preparation) throw new Error('room template is unavailable')
    const force = options.force ?? true
    const pending = assertCheckpointable(room, force)
    const trigger: CheckpointTrigger = force
      ? 'MANUAL'
      : (checkpointPlan(room).trigger ?? 'MANUAL')
    const openPhase = room.phase
    const record = startCheckpoint(room, pending, trigger, now())
    const job: DemoJob = {
      id: shortId('job'),
      kind: 'CHECKPOINT_ROOM',
      subjectId: room.id,
      phase: room.phase,
      startedAt: now(),
      updatedAt: now(),
      finishedAt: null,
      queuePosition: null,
    }
    this.snapshot.jobs.push(job)
    this.snapshot.idempotency[idempotencyKey] = job.id
    await this.persist()
    const enqueuedAt = Date.now()
    this.launch(
      job,
      () =>
        this.provable(job, room.id, async () => {
          record.queueWaitMs = Date.now() - enqueuedAt
          const result = await this.runtime.checkpointRoom(
            room,
            template,
            async (phase) => {
              job.phase = phase
              job.updatedAt = now()
              await this.phase(room, phase)
            },
            { sequence: record.sequence, trigger, actions: pending },
          )
          completeCheckpoint(room, record, result, now())
          await this.phase(room, 'L1_FINALIZED')
        }),
      // A refused or reverted checkpoint does not kill the room: the moves stay
      // pending, the attempt is recorded as FAILED with the real reason, and
      // the room goes back to the open phase it had.
      (failure) => {
        failCheckpoint(room, record, failure, now())
        return openPhase
      },
    )
    return structuredClone(job)
  }

  private launch(
    job: DemoJob,
    work: () => Promise<void>,
    /**
     * Given the failure, record it and return the phase the subject should be
     * left in. Absent means the historic behaviour: the subject becomes FAILED.
     */
    recover?: (failure: DemoFailure) => DemoPhase,
  ): void {
    // A persist failure inside either terminal handler must not escape: the
    // resulting rejection is stored in `workers` and deleted by `.finally`,
    // which makes it an unhandled rejection (fatal by default on Node 22).
    const persistQuietly = () => this.persist().catch(() => {})
    const promise = work()
      .then(async () => {
        job.finishedAt = now()
        job.updatedAt = job.finishedAt
        await persistQuietly()
        this.emit({ type: 'job', job: structuredClone(job) })
      })
      .catch(async (error) => {
        const failure = safeFailure(error)
        job.phase = 'FAILED'
        job.failure = failure
        job.finishedAt = now()
        job.updatedAt = job.finishedAt
        const template = this.snapshot.templates.find((item) => item.id === job.subjectId)
        const room = this.snapshot.rooms.find((item) => item.id === job.subjectId)
        if (template) {
          template.phase = 'FAILED'
          template.failure = failure
          template.updatedAt = job.updatedAt
        }
        if (room) {
          room.phase = recover ? recover(failure) : 'FAILED'
          room.failure = failure
          room.updatedAt = job.updatedAt
        }
        await persistQuietly()
        this.emit({ type: 'job', job: structuredClone(job) })
      })
      .finally(() => this.workers.delete(job.id))
    this.workers.set(job.id, promise)
  }

  async drain(): Promise<void> {
    await Promise.all([...this.workers.values()])
    await this.writes
  }
}
