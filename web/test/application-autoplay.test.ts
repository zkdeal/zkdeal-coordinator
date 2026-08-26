import { describe, expect, it } from 'vitest'
import {
  AUTOPLAY_DELAYS,
  autoplayCompleted,
  autoplayExhausted,
  createAutoplayRunReducer,
  createAutoplayRunState,
  type AutoplayEnd,
  type AutoplayRunState,
} from '../lib/autoplay/run'
import {
  planDemoStep,
  AMM_SCRIPT,
  DVP_SCRIPT,
  ERC7540_SCRIPT,
  ERC4626_SCRIPT,
  AUCTION_SCRIPT,
  DEMO_LIMITS,
  DEMO_STAGES,
  SHOP_SCRIPT,
  demoSettledDetail,
  demoMayLoop,
  demoStageIndex,
  demoStageOf,
  type DemoAction,
  type DemoPlan,
  type DemoProgress,
  type DemoScript,
  type DemoStepKind,
} from '../lib/applications/application-run'

/**
 * Both application autoplays, driven headless.
 *
 * The loop below is the hook's sequence with the timer and the network removed:
 * plan a step, announce it, spend a step of the budget, apply what that step
 * would have changed on the coordinator, re-plan. If the planner could ever
 * return a step the lifecycle does not admit, or fail to terminate, it shows up
 * here rather than on a stand in front of an audience.
 *
 * The three properties asserted are the ones an unattended stand depends on:
 * a run ADVANCES through the real lifecycle, it TERMINATES on its own, and it
 * can be STOPPED - and under no circumstance does it exceed its step bound.
 */

const BOUNDED: AutoplayEnd = { kind: 'bounded', headline: 'bounded', detail: 'bound reached' }
const STOPPED: AutoplayEnd = { kind: 'stopped', headline: 'stopped', detail: 'stopped by hand' }
const reduce = createAutoplayRunReducer<string, { kind: string }>({
  bounded: BOUNDED,
  stopped: STOPPED,
})

type State = AutoplayRunState<string, { kind: string }>

const AUCTION_ACTIONS: readonly DemoAction[] = [
  { id: 'commit-bid', label: 'Commit sealed bid', actor: 'bidder-a' },
  { id: 'clear-auction', label: 'Reveal and clear', actor: 'auctioneer' },
]
const SHOP_ACTIONS: readonly DemoAction[] = [
  { id: 'register-session', label: 'Register customer session', actor: 'buyer' },
  { id: 'buy-item', label: 'Purchase and disconnect', actor: 'buyer' },
]
const DVP_ACTIONS: readonly DemoAction[] = [
  { id: 'seller-lock', label: 'Seller locks asset', actor: 'seller' },
  { id: 'buyer-pay', label: 'Buyer authorizes payment', actor: 'buyer' },
]
const ERC4626_ACTIONS: readonly DemoAction[] = [
  { id: 'quote-share-issue', label: 'Quote 100 assets as 100 shares', actor: 'investor' },
  { id: 'issue-shares', label: 'Deposit 100 assets; issue 100 shares', actor: 'investor' },
  { id: 'observe-vault-liquidity', label: 'Observe vault liquidity', actor: 'liquidity-provider' },
  { id: 'add-liquidity', label: 'Add 50 assets without issuing shares', actor: 'liquidity-provider' },
  { id: 'quote-redemption', label: 'Quote 100 shares at 149 assets', actor: 'investor' },
  { id: 'redeem-shares', label: 'Burn 100 shares; release 149 assets', actor: 'investor' },
]
const AMM_ACTIONS: readonly DemoAction[] = [
  { id: 'initialize-pool', label: 'Initialize 1:1 protected pool', actor: 'coordinator' },
  { id: 'victim-commit', label: 'Victim commits hidden swap', actor: 'victim' },
  { id: 'attacker-commit', label: 'Searcher commits blind order', actor: 'searcher' },
  { id: 'seal-order', label: 'Seal commitment order', actor: 'coordinator' },
  { id: 'reactive-front-run-blocked', label: 'Block reactive front-run', actor: 'searcher' },
  { id: 'out-of-order-reveal-blocked', label: 'Reject early searcher reveal', actor: 'searcher' },
  { id: 'victim-reveal', label: 'Execute victim reveal first', actor: 'victim' },
  { id: 'blind-order-reveal', label: 'Execute precommitted searcher order', actor: 'searcher' },
]
const ERC7540_ACTIONS: readonly DemoAction[] = [
  'alice-request-deposit',
  'bob-request-deposit',
  'manager-fulfill-alice-deposit',
  'manager-fulfill-bob-deposit',
  'alice-claim-deposit',
  'bob-claim-deposit',
  'alice-request-redeem',
  'bob-request-redeem',
  'manager-fulfill-alice-redeem',
  'manager-fulfill-bob-redeem',
  'alice-claim-redeem',
  'bob-claim-redeem',
].map((id) => ({ id, label: id, actor: id.split('-')[0]! }))

