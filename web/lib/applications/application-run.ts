/**
 * The presenter's autoplay policy for the two APPLICATION rooms - the
 * commit-reveal uniform-price auction and the persistent tokenized shop.
 *
 * This module decides WHICH step of the real room lifecycle comes next and WHAT
 * to say about it. It decides nothing else: it never fetches, never builds a
 * request and never touches React. It is handed a description of what already
 * exists on the coordinator (`DemoProgress`) and returns the one step that
 * is legal from there, in the same spirit as `lib/card/autoplay.ts` returning a
 * step out of the list the duel's own buttons render.
 *
 * THE STEPS ARE THE REAL LIFECYCLE, in the order the coordinator admits them:
 *
 *   system     read /demo/v1/system - the explorer root, the measured proof
 *              time and whether the single GPU is already busy
 *   prepare    POST a cold template from the certified preset; this executes
 *              the application's cold state and PROVES it on the GPU
 *   settle     wait for that template to reach ROOM_READY
 *   open       POST a room from the prepared template
 *   deploy     POST its deployment and wait for the L1 transaction
 *   action     POST one of the preset's own room actions, in its own order
 *   checkpoint POST a checkpoint and wait for the batch to be proven and
 *              accepted on L1
 *
 * There is no scripted alternative and no simulated branch. If a step cannot
 * run the planner does not invent one - it returns null, and the caller reports
 * the coordinator's own words and stops.
 *
 * React-free and side-effect-free, so a whole run can be driven headless.
 */

/** The lifecycle stages, in the order the strip on screen shows them. */
export const DEMO_STAGES = [
  'system',
  'prepare',
  'open',
  'action',
  'checkpoint',
] as const

export type DemoStage = (typeof DEMO_STAGES)[number]

export type DemoStepKind =
  | 'system'
  | 'prepare'
  | 'await-template'
  | 'open'
  | 'deploy'
  | 'action'
  | 'checkpoint'

/** Which stage of the strip a step belongs to. */
const STAGE_OF: Record<DemoStepKind, DemoStage> = {
  system: 'system',
  prepare: 'prepare',
  'await-template': 'prepare',
  open: 'open',
  deploy: 'open',
  action: 'action',
  checkpoint: 'checkpoint',
}

export function demoStageOf(kind: DemoStepKind): DemoStage {
  return STAGE_OF[kind]
}

/**
 * Pacing and bounds.
 *
 * `delayMs` is the pause between steps, chosen so a room can read the sentence
 * before the thing it describes happens. `maxSteps` is the hard bound on a run:
 * the lifecycle above is nine steps at its longest, so twelve leaves room for
 * an extra action without ever letting a run become unbounded.
 *
 * `restartMs` is deliberately long. A finished run ends on a checkpoint receipt
 * with a real transaction hash on it, and an unattended stand that wiped that
 * receipt two seconds later would be showing the one thing nobody could read.
 */
export const DEMO_LIMITS = Object.freeze({
  delayMs: 2_000,
  maxSteps: 12,
  /** Pause on the end card before loop mode starts the next run. */
  restartMs: 12_000,
})

/** What exists on the coordinator right now, as far as this demo can see. */
export interface DemoProgress {
  /** True once `/demo/v1/system` has been read at least once. */
  readonly system: boolean
  readonly template: { readonly id: string; readonly phase: string } | null
  readonly room: {
    readonly id: string
    readonly phase: string
    /** True once the room carries a chain room id, i.e. it exists on L1. */
    readonly deployed: boolean
  } | null
  /** Preset actions this run has already handed to the room. */
  readonly actionsTaken: number
  /** Preset actions this application publishes in total. */
  readonly actionCount: number
  /** Checkpoints this run has landed. */
  readonly checkpoints: number
  readonly stepsMade: number
  readonly maxSteps?: number
}

