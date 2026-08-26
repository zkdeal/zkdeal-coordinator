/**
 * The coordinator calls the two application demos actually make.
 *
 * Every one of these is the SAME `/demo/v1` control plane the live room studio
 * drives, through the same `api()` wrapper. Nothing here is a demo-only path:
 * an auction room prepared from this module is indistinguishable from one a
 * presenter prepared by hand in the studio, which is the whole point - the
 * self-driving demo has to be the real thing or it is a screensaver.
 *
 * WHAT IS NOT HERE. No retries, no fallbacks and no substitutions. When the
 * coordinator refuses, the refusal is thrown with ITS OWN explanation and the
 * caller puts that sentence on screen. A demo that quietly swapped a failed
 * step for a simulated one would be claiming a settlement that did not happen.
 *
 * React-free.
 */
import {
  api,
  type Preset,
  type PresetAction,
  type Room,
  type Template,
} from '@/components/demo-console/api'
import { awaitDemoJob, demoIdempotencyKey, type DemoJobView } from '../demo-jobs'
import { DEMO_TEMPLATE_READY } from './application-run'

export interface DemoPresetLookup {
  readonly preset: Preset | null
  /** Why this application cannot run here, in the coordinator's own words. */
  readonly reason: string | null
}

export async function findDemoPreset(presetId: string): Promise<DemoPresetLookup> {
  const published = await api<{ presets: Preset[] }>('/demo/v1/presets')
  const preset = published.presets.find((entry) => entry.id === presetId)
  if (!preset) {
    return {
      preset: null,
      reason: `This coordinator publishes no "${presetId}" preset, so it cannot host this application. The demo stops here rather than showing a scripted stand-in.`,
    }
  }
  if (preset.actions.length === 0) {
    return {
      preset: null,
      reason: `The "${preset.name}" preset publishes no room actions, so there is nothing for this demo to submit.`,
    }
  }
  return { preset, reason: null }
}

/**
 * A template already prepared from this preset that a room can be opened from.
 *
 * Preferred over preparing a new one: a cold proof occupies the stand's single
 * GPU for as long as it takes, and a demo that queued one on every run would
 * put a minute of dead air in front of every press of the button - and would
 * push any duel waiting behind it out by the same amount.
 */
export async function findDemoTemplate(presetId: string): Promise<Template | null> {
  const published = await api<{ templates: Template[] }>('/demo/v1/templates')
  const mine = published.templates.filter(
    (entry) => entry.presetId === presetId && !entry.failure,
  )
  return mine.filter((entry) => entry.phase === DEMO_TEMPLATE_READY).at(-1) ?? mine.at(-1) ?? null
}

export async function readDemoTemplate(templateId: string): Promise<Template> {
  return api<Template>(`/demo/v1/templates/${templateId}`)
}

/**
 * Prepare a cold template from a certified preset.
 *
 * Answered with 202 and a body of `{ template, job }` - NOT a bare template:
 * the cold state execution and its Groth16 proof run in the background on the
 * single CUDA worker, and the job is how the coordinator names that work. The
 * caller polls `readDemoTemplate` and says on screen what phase it is in.
 *
 * The envelope is unwrapped here, and a response that does not carry a template
 * id is refused rather than turned into a poll against `/templates/undefined`.
 */
export async function prepareDemoTemplate(input: {
  readonly presetId: string
  readonly name: string
}): Promise<Template> {
  const accepted = await api<{ template?: Template } & Partial<Template>>('/demo/v1/templates', {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey(`tpl-${input.presetId}`) },
    body: JSON.stringify({ name: input.name, presetId: input.presetId }),
  })
  const template = accepted.template ?? (accepted.id ? (accepted as Template) : null)
  if (!template?.id) {
    throw new Error(
      'The coordinator accepted the template request but published no template id for it, so there is nothing to watch or open a room from.',
    )
  }
  return template
}

export interface DemoTemplateWatch {
  readonly timeoutMs: number
  readonly pollMs?: number
  readonly onPhase?: (phase: string) => void
}

/**
 * Watch a template to ROOM_READY.
 *
 * A template that FAILED is thrown with the coordinator's own explanation; a
 * template still proving when the timeout expires is reported as still proving,
 * because it is - the GPU keeps working and a later run finds it ready.
 */