interface Run {
  readonly kinds: readonly DemoStepKind[]
  readonly narrations: readonly string[]
  readonly states: readonly State[]
  readonly progress: DemoProgress
  readonly plans: readonly DemoPlan[]
}

/**
 * One run against a coordinator model that answers the way the real one does:
 * a prepared template starts at DRAFT and only reaches ROOM_READY after the
 * cold proof, a room is not deployed until it is deployed, and a checkpoint
 * settles the actions the room is holding.
 *
 * `templateReady` starts a run against a stand where an earlier run already
 * left a prepared template - the common case on a live stand, and the one where
 * the planner must NOT queue a second cold proof on the shared GPU.
 */
function run(
  script: DemoScript,
  actions: readonly DemoAction[],
  options: {
    maxSteps?: number
    stopAfter?: number
    templateReady?: boolean
    /** Simulate the coordinator never finishing the cold proof. */
    templateStuck?: boolean
  } = {},
): Run {
  let progress: DemoProgress = {
    system: false,
    template: null,
    room: null,
    actionsTaken: 0,
    actionCount: actions.length,
    checkpoints: 0,
    stepsMade: 0,
    maxSteps: options.maxSteps ?? script.maxSteps ?? DEMO_LIMITS.maxSteps,
  }
  let state: State = reduce(
    createAutoplayRunState<string, { kind: string }>(
      { delayMs: DEMO_LIMITS.delayMs, maxMoves: progress.maxSteps! },
      { maxMoves: progress.maxSteps },
    ),
    { type: 'start' },
  )
  const kinds: DemoStepKind[] = []
  const narrations: string[] = []
  const plans: DemoPlan[] = []
  const states: State[] = [state]

  for (;;) {
    if (state.status !== 'running') break
    if (options.stopAfter !== undefined && state.movesMade >= options.stopAfter) {
      state = reduce(state, { type: 'stop' })
      states.push(state)
      break
    }
    const plan = planDemoStep({ script, actions, progress })
    if (!plan) {
      state = reduce(state, {
        type: 'end',
        end: autoplayExhausted(state)
          ? BOUNDED
          : { kind: 'settled', headline: 'settled', detail: demoSettledDetail(script) },
      })
      states.push(state)
      break
    }
    plans.push(plan)
    kinds.push(plan.kind)
    narrations.push(plan.narration)
    state = reduce(state, {
      type: 'announce',
      key: `${state.movesMade}:${plan.kind}`,
      narration: plan.narration,
      focus: plan.stage,
    })
    state = reduce(state, { type: 'act', acting: { kind: plan.kind } })
    states.push(state)
    if (state.status !== 'running') break

    // What the coordinator would now hold.
    switch (plan.kind) {
      case 'system':
        progress = {
          ...progress,
          system: true,
          template: options.templateReady ? { id: 'tpl-existing', phase: 'ROOM_READY' } : null,
        }
        break
      case 'prepare':
        progress = { ...progress, template: { id: 'tpl-new', phase: 'COLD_PROVING' } }
        break
      case 'await-template':
        progress = {
          ...progress,
          template: {
            id: progress.template!.id,
            phase: options.templateStuck ? 'COLD_PROVING' : 'ROOM_READY',
          },
        }
        break
      case 'open':
        progress = { ...progress, room: { id: 'room-1', phase: 'ROOM_READY', deployed: false } }
        break
      case 'deploy':
        progress = { ...progress, room: { id: 'room-1', phase: 'ACTIVE', deployed: true } }
        break
      case 'action':
        progress = { ...progress, actionsTaken: progress.actionsTaken + 1 }
        break
      case 'checkpoint':
        progress = { ...progress, checkpoints: progress.checkpoints + 1 }
        break
    }
    progress = { ...progress, stepsMade: state.movesMade }
  }

  return { kinds, narrations, states, progress, plans }
}