export interface DemoPlan {
  readonly kind: DemoStepKind
  readonly stage: DemoStage
  readonly narration: string
  /** Set only on an `action` step: which of the preset's actions to send. */
  readonly actionIndex?: number
}

/** The phase a template must reach before a room can be opened from it. */
export const DEMO_TEMPLATE_READY = 'ROOM_READY'

/** The one room phase that accepts an action. */
export const DEMO_ROOM_ACCEPTING = 'ACTIVE'

/**
 * The application-specific words. Everything else about a run is identical
 * between the auction and the shop, which is the point: both are ordinary
 * rooms and the demo should make that visible rather than dress each up as a
 * bespoke machine.
 */
export interface DemoScript {
  readonly key: string
  /** The coordinator preset this application is built from. */
  readonly presetId: string
  readonly title: string
  /** A short noun for the room, used inside generated sentences. */
  readonly noun: string
  /** Name given to the room this run opens. */
  readonly roomName: string
  /** What the cold proof establishes for this application. */
  readonly coldState: string
  /** What a landed checkpoint means here, in the application's own terms. */
  readonly settlement: string
  /** Sentence per preset action id; a missing id falls back to the label. */
  readonly moments: Readonly<Record<string, string>>
  /** Cumulative action counts after which this application settles a batch. */
  readonly checkpointAfterActions?: readonly number[]
  /** What each accepted checkpoint establishes, in checkpoint order. */
  readonly checkpointSettlements?: readonly string[]
  /** Presenter sentence shown while each checkpoint is being proved. */
  readonly checkpointNarrations?: readonly string[]
  /** Per-application bounds for longer scripts such as the twelve-call vault. */
  readonly maxSteps?: number
  readonly maxRuns?: number
  readonly maxSessionMs?: number
  readonly restartMs?: number
}

/** A stand starts another room only after a checkpoint actually settled. */
export function demoMayLoop(end: { readonly kind: string } | null | undefined): boolean {
  return end?.kind === 'settled'
}

export const ERC7540_SCRIPT: DemoScript = Object.freeze({
  key: 'erc7540',
  presetId: 'erc7540',
  title: 'ERC-7540 proof-backed round trip',
  noun: 'asynchronous vault',
  roomName: 'ERC-7540 Alice + Bob round trip',
  coldState:
    'the deployed vault and asset token runtimes, funded Alice and Bob balances, approvals, manager role, and every storage word the request/claim lifecycle may touch',
  settlement:
    '12 signed peer transactions became 2 ordered room blocks and 1 accepted proof checkpoint, with both deposit and redemption preserving Pending → Claimable → Claimed',
  maxSteps: 24,
  maxRuns: 100,
  maxSessionMs: 8 * 60 * 60 * 1_000,
  restartMs: 12_000,
  moments: Object.freeze({
    'alice-request-deposit':
      'Alice signs a request for 100 assets. The assets enter the vault, but she has no shares yet: her request is Pending.',
    'bob-request-deposit':
      'Bob independently signs a request for 60 assets. Request id zero aggregates by controller, so Alice and Bob remain separate.',
    'manager-fulfill-alice-deposit':
      'The Vault Manager processes Alice’s request. It becomes Claimable; the manager does not push shares to Alice.',
    'manager-fulfill-bob-deposit':
      'The Vault Manager processes Bob’s request. Bob must still make the separate ERC-4626 claim call.',
    'alice-claim-deposit':
      'Alice pulls 100 shares with the overloaded deposit claim method. Her deposit lifecycle is now Claimed.',
    'bob-claim-deposit':
      'Bob pulls 60 shares. The first room block now contains six accepted transactions.',
    'alice-request-redeem':
      'Alice locks 40 shares and requests redemption. No assets leave the vault while the request is Pending.',
    'bob-request-redeem':
      'Bob locks 20 shares under his own controller state.',
    'manager-fulfill-alice-redeem':
      'The manager makes Alice’s 40-share redemption Claimable without claiming it for her.',
    'manager-fulfill-bob-redeem':
      'The manager makes Bob’s 20-share redemption Claimable.',
    'alice-claim-redeem':
      'Alice pulls 40 assets with redeem. The locked shares are burned only in this distinct claim step.',
    'bob-claim-redeem':
      'Bob pulls 20 assets. All twelve calls are accepted; the two blocks are ready for one proof checkpoint.',
  }),
})

