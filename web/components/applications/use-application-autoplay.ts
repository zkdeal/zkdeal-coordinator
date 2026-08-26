'use client'

/**
 * The timer half of the two application demos: it announces the planned
 * step, waits, and then makes the real coordinator call.
 *
 * It is deliberately the same shape as `card-duel/use-card-autoplay.ts` - plan,
 * announce, pause, act, re-plan from the fresh state - and it drives the same
 * shared run reducer. There is no `while` loop: each completed step re-renders,
 * the effect re-plans from what the coordinator now holds, and the next step is
 * scheduled. That is also what makes stopping cheap, because there is never
 * more than one pending timer to clear.
 *
 * IT DRIVES THE REAL FLOW. Every step is a `/demo/v1` call: a cold template
 * prepared from the certified preset and proved on the GPU, a room opened from
 * it, that room deployed on L1, the preset's own actions handed over, and a
 * checkpoint proved and accepted. Nothing is simulated and nothing is
 * substituted when a step fails - the coordinator's own explanation goes on
 * screen and the run stops.
 *
 * IT RESPECTS THE SINGLE GPU. Cold proving and checkpointing both occupy the
 * one CUDA worker, and they serialize. Before either of those steps the run
 * checks the coordinator's proving queue and HOLDS while it is busy - visibly,
 * with the queue depth - rather than posting a job that would sit behind
 * another room's proof. A hold is not an end: the run keeps its budget and
 * resumes by itself.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Preset, Room, Template } from '@/components/demo-console/api'
import {
  createAutoplayRunReducer,
  createAutoplayRunState,
  type AutoplayRunState,
} from '@/lib/autoplay/run'
import {
  claimDemoL1,
  releaseDemoL1,
  demoL1InFlight,
  DEMO_BOUNDED_END,
  DEMO_GPU_HOLD_LIMIT_MS,
  DEMO_GPU_STEPS,
  DEMO_L1_STEPS,
  DEMO_STEP_LABELS,
  DEMO_STOPPED_END,
} from '@/components/applications/autoplay-policy'
import { readDemoSystem, type DemoSystem } from '@/lib/demo-system'
import { runDemoStep } from '@/lib/applications/execute'
import { closeDemoRoom } from '@/lib/applications/transport'
import {
  planDemoStep,
  DEMO_LIMITS,
  demoMayLoop,
  demoSettledDetail,
  type DemoPlan,
  type DemoProgress,
  type DemoScript,
  type DemoStage,
  type DemoStepKind,
} from '@/lib/applications/application-run'
import { demoLogEntry, type DemoLogEntry } from '@/lib/applications/log'

export interface DemoActing {
  readonly kind: DemoStepKind
  readonly label: string
}

export type DemoAutoplayState = AutoplayRunState<DemoStage, DemoActing>

const reduce = createAutoplayRunReducer<DemoStage, DemoActing>({
  bounded: DEMO_BOUNDED_END,
  stopped: DEMO_STOPPED_END,
})

export interface DemoAutoplayControls {
  readonly state: DemoAutoplayState
  readonly running: boolean
  /** True while Stop is closing the current room to further actions. */
  readonly closing: boolean
  readonly canStart: boolean
  readonly system: DemoSystem | null
  readonly preset: Preset | null
  readonly template: Template | null
  readonly room: Room | null
  readonly actionsTaken: number
  readonly sessionRuns: number
  readonly log: readonly DemoLogEntry[]
  /** The coordinator's own phase while a job runs, e.g. PROVING or L1_PENDING. */
  readonly phase: string | null
  readonly deadlineSeconds: number
  readonly setDeadlineSeconds: (seconds: number) => void
  readonly start: () => void
  readonly stop: () => void
  readonly restart: () => void
  readonly setDelayMs: (delayMs: number) => void
  readonly setLoop: (loop: boolean) => void
}