const APPLICATIONS: ReadonlyArray<[string, DemoScript, readonly DemoAction[]]> = [
  ['uniform-price auction', AUCTION_SCRIPT, AUCTION_ACTIONS],
  ['tokenized shop', SHOP_SCRIPT, SHOP_ACTIONS],
  ['ERC-7540 vault', ERC7540_SCRIPT, ERC7540_ACTIONS],
  ['DvP prototype', DVP_SCRIPT, DVP_ACTIONS],
  ['ERC-4626 prototype', ERC4626_SCRIPT, ERC4626_ACTIONS],
  ['AMM prototype', AMM_SCRIPT, AMM_ACTIONS],
]

describe.each(APPLICATIONS)('%s autoplay', (_name, script, actions) => {
  it('advances the real room lifecycle from nothing to a settled batch', () => {
    const result = run(script, actions)
    const milestones = script.checkpointAfterActions ?? [actions.length]
    const applicationSteps = actions.flatMap((_, index) => [
      'action' as const,
      ...(milestones.includes(index + 1) ? (['checkpoint'] as const) : []),
    ])

    // Exactly the coordinator's own order. Nothing is skipped and nothing is
    // invented: a room cannot be opened before a template is ready, an action
    // cannot be sent before the room is on L1, and a checkpoint comes last.
    expect(result.kinds).toEqual([
      'system',
      'prepare',
      'await-template',
      'open',
      'deploy',
      ...applicationSteps,
    ])

    // It ran every action the application publishes, and settled once.
    expect(result.progress.actionsTaken).toBe(actions.length)
    expect(result.progress.checkpoints).toBe(milestones.length)

    // And it ended by itself, as settled rather than as bounded - the two must
    // never be reported as the same thing.
    const final = result.states.at(-1)!
    expect(final.status).toBe('ended')
    expect(final.end?.kind).toBe('settled')
    expect(autoplayCompleted(final.end)).toBe(true)
    expect(final.movesMade).toBeLessThan(result.progress.maxSteps!)
  })

  it('reuses a prepared template instead of queueing a second cold proof', () => {
    // One GPU. A stand that already carries a prepared template must not have
    // another cold proof pushed in front of whatever else is waiting.
    const result = run(script, actions, { templateReady: true })
    const milestones = script.checkpointAfterActions ?? [actions.length]
    const applicationSteps = actions.flatMap((_, index) => [
      'action' as const,
      ...(milestones.includes(index + 1) ? (['checkpoint'] as const) : []),
    ])
    expect(result.kinds).not.toContain('prepare')
    expect(result.kinds).not.toContain('await-template')
    expect(result.kinds).toEqual([
      'system',
      'open',
      'deploy',
      ...applicationSteps,
    ])
    expect(result.states.at(-1)!.end?.kind).toBe('settled')
  })

  it('never exceeds its step bound, whatever the coordinator does', () => {
    // A template whose cold proof never finishes: the planner keeps offering a
    // legal step forever, and the RUN is what has to stop.
    const result = run(script, actions, { templateStuck: true, maxSteps: 5 })
    expect(result.kinds).toHaveLength(5)
    const final = result.states.at(-1)!
    expect(final.movesMade).toBe(5)
    expect(final.status).toBe('ended')
    expect(final.end).toBe(BOUNDED)
    expect(final.end?.kind).not.toBe('settled')

    // The reducer, not the planner, is the authority: one more `act` at the
    // bound ends the run instead of spending a step that does not exist.
    const beyond = reduce(result.states.at(-2)!, { type: 'act', acting: { kind: 'action' } })
    expect(beyond.movesMade).toBeLessThanOrEqual(5)
  })

  it('stops on request and takes no further step', () => {
    const result = run(script, actions, { stopAfter: 3 })
    const final = result.states.at(-1)!
    expect(result.kinds).toHaveLength(3)
    expect(final.status).toBe('ended')
    expect(final.end?.kind).toBe('stopped')
    expect(final.acting).toBeNull()
    // A stopped run is not a completed one, so loop mode leaves it alone.
    expect(autoplayCompleted(final.end)).toBe(false)
    expect(reduce(final, { type: 'act', acting: { kind: 'action' } })).toBe(final)

    // And it restarts cleanly, with a fresh budget and a new run number.
    const restarted = reduce(final, { type: 'start' })
    expect(restarted.status).toBe('running')
    expect(restarted.movesMade).toBe(0)
    expect(restarted.end).toBeNull()
    expect(restarted.runs).toBe(final.runs + 1)
  })

  it('narrates every step in plain language and names the stage it is in', () => {
    const result = run(script, actions)
    for (const [index, narration] of result.narrations.entries()) {
      expect(narration.length).toBeGreaterThan(40)
      // No identifiers, no jargon-only sentences: this is read out loud.
      expect(narration).toMatch(/[a-z]{4,} [a-z]{2,}/)
      expect(DEMO_STAGES).toContain(result.plans[index]!.stage)
      expect(result.plans[index]!.stage).toBe(demoStageOf(result.plans[index]!.kind))
    }
    // The two applications describe the SAME landed batch differently, because
    // what it means is different.
    expect(demoSettledDetail(script)).toContain(script.settlement)
  })
})