export const DVP_SCRIPT: DemoScript = Object.freeze({
  key: 'dvp',
  presetId: 'dvp',
  title: 'Atomic delivery versus payment',
  noun: 'DvP prototype',
  roomName: 'Atomic DvP live prototype',
  coldState:
    'the generic settlement-state slot starts at the value fixed by the cold proof before either counterparty acts',
  settlement:
    'the seller lock and buyer payment authorization were accepted in order, proven together, and landed in one L1 checkpoint',
  moments: Object.freeze({
    'seller-lock':
      'The seller locks the delivery side into room block one. This is accepted by the room but remains provisional until the checkpoint lands.',
    'buyer-pay':
      'The buyer authorizes payment in room block two. The proof now binds both sides of this generic DvP prototype into one transition.',
  }),
})

export const ERC4626_SCRIPT: DemoScript = Object.freeze({
  key: 'erc4626',
  presetId: 'erc4626',
  title: 'ERC-4626 shares across three checkpoints',
  noun: 'progressive ERC-4626 vault',
  roomName: 'ERC-4626 three-checkpoint lifecycle',
  coldState:
    'the real RoomVault4626 and RoomERC20 runtimes, two funded fixture accounts, exact token allowances, an empty vault and every storage word the three batches may touch',
  settlement:
    'checkpoint 1 issued 100 shares for 100 assets, checkpoint 2 raised vault liquidity to 150 assets without dilution, and checkpoint 3 burned the 100 shares for 149 liquid assets under the vault’s virtual-offset rounding rule',
  checkpointAfterActions: Object.freeze([2, 4, 6]),
  checkpointSettlements: Object.freeze([
    'Checkpoint 1 is final: 100 deposited assets issued 100 ERC-4626 shares to the investor.',
    'Checkpoint 2 is final: 50 externally funded assets entered without new shares, taking vault liquidity from 100 to 150 and increasing assets per share.',
    'Checkpoint 3 is final: the investor burned all 100 shares and received 149 liquid assets; one asset remains because the certified vault uses a one-unit virtual offset.',
  ]),
  checkpointNarrations: Object.freeze([
    'Proving checkpoint one: the quote and deposit occupy its two L2 blocks. Only after this batch lands are the 100 issued shares canonical.',
    'Proving checkpoint two: the vault starts from checkpoint one, then accepts 50 funded assets without minting shares. This is a continuation, not a fresh vault.',
    'Proving checkpoint three: the redemption quote and burn replay both earlier checkpoints, convert the appreciated shares, and settle the resulting liquid assets on L1.',
  ]),
  maxSteps: 18,
  moments: Object.freeze({
    'quote-share-issue':
      'The investor quotes a 100-asset deposit in room block one. With an empty vault and its one-unit virtual offset, the real contract returns exactly 100 shares.',
    'issue-shares':
      'The investor deposits 100 funded assets in room block two. The vault mints 100 shares, ready for checkpoint one but still provisional until it lands.',
    'observe-vault-liquidity':
      'Checkpoint one is now the opening state for the next batch. The liquidity provider reads the proved 100-asset vault balance in room block three.',
    'add-liquidity':
      'The provider adds 50 real asset tokens in room block four without receiving shares. Supply stays at 100 while total assets rise to 150.',
    'quote-redemption':
      'Starting from checkpoint two, the investor quotes all 100 shares. The ERC-4626 virtual-offset formula returns 149 assets rather than hiding the rounding unit.',
    'redeem-shares':
      'The investor burns all 100 shares in room block six and receives 149 liquid assets. Checkpoint three will make that exit canonical.',
  }),
})