export function useDemoAutoplay(script: DemoScript): DemoAutoplayControls {
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    createAutoplayRunState<DemoStage, DemoActing>({
      delayMs: DEMO_LIMITS.delayMs,
      maxMoves: script.maxSteps ?? DEMO_LIMITS.maxSteps,
    }),
  )
  const [system, setSystem] = useState<DemoSystem | null>(null)
  const [preset, setPreset] = useState<Preset | null>(null)
  const [template, setTemplate] = useState<Template | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [actionsTaken, setActionsTaken] = useState(0)
  const [checkpoints, setCheckpoints] = useState(0)
  const [log, setLog] = useState<readonly DemoLogEntry[]>([])
  const [phase, setPhase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const [deadlineSeconds, setDeadlineSeconds] = useState(120)
  const [sessionRuns, setSessionRuns] = useState(0)
  const sessionStartedAt = useRef<number | null>(null)
  /** Bumped by a held run so the effect re-evaluates its own hold condition. */
  const [holdTick, setHoldTick] = useState(0)
  /** Flips synchronously so a double-invoked effect cannot post a step twice. */
  const inFlight = useRef(false)
  /** Stop may arrive while a room-opening call is still returning. */
  const closeRequested = useRef(false)
  /** When the current wait-for-the-GPU started, so it cannot last forever. */
  const heldSince = useRef<number | null>(null)

  const running = state.status === 'running'
  const { movesMade, maxMoves, delayMs, announced } = state

  const append = useCallback((entry: DemoLogEntry) => {
    setLog((current) => [...current, entry])
  }, [])

  const reset = useCallback(() => {
    inFlight.current = false
    closeRequested.current = false
    setPreset(null)
    // A ready cold template is deliberately reusable. Every loop iteration
    // opens a new room, but preparing the same deployed vault/token state again
    // would waste the stand's single GPU and defeat the preset cache.
    setTemplate((current) =>
      current?.phase === 'ROOM_READY' && current.presetId === script.presetId ? current : null,
    )
    setRoom(null)
    setActionsTaken(0)
    setCheckpoints(0)
    setLog([])
    setPhase(null)
    setBusy(false)
    setClosing(false)
  }, [script.presetId])

  const beginRun = useCallback(() => {
    reset()
    setSessionRuns((current) => current + 1)
    dispatch({ type: 'start' })
  }, [reset])

  const start = useCallback(() => {
    sessionStartedAt.current = Date.now()
    setSessionRuns(0)
    beginRun()
  }, [beginRun])

  const stop = useCallback(() => {
    closeRequested.current = true
    dispatch({ type: 'loop', loop: false })
    dispatch({ type: 'stop' })
  }, [])
  const restart = useCallback(() => start(), [start])
  const setDelayMs = useCallback((value: number) => dispatch({ type: 'delay', delayMs: value }), [])
  const setLoop = useCallback((value: boolean) => dispatch({ type: 'loop', loop: value }), [])

  /* --------------------------- the coordinator poll -------------------------- */

  // Read once on mount so the page can say what stand it is pointed at before
  // anybody presses anything, then keep it fresh WHILE running so the GPU hold
  // below reacts to another room's proof starting.
  useEffect(() => {
    let alive = true
    const read = () => {
      void readDemoSystem().then((next) => {
        if (!alive) return
        // Replaced only when something actually changed. `execute` closes over
        // this value and the step timer is cleared whenever `execute` changes,
        // so a poll that handed back an equal-but-new object every five seconds
        // would keep resetting a pause the audience is waiting through.
        setSystem((current) =>
          current !== null && JSON.stringify(current) === JSON.stringify(next) ? current : next,
        )
      })
    }
    read()
    if (!running) return () => {
      alive = false
    }
    const timer = window.setInterval(read, 5_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [running])

  /*
   * Stop is immediate in the presenter, but room closure is deliberately
   * ordered after the active coordinator call. That prevents a completed
   * deploy/checkpoint callback from reopening the same room after it was
   * marked closed. If Stop lands while the `open` call is returning, the
   * request stays armed until that room id reaches state.
   */
  useEffect(() => {
    if (!closeRequested.current || busy || closing) return
    if (!room) {
      if (!inFlight.current) closeRequested.current = false
      return
    }

    closeRequested.current = false
    const roomId = room.id
    setClosing(true)
    void closeDemoRoom(roomId)
      .then((closed) => {
        setRoom((current) => (current?.id === roomId ? closed : current))
        append(
          demoLogEntry({
            kind: 'open',
            title: `Room closed · ${closed.name}`,
            detail:
              'The coordinator now refuses further actions for this demo room. Its accepted actions and proof receipts remain readable.',
            status: 'accepted',
          }),
        )
      })
      .catch((caught) => {
        append(
          demoLogEntry({
            kind: 'open',
            title: 'Room close was refused',
            detail:
              caught instanceof Error
                ? caught.message
                : 'The coordinator refused to close the room.',
            status: 'refused',
          }),
        )
      })
      .finally(() => setClosing(false))
  }, [append, busy, closing, room])

  const progress = useMemo<DemoProgress>(
    () => ({
      system: preset !== null,
      template: template ? { id: template.id, phase: template.phase } : null,
      room: room ? { id: room.id, phase: room.phase, deployed: room.chainRoomId !== null } : null,
      actionsTaken,
      actionCount: preset?.actions.length ?? 0,
      checkpoints,
      stepsMade: movesMade,
      maxSteps: maxMoves,
    }),
    [preset, template, room, actionsTaken, checkpoints, movesMade, maxMoves],
  )

  const actions = useMemo(
    () =>
      (preset?.actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        actor: action.actor,
      })),
    [preset],
  )

  /* ------------------------------ step execution ----------------------------- */

  const execute = useCallback(
    async (plan: DemoPlan) => {
      if (inFlight.current) return
      inFlight.current = true
      const claimsL1 = DEMO_L1_STEPS.includes(plan.kind)
      if (claimsL1) claimDemoL1()
      setBusy(true)
      setPhase(null)
      try {
        const result = await runDemoStep(plan, {
          script,
          system,
          preset,
          template,
          room,
          deadlineSeconds,
          onPhase: setPhase,
        })
        // Applied only after the step succeeded, and only what it reported. An
        // absent field means unchanged, so nothing here can advance a run past
        // something the coordinator did not actually do.
        if (result.system) setSystem(result.system)
        if (result.preset) setPreset(result.preset)
        if (result.template !== undefined) setTemplate(result.template)
        if (result.room) setRoom(result.room)
        if (result.actionTaken) setActionsTaken((current) => current + 1)
        if (result.checkpoints !== undefined) setCheckpoints(result.checkpoints)
        for (const entry of result.entries) append(entry)
      } catch (caught) {
        const reported =
          caught instanceof Error ? caught.message : 'The coordinator refused this step.'
        append(
          demoLogEntry({
            kind: plan.kind,
            title: `Stopped at "${DEMO_STEP_LABELS[plan.kind]}"`,
            detail: reported,
            status: 'refused',
          }),
        )
        dispatch({
          type: 'end',
          end: {
            kind: 'failed',
            headline: 'The demo stopped here, in the coordinator’s own words',
            detail: reported,
          },
        })
      } finally {
        if (claimsL1) releaseDemoL1()
        // Re-read the prover BEFORE the next step is planned. The five-second
        // poll alone left a window in which two demos on this page could both
        // pass the busy check and both post a checkpoint; they are queued
        // rather than lost, but the point of the hold is that the second one
        // SAYS it is waiting instead of silently sitting in a queue.
        try {
          const next = await readDemoSystem()
          setSystem((current) =>
            current !== null && JSON.stringify(current) === JSON.stringify(next) ? current : next,
          )
        } catch {
          // A failed status read is not a reason to fail the step that just
          // succeeded; the poll tries again in five seconds.
        }
        inFlight.current = false
        setBusy(false)
        setPhase(null)
      }
    },
    [append, deadlineSeconds, preset, room, script, system, template],
  )

  /* --------------------------- announce, wait, act --------------------------- */

  useEffect(() => {
    if (!running) return
    if (busy) return

    /**
     * Ask this effect again shortly.
     *
     * A hold is released by something OUTSIDE this component - the other demo
     * finishing, or the coordinator's prover coming free - and neither of those
     * re-renders this hook by itself. The status poll only replaces `system`
     * when its content actually changed, so a hold without this would be a hold
     * forever. Returned as the effect's cleanup so at most one is pending.
     */
    const recheck = () => {
      const timer = window.setTimeout(() => setHoldTick((value) => value + 1), 1_500)
      return () => window.clearTimeout(timer)
    }

    const plan = planDemoStep({ script, actions, progress })
    if (!plan) {
      dispatch({
        type: 'end',
        end:
          movesMade >= maxMoves
            ? DEMO_BOUNDED_END
            : {
                kind: 'settled',
                headline: `${script.title} settled on L1`,
                detail: demoSettledDetail(script),
              },
      })
      return
    }

    // One operator key. The other demo on this page is mid-deploy or
    // mid-checkpoint, and two transactions from one key at one nonce is how the
    // second one gets refused.
    if (DEMO_L1_STEPS.includes(plan.kind) && demoL1InFlight() > 0) {
      dispatch({
        type: 'hold',
        hold: 'The other room on this page is submitting its own L1 transaction. This stand signs from one operator key, so this run waits for it rather than racing it.',
      })
      return recheck()
    }

    // One GPU. A cold proof or a checkpoint posted while another room is being
    // proven does not get a second device, it gets a queue - so the run stands
    // still, says so, and keeps its budget.
    if (DEMO_GPU_STEPS.includes(plan.kind) && system?.proverBusy) {
      heldSince.current ??= Date.now()
      const waited = Date.now() - heldSince.current
      if (waited > DEMO_GPU_HOLD_LIMIT_MS) {
        // A hold is not allowed to be forever. An unattended stand that waited
        // silently on a wedged prover would look exactly like a working one.
        dispatch({
          type: 'end',
          end: {
            kind: 'unavailable',
            headline: 'The prover never came free',
            detail: `The coordinator has reported its GPU busy for ${Math.round(
              waited / 60_000,
            )} minutes without this run reaching the front of the queue, so it stops here rather than waiting silently. Nothing was submitted and nothing was lost.`,
          },
        })
        return
      }
      dispatch({
        type: 'hold',
        hold: `The stand has one GPU and it is busy: ${system.proverQueueDepth} proof${
          system.proverQueueDepth === 1 ? '' : 's'
        } ahead of this one. Autoplay waits rather than queueing behind them. Waiting ${Math.round(
          waited / 1000,
        )} s so far.`,
      })
      return recheck()
    }
    heldSince.current = null
    dispatch({ type: 'hold', hold: null })

    const key = `${movesMade}:${plan.kind}:${plan.actionIndex ?? ''}`
    if (announced !== key) {
      dispatch({ type: 'announce', key, narration: plan.narration, focus: plan.stage })
    }

    const timer = window.setTimeout(() => {
      // Checked again HERE, not only when the step was planned. Two demos that
      // planned their deploy in the same render both waited the same pause and
      // both fired; the claim below is what makes the second one lose the race
      // instead of the coordinator's nonce. `execute` takes the claim
      // synchronously before its first await, so this read is authoritative.
      if (DEMO_L1_STEPS.includes(plan.kind) && demoL1InFlight() > 0) {
        setHoldTick((value) => value + 1)
        return
      }
      dispatch({ type: 'act', acting: { kind: plan.kind, label: DEMO_STEP_LABELS[plan.kind] } })
      void execute(plan)
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [
    running,
    busy,
    announced,
    delayMs,
    movesMade,
    maxMoves,
    progress,
    actions,
    script,
    system,
    execute,
    holdTick,
  ])

  /* ------------------------------- loop mode -------------------------------- */

  useEffect(() => {
    if (state.status !== 'ended' || !state.loop) return
    // Only a run that finished on its own restarts. A refusal or a deliberate
    // stop stays on screen until a human decides.
    if (!demoMayLoop(state.end)) return
    const elapsed = Date.now() - (sessionStartedAt.current ?? Date.now())
    if (sessionRuns >= (script.maxRuns ?? Number.POSITIVE_INFINITY)) {
      dispatch({ type: 'loop', loop: false })
      dispatch({
        type: 'end',
        end: {
          kind: 'settled',
          headline: `${script.title} completed ${sessionRuns} proof-backed runs`,
          detail: 'The 100-run stand limit was reached. The final L1 receipt remains visible.',
        },
      })
      return
    }
    if (elapsed >= (script.maxSessionMs ?? Number.POSITIVE_INFINITY)) {
      dispatch({ type: 'loop', loop: false })
      dispatch({
        type: 'end',
        end: {
          kind: 'settled',
          headline: `${script.title} reached its eight-hour stand limit`,
          detail: 'Looping ended cleanly after the last settlement. The final L1 receipt remains visible.',
        },
      })
      return
    }
    const timer = window.setTimeout(
      () => beginRun(),
      script.restartMs ?? DEMO_LIMITS.restartMs,
    )
    return () => window.clearTimeout(timer)
  }, [state.status, state.loop, state.end, beginRun, script, sessionRuns])

  return useMemo(
    () => ({
      state,
      running,
      closing,
      canStart: !closing && system?.decision !== 'DEGRADED',
      system,
      preset,
      template,
      room,
      actionsTaken,
      sessionRuns,
      log,
      phase,
      deadlineSeconds,
      setDeadlineSeconds,
      start,
      stop,
      restart,
      setDelayMs,
      setLoop,
    }),
    [
      state,
      running,
      closing,
      system,
      preset,
      template,
      room,
      actionsTaken,
      sessionRuns,
      log,
      phase,
      deadlineSeconds,
      start,
      stop,
      restart,
      setDelayMs,
      setLoop,
    ],
  )
}