describe('the two applications are distinct without being two machines', () => {
  it('loops only after settlement, never after a failure, stop or safety bound', () => {
    expect(demoMayLoop({ kind: 'settled' })).toBe(true)
    expect(demoMayLoop({ kind: 'bounded' })).toBe(false)
    expect(demoMayLoop({ kind: 'failed' })).toBe(false)
    expect(demoMayLoop({ kind: 'stopped' })).toBe(false)
  })

  it('drives different presets and says different things about the same batch', () => {
    expect(AUCTION_SCRIPT.presetId).toBe('auction')
    expect(SHOP_SCRIPT.presetId).toBe('shop')
    expect(demoSettledDetail(AUCTION_SCRIPT)).not.toBe(
      demoSettledDetail(SHOP_SCRIPT),
    )
    // Each action of each application has its own sentence, so the log is not
    // a generic "action accepted" four times over.
    for (const [script, actions] of [
      [AUCTION_SCRIPT, AUCTION_ACTIONS],
      [SHOP_SCRIPT, SHOP_ACTIONS],
    ] as const) {
      for (const action of actions) {
        expect(script.moments[action.id], `${script.key}/${action.id}`).toBeTruthy()
      }
    }
  })

  it('stops rather than pretending when the application is not published here', () => {
    // No actions at all: there is nothing legal to submit, so the planner never
    // offers an `action` step and the run settles on the deployment alone
    // rather than inventing calls the preset does not define.
    const result = run(AUCTION_SCRIPT, [])
    expect(result.kinds).not.toContain('action')
    expect(result.states.at(-1)!.end?.kind).toBe('settled')
  })

  it('exposes a stage strip a viewer can follow', () => {
    expect(demoStageIndex(null)).toBe(-1)
    expect(demoStageIndex('system')).toBe(0)
    expect(demoStageIndex('checkpoint')).toBe(DEMO_STAGES.length - 1)
  })

  it('paces itself for a room rather than for a machine', () => {
    // Deliberate pacing: every offered delay is at least a second, and the
    // shipped default is one a reader can keep up with.
    expect(Math.min(...AUTOPLAY_DELAYS)).toBeGreaterThanOrEqual(1_000)
    expect(AUTOPLAY_DELAYS).toContain(DEMO_LIMITS.delayMs)
    // The end card survives long enough to be read before a loop restarts it.
    expect(DEMO_LIMITS.restartMs).toBeGreaterThan(5 * DEMO_LIMITS.delayMs)
  })
})