export const AMM_SCRIPT: DemoScript = Object.freeze({
  key: 'amm',
  presetId: 'amm',
  title: 'Commit-reveal AMM · MEV avoidance',
  noun: 'MEV-resistant AMM',
  roomName: 'Commit-reveal AMM live room',
  coldState:
    'the cold proof pins the real CommitRevealAMM runtime and its empty 22-slot state before the coordinator initializes a 1:1 pool',
  settlement:
    '8 signed transactions became 2 ordered room blocks: two opaque commitments, a sealed reveal order, two proof-visible rejected MEV attempts, two swaps in committed order, and 1 accepted L1 checkpoint',
  maxSteps: 20,
  moments: Object.freeze({
    'initialize-pool':
      'The coordinator initializes equal 1,000,000 / 1,000,000 reserves and funds two bounded trader accounts. This is transaction one of room block one.',
    'victim-commit':
      'The victim commits a salted hash. Direction, 100,000 input size and the 90,000 limit are absent from this transaction.',
    'attacker-commit':
      'The searcher may commit too, but it does so blind: its hash fixes the order before the victim reveals any trade parameters.',
    'seal-order':
      'The coordinator closes commitments. From this point a newly invented front-run cannot enter the batch and the reveal cursor is fixed.',
    'reactive-front-run-blocked':
      'After the victim data would become actionable, the searcher tries a direct front-run. The sealed phase records it as rejected with zero reserve movement.',
    'out-of-order-reveal-blocked':
      'The searcher next tries to reveal ahead of position zero. The contract records a second no-op and leaves the reveal cursor on the victim.',
    'victim-reveal':
      'The victim reveals the committed 100,000 token-0 swap. The hash, owner, direction, size, minimum output and salt all match, so it executes first.',
    'blind-order-reveal':
      'Only now can the searcher reveal its earlier blind commitment. Both swaps preserve token totals and the constant-product invariant before GPU proving.',
  }),
})

export const AUCTION_SCRIPT: DemoScript = Object.freeze({
  key: 'auction',
  presetId: 'auction',
  title: 'Uniform-price auction',
  noun: 'auction',
  roomName: 'Commit-reveal auction',
  coldState:
    'the seller inventory, the commitment counter and the proceeds account all start at values the cold proof fixes, so nothing about the clearing can be back-dated',
  settlement:
    'the clearing price and every fill are now a proven consequence of the committed bids; the seller proceeds and the winner inventory moved together in one accepted batch',
  moments: Object.freeze({
    'commit-bid':
      'A bidder commits a sealed bid into the first room block. Only the commitment is published - no price and no quantity leaves the bidder until the reveal.',
    'clear-auction':
      'The auctioneer reveals and clears in the second room block. Inventory is conserved and the partial fills are deterministic, so every bidder can recompute the same result.',
  }),
})

export const SHOP_SCRIPT: DemoScript = Object.freeze({
  key: 'shop',
  presetId: 'shop',
  title: 'Always-online tokenized shop',
  noun: 'shop',
  roomName: 'Persistent tokenized shop',
  coldState:
    'the shelf inventory and the unit price are fixed by the cold proof, so the shop cannot quietly sell what it does not have or reprice after a customer has committed',
  settlement:
    'the purchase is proven and the delivery is allocated even though the customer has already gone offline; the seller proceeds and the buyer inventory moved in the same accepted batch',
  moments: Object.freeze({
    'register-session':
      'The customer registers a session key and a spending limit in the first room block. This is the admission, not the purchase.',
    'buy-item':
      'The customer submits one signed purchase and immediately disconnects. The room keeps the obligation; the proof that settles it is the operator’s to produce.',
  }),
})

export interface DemoAction {
  readonly id: string
  readonly label: string
  readonly actor: string
}

