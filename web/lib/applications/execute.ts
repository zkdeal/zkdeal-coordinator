/**
 * Running ONE planned step against the real coordinator.
 *
 * Split out of the React hook so the sequence of calls a step makes - and the
 * sentence it writes into the action log afterwards - is ordinary async code
 * rather than something tangled with state setters. The hook decides WHEN a
 * step runs and applies the result; this decides WHAT the step does.
 *
 * Every step either succeeds and returns what changed, or THROWS with the
 * coordinator's own explanation. There is no third outcome: nothing here
 * retries, substitutes or downgrades a failed step into a simulated one,
 * because a demo that did would be claiming a settlement that did not happen.
 *
 * React-free.
 */
import type { Preset, Room, Template } from '@/components/demo-console/api'
import { deadlineBlocksForSeconds, readDemoSystem, type DemoSystem } from '../demo-system'
import {
  demoCheckpointSettlement,
  type DemoPlan,
  type DemoScript,
} from './application-run'
import {
  demoCheckpointEntry,
  demoDeploymentEntry,
  demoLogEntry,
  demoRoomCheckpoints,
  type DemoLogEntry,
} from './log'
import {
  awaitDemoTemplate,
  checkpointDemoRoom,
  deployDemoRoom,
  findDemoPreset,
  findDemoTemplate,
  openDemoRoom,
  prepareDemoTemplate,
  sendDemoAction,
} from './transport'

/** What the run already knows when a step begins. */
export interface DemoStepContext {
  readonly script: DemoScript
  readonly system: DemoSystem | null
  readonly preset: Preset | null
  readonly template: Template | null
  readonly room: Room | null
  /** The presenter's inclusion allowance for a new room, in seconds. */
  readonly deadlineSeconds: number
  /** Called with the coordinator's own phase while a background job runs. */
  readonly onPhase?: (phase: string) => void
}

/**
 * What the step changed. Every field is optional and absent means unchanged, so
 * the hook applies exactly what happened and invents nothing.
 */
export interface DemoStepResult {
  readonly system?: DemoSystem
  readonly preset?: Preset
  readonly template?: Template | null
  readonly room?: Room
  /** True when one more of the preset's actions was accepted. */
  readonly actionTaken?: boolean
  /** Total checkpoints the room has now settled. */
  readonly checkpoints?: number
  readonly entries: readonly DemoLogEntry[]
}

const MISSING_ROOM =
  'This step needs a room and the run has none, which should be impossible - the planner only offers it once a room exists. Nothing was submitted.'
const MISSING_TEMPLATE =
  'This step needs a prepared template and the run has none, which should be impossible - the planner only offers it once a template exists. Nothing was submitted.'

export async function runDemoStep(
  plan: DemoPlan,
  context: DemoStepContext,
): Promise<DemoStepResult> {
  const { script, system, onPhase } = context
  switch (plan.kind) {
    case 'system': {
      // The three things a run needs before it can do anything: where this
      // stand is, whether it publishes this application at all, and whether
      // somebody already paid for the cold proof.
      const [next, lookup, existing] = await Promise.all([
        readDemoSystem(),
        findDemoPreset(script.presetId),
        findDemoTemplate(script.presetId).catch(() => null),
      ])
      if (!lookup.preset) {
        throw new Error(lookup.reason ?? 'This application is not published by this coordinator.')
      }
      return {
        system: next,
        preset: lookup.preset,
        template: existing,
        entries: [
          demoLogEntry({
            kind: 'system',
            title: `Coordinator ready · ${lookup.preset.name}`,
            detail: existing
              ? `A cold template for this preset already exists at ${existing.phase}, so the stand's GPU is not asked to prove one again.`
              : 'No cold template exists for this preset yet, so one is prepared and proved next.',
            status: 'accepted',
          }),
        ],
      }
    }
    case 'prepare': {
      const created = await prepareDemoTemplate({
        presetId: script.presetId,
        name: `${script.title} autoplay`,
      })
      return {
        template: created,
        entries: [
          demoLogEntry({
            kind: 'prepare',
            title: 'Cold template queued for proving',
            detail:
              'The application’s starting state is being executed and proved on the stand’s single GPU. Nothing is on L1 yet.',
            status: 'accepted',
          }),
        ],
      }
    }
    case 'await-template': {
      if (!context.template) throw new Error(MISSING_TEMPLATE)
      const ready = await awaitDemoTemplate(context.template.id, {
        timeoutMs: 300_000,
        onPhase,
      })
      return {
        template: ready,
        entries: [
          demoLogEntry({
            kind: 'await-template',
            title: 'Cold proof accepted',
            detail:
              'The template is registered and a room can now be opened from it. Its starting state is fixed by a proof, not by trust in the operator.',
            status: 'accepted',
          }),
        ],
      }
    }
    case 'open': {
      if (!context.template) throw new Error(MISSING_TEMPLATE)
      const opened = await openDemoRoom({
        templateId: context.template.id,
        name: `${script.roomName} · ${new Date().toISOString().slice(11, 19)}`,
        deadlineBlocks: deadlineBlocksForSeconds(
          context.deadlineSeconds,
          system?.l1BlockSeconds ?? 12,
        ),
      })
      return {
        room: opened,
        entries: [
          demoLogEntry({
            kind: 'open',
            title: `Room created · ${opened.name}`,
            detail: `Proving deadline ${opened.deadlineBlocksFromStart} L1 blocks from the head at each checkpoint. Not deployed yet.`,
            status: 'accepted',
          }),
        ],
      }
    }
    case 'deploy': {
      if (!context.room) throw new Error(MISSING_ROOM)
      const deployed = await deployDemoRoom(context.room.id, onPhase)
      return {
        room: deployed,
        entries: [demoDeploymentEntry(deployed, system?.explorerUrl ?? null)],
      }
    }
    case 'action': {
      if (!context.room) throw new Error(MISSING_ROOM)
      const action = context.preset?.actions[plan.actionIndex ?? 0]
      if (!action) {
        throw new Error('The preset no longer publishes the action this step was planned for.')
      }
      const accepted = await sendDemoAction(context.room.id, action)
      return {
        actionTaken: true,
        entries: [
          demoLogEntry({
            kind: 'action',
            title: `${action.label} · ${action.actor}`,
            detail:
              'Accepted as a room action. It is held in the room’s L2 block; nothing about it is canonical until a checkpoint proves that block.',
            status: 'accepted',
            actionId: accepted.id,
            block: accepted.block,
          }),
        ],
      }
    }
    case 'checkpoint': {
      if (!context.room) throw new Error(MISSING_ROOM)
      const settled = await checkpointDemoRoom(context.room.id, onPhase)
      const published = demoRoomCheckpoints(settled)
      const latest = published[published.length - 1]
      if (!latest) {
        // A finished job with no receipt settles nothing, and is reported as
        // the anomaly it is rather than credited to the actions it carried.
        throw new Error(
          'The checkpoint job finished but the coordinator published no receipt for it, so nothing here is marked as settled.',
        )
      }
      return {
        room: settled,
        checkpoints: published.length,
        entries: [
          demoCheckpointEntry(
            latest,
            system?.explorerUrl ?? null,
            demoCheckpointSettlement(script, published.length - 1),
          ),
        ],
      }
    }
  }
}