export async function awaitDemoTemplate(
  templateId: string,
  options: DemoTemplateWatch,
): Promise<Template> {
  const pollMs = options.pollMs ?? 2_500
  const deadline = Date.now() + options.timeoutMs
  let seen: string | null = null
  for (;;) {
    const template = await readDemoTemplate(templateId)
    if (template.phase !== seen) {
      seen = template.phase
      options.onPhase?.(template.phase)
    }
    if (template.failure) throw new Error(template.failure.explanation)
    if (template.phase === DEMO_TEMPLATE_READY) return template
    if (Date.now() > deadline) {
      throw new Error(
        `The cold proof for this template is still at ${template.phase} after ${Math.round(
          options.timeoutMs / 1000,
        )} s. Nothing was lost - it keeps proving on the stand's GPU and a later run will find it ready.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function readDemoRoom(roomId: string): Promise<Room> {
  return api<Room>(`/demo/v1/rooms/${roomId}`)
}

/** Close the room to any further demo actions while retaining its history. */
export async function closeDemoRoom(roomId: string): Promise<Room> {
  return api<Room>(`/demo/v1/rooms/${roomId}/close`, {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey('demo-close') },
    body: '{}',
  })
}

/**
 * Open a room from a prepared template.
 *
 * `deadlineBlocksFromStart` is the L1 INCLUSION allowance for one batch, which
 * the coordinator recomputes from the current block on every checkpoint; it is
 * the presenter's choice and is passed through rather than invented here.
 */
export async function openDemoRoom(input: {
  readonly templateId: string
  readonly name: string
  readonly deadlineBlocks: number
}): Promise<Room> {
  return api<Room>('/demo/v1/rooms', {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey('demo-room') },
    body: JSON.stringify({
      name: input.name,
      templateId: input.templateId,
      managed: false,
      deadlineBlocksFromStart: Math.max(2, Math.min(7_200, Math.round(input.deadlineBlocks))),
    }),
  })
}

/** Deploy the room on L1 and wait for the deployment transaction to land. */
export async function deployDemoRoom(
  roomId: string,
  onPhase?: (phase: string) => void,
): Promise<Room> {
  const job = await api<DemoJobView>(`/demo/v1/rooms/${roomId}/deploy`, {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey('demo-deploy') },
    body: '{}',
  })
  await awaitDemoJob(job.id, { timeoutMs: 180_000, onPhase })
  return readDemoRoom(roomId)
}

/**
 * Hand one of the preset's own actions to the room.
 *
 * The calldata is the preset's; this demo does not author transactions. That is
 * the difference between these two applications and the hidden-card duel, whose
 * every move depends on a participant leaf, a nonce and a proof only the player
 * has and therefore cannot be canned at all.
 */
export async function sendDemoAction(
  roomId: string,
  action: Pick<PresetAction, 'id' | 'actor' | 'recommendedBlock'>,
): Promise<{ id: string; block: 1 | 2 }> {
  const accepted = await api<{ id: string; block?: 1 | 2 }>(`/demo/v1/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey('demo-action') },
    body: JSON.stringify({
      actionId: action.id,
      actorId: action.actor,
      block: action.recommendedBlock,
    }),
  })
  return { id: accepted.id, block: accepted.block ?? action.recommendedBlock }
}

/**
 * Prove the room's batch and submit it to L1.
 *
 * On the reference stand this is tens of seconds of GPU proving plus one or two
 * 12 s L1 blocks, and it SERIALIZES with every other proof on the stand. The
 * timeout is generous for that reason, and a timeout is reported as "still
 * running" rather than as a loss.
 */
export async function checkpointDemoRoom(
  roomId: string,
  onPhase?: (phase: string) => void,
): Promise<Room> {
  const job = await api<DemoJobView>(`/demo/v1/rooms/${roomId}/checkpoints`, {
    method: 'POST',
    headers: { 'idempotency-key': demoIdempotencyKey('demo-checkpoint') },
    body: '{}',
  })
  await awaitDemoJob(job.id, { timeoutMs: 300_000, onPhase })
  return readDemoRoom(roomId)
}