export interface DemoContext {
  readonly script: DemoScript
  readonly actions: readonly DemoAction[]
  readonly progress: DemoProgress
}

/**
 * The next step, or null when autoplay should stop.
 *
 * Null means one of two things and the caller distinguishes them: the run spent
 * its bound, or the application reached its settled end - a deployed room whose
 * every action has been handed over and proven on L1.
 */
export function planDemoStep(context: DemoContext): DemoPlan | null {
  const { script, actions, progress } = context
  const maxSteps = progress.maxSteps ?? DEMO_LIMITS.maxSteps
  if (progress.stepsMade >= maxSteps) return null

  if (!progress.system) {
    return step(
      'system',
      'Reading the coordinator: which block explorer this stand publishes, how long one proof takes on its GPU, whether that GPU is already busy, and whether a cold template for this application has been prepared before.',
    )
  }

  const template = progress.template
  if (template === null) {
    return step(
      'prepare',
      `Preparing a cold template from the certified "${script.presetId}" preset. This executes the ${script.noun}’s starting state and proves it on the stand’s single GPU - ${script.coldState}.`,
    )
  }
  if (template.phase !== DEMO_TEMPLATE_READY) {
    return step(
      'await-template',
      `Waiting for the cold proof to finish. The template is at ${template.phase}; a room can only be opened from one that has reached ${DEMO_TEMPLATE_READY}.`,
    )
  }

  const room = progress.room
  if (room === null) {
    const checkpointCount = script.checkpointAfterActions?.length ?? 1
    return step(
      'open',
      `Opening a room from the prepared template. The ${script.noun} runs inside it as ${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'}, each carrying two L2 blocks whose combined transition one proof settles.`,
    )
  }
  if (!room.deployed) {
    return step(
      'deploy',
      `Deploying the room on L1. This is a real transaction: it registers the room against the cold template it was prepared from, and its hash appears in the log below.`,
    )
  }

  const actionCount = Math.min(actions.length, progress.actionCount)
  const milestones = script.checkpointAfterActions ?? [actionCount]
  const nextMilestone = milestones[progress.checkpoints]
  if (nextMilestone !== undefined && progress.actionsTaken < Math.min(nextMilestone, actionCount)) {
    const index = progress.actionsTaken
    const action = actions[index]!
    return {
      kind: 'action',
      stage: 'action',
      actionIndex: index,
      narration:
        script.moments[action.id] ??
        `${action.actor} sends "${action.label}" as a room action. It is admitted now; nothing about it is canonical until a proof settles the block it lands in.`,
    }
  }

  if (nextMilestone !== undefined && progress.actionsTaken >= Math.min(nextMilestone, actionCount)) {
    return step(
      'checkpoint',
      script.checkpointNarrations?.[progress.checkpoints]
        ?? `Proving the room’s next two blocks and submitting batch ${progress.checkpoints + 1} to L1. This is the long pause of the demo - one GPU, and the ${script.noun} transition in one proof.`,
    )
  }
  return null
}

function step(kind: DemoStepKind, narration: string): DemoPlan {
  return { kind, stage: demoStageOf(kind), narration }
}

/**
 * The sentence shown when a run finishes on its own, in the application's own
 * terms. Kept next to the script so the two demos say different - and true -
 * things about the same landed batch.
 */
export function demoSettledDetail(script: DemoScript): string {
  return `The room settled on L1: ${script.settlement}. The transaction hash is in the log below and can be opened in the block explorer this coordinator advertises.`
}

export function demoCheckpointSettlement(
  script: DemoScript,
  checkpointIndex: number,
): string {
  return script.checkpointSettlements?.[checkpointIndex] ?? script.settlement
}

/** How far through the strip a run is, for the stage highlight. */
export function demoStageIndex(stage: DemoStage | null): number {
  return stage === null ? -1 : DEMO_STAGES.indexOf(stage)
}
