'use client'

/**
 * The half of the duel that talks to a real room.
 *
 * `useCardDuel` owns the private half - the vault, the proofs, the rules and
 * the move log. This hook owns everything that leaves the tab: finding or
 * opening a card room, handing it one move at a time, and asking it to prove
 * and checkpoint a batch on L1. The two meet through `markMove` and
 * `markCheckpoint`, so no raw state setter crosses the boundary and the log
 * stays the single description of where every move stands.
 *
 * The policy itself is not here. `lib/card/settlement.ts` decides, as a pure
 * function of the log, whether the next step is a submission, a checkpoint or
 * nothing - which is what lets the whole cadence be tested headless. This hook
 * only runs that decision, one step at a time, and never while a proof is in
 * flight in the vault.
 *
 * HONESTY RULES THIS HOOK ENFORCES.
 *  - A move is `submitted` only when the coordinator answered with an accepted
 *    action id, and `checkpointed` only when a checkpoint job FINISHED and the
 *    coordinator published a receipt for it. A finished job with no receipt is
 *    reported as an anomaly and settles nothing.
 *  - Every refusal is surfaced in the coordinator's own words and LATCHES:
 *    automatic settlement stops rather than retrying a broken room in a loop.
 *    Moves keep being built and stay honestly labelled local-only.
 *  - A move is signed by the seat that PROVED it. The envelope is built here,
 *    from the room's own chain id and the seat's own nonce, and the signer is
 *    recovered back out of the signature before anything is sent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cardRoomSigning,
  cardSeatNonce,
  signCardMoveEnvelope,
  type CardRoomSigning,
} from '@/lib/card/envelope'
import {
  CARD_ROOM_MINIMUM_DEADLINE_BLOCKS,
  CARD_ROOM_PROVING_DEADLINE_SECONDS,
  checkpointCardRoom,
  createCardRoom,
  findCardRoom,
  readCardCoordinator,
  submitCardMove,
  type CardCoordinator,
  type CardRoomSummary,
  type CardRoomTarget,
  type CardRoomTemplate,
} from '@/lib/card/demo-room'
import { deadlineBlocksForSeconds } from '@/lib/demo-system'
import { l1Receipt, type L1Receipt } from '@/lib/l1-receipt'
import { useTransientAlert } from '@/lib/transient-alert'
import {
  cardCheckpointDue,
  cardCheckpointHint,
  cardCheckpointPolicy,
  cardCheckpointRecord,
  cardProvenSequences,
  cardRoomCheckpoints,
  cardSettlementAction,
  cardSettlementCounts,
  type CardCheckpointRecord,
} from '@/lib/card/settlement'
import type {
  CardSettlementActivity,
  CardSettlementControls,
  CardSettlementDuel,
} from './settlement-types'

export type {
  CardSettlementActivity,
  CardSettlementControls,
  CardSettlementDuel,
} from './settlement-types'

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback
}

export function useCardSettlement(duel: CardSettlementDuel): CardSettlementControls {
  const { session, busy, duelContract, auditBytes, markMove, markCheckpoint, setDuelAddress } = duel
  const [room, setRoom] = useState<CardRoomTarget | null>(null)
  const [rooms, setRooms] = useState<readonly CardRoomSummary[]>([])
  const [deployment, setDeployment] = useState<L1Receipt | null>(null)
  const [deadlineSeconds, setDeadlineSeconds] = useState(CARD_ROOM_PROVING_DEADLINE_SECONDS)
  const [reason, setReason] = useState<string | null>(null)
  const [template, setTemplate] = useState<CardRoomTemplate | null>(null)
  const [coordinator, setCoordinator] = useState<CardCoordinator | null>(null)
  const [checkpoints, setCheckpoints] = useState<readonly CardCheckpointRecord[]>([])
  const [activity, setActivity] = useState<CardSettlementActivity>('idle')
  const [stage, setStage] = useState<string | null>(null)
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const {
    message: notice,
    show: showNotice,
    dismiss: dismissNotice,
  } = useTransientAlert()
  const [auto, setAuto] = useState(true)

  /**
   * One coordinator call at a time, latched in a ref rather than in `activity`.
   *
   * `activity` is state, so it is only visible to the driver effect on the NEXT
   * render - and React's development strict mode runs a mount effect twice
   * before any render happens in between. Without this ref that double run
   * files the same move as two room actions, which the coordinator would
   * cheerfully accept and prove twice. A ref flips synchronously and closes
   * that window for the buttons as well as for the driver.
   */
  const inFlight = useRef(false)

  const entries = session.entries
  const counts = useMemo(() => cardSettlementCounts(entries), [entries])
  const policy = useMemo(
    () => cardCheckpointPolicy(coordinator?.proofSeconds),
    [coordinator?.proofSeconds],
  )

  // The age trigger needs a clock, and a clock read inside a memo would freeze
  // at the last render. It ticks only while something is actually waiting.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (counts.submitted === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [counts.submitted])

  // The chain id every envelope for this room signs under, or the reason there
  // is none. Decided by a pure function so the sentence the panel shows is the
  // same one a headless test reads.
  const signing = useMemo<CardRoomSigning>(
    () =>
      room === null
        ? { chainId: null, reason: null }
        : cardRoomSigning(coordinator?.deploymentDomain ?? null, room.chainRoomId),
    [coordinator?.deploymentDomain, room],
  )

  const due = useMemo(() => cardCheckpointDue(counts, policy, { now }), [counts, policy, now])
  const hint = useMemo(
    () => cardCheckpointHint(counts, due, policy, room !== null),
    [counts, due, policy, room],
  )

  const attach = useCallback(async () => {
    // A lookup is read-only, so it is allowed to run alongside a submission or
    // a checkpoint - but then it must not claim `activity`, or finishing first
    // would report the console idle while a batch is still being proven.
    const owns = !inFlight.current
    if (owns) {
      inFlight.current = true
      setActivity('looking')
    }
    try {
      const [lookup, system] = await Promise.all([findCardRoom(), readCardCoordinator()])
      setRoom(lookup.room)
      setRooms(lookup.rooms)
      setReason(lookup.reason)
      setTemplate(lookup.template)
      setCoordinator(system)
      // The room's own deployment transaction is what proves the room exists on
      // L1 at all, so it is resolved on every attach rather than only after this
      // tab happened to be the one that deployed it.
      setDeployment(
        lookup.raw === null
          ? null
          : l1Receipt(
              {
                hash: lookup.raw.deploymentTransactionHash ?? null,
                transaction: lookup.raw.deploymentTransaction,
                explorerUrl: lookup.raw.deploymentExplorerUrl ?? null,
              },
              system.explorerUrl,
            ),
      )
      // The published address wins over anything typed or defaulted: the cold
      // template id commits to it, so it is the only address whose proofs this
      // room can settle. A coordinator publishing none leaves the field alone,
      // and the room panel says which of the two is in use.
      if (lookup.template?.duelAddress) setDuelAddress(lookup.template.duelAddress)
    } catch (caught) {
      setRoom(null)
      setReason(message(caught, 'The demo control plane is unreachable.'))
    } finally {
      if (owns) {
        inFlight.current = false
        setActivity('idle')
      }
    }
  }, [setDuelAddress])

  // One look on mount, so a stand that already has a room plays without a
  // click. It is deliberately not a poll: a lookup that failed says why and
  // stays said until someone asks again.
  useEffect(() => {
    void attach()
  }, [attach])

  const openRoom = useCallback(async () => {
    if (!template) {
      showNotice('There is no prepared card cold template to open a room from.')
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setActivity('opening')
    dismissNotice()
    setStage(null)
    try {
      const opened = await createCardRoom({
        template,
        name: `Hidden-card duel · ${new Date().toISOString().slice(11, 19)}`,
        // The presenter's own choice, in seconds, converted with this stand's
        // block time rather than an assumed twelve.
        deadlineBlocks: deadlineBlocksForSeconds(
          deadlineSeconds,
          coordinator?.l1BlockSeconds ?? 12,
        ),
        onPhase: setStage,
      })
      setRoom(opened)
      setReason(null)
      setBlockedBy(null)
      // Re-read so the room list, the phases of any older rooms and the new
      // room's deployment transaction are all the coordinator's own answer
      // rather than this tab's optimistic one.
      await attach()
    } catch (caught) {
      showNotice(message(caught, 'The coordinator refused to open a room.'))
    } finally {
      inFlight.current = false
      setActivity('idle')
      setStage(null)
    }
  }, [attach, coordinator?.l1BlockSeconds, deadlineSeconds, dismissNotice, showNotice, template])

  const submitMove = useCallback(
    async (sequence: number) => {
      const entry = entries.find((item) => item.sequence === sequence)
      if (!entry || entry.status === 'submitting' || entry.status === 'submitted') return
      if (!room) {
        showNotice('There is no active card room to submit to; the room panel says why.')
        return
      }
      if (signing.chainId === null) {
        // Latched, not retried: nothing about this changes by trying again, and
        // an unsigned move cannot be proved at all.
        const reported =
          signing.reason ?? 'This room has no chain id, so its moves cannot be signed.'
        setBlockedBy(reported)
        return
      }
      if (inFlight.current) return
      inFlight.current = true
      const block = room.nextBlock
      setActivity('submitting')
      dismissNotice()
      markMove(sequence, { status: 'submitting' })
      try {
        // Counted over the whole log, so the nonce keeps advancing across every
        // checkpoint instead of restarting at the batch boundary.
        const envelope = await signCardMoveEnvelope({
          seat: entry.seat,
          move: entry.move,
          duelAddress: duelContract,
          chainId: signing.chainId,
          nonce: cardSeatNonce(entries, entry.seat, sequence),
          calldata: entry.calldata.calldata,
        })
        // The vault holds this seat's secrets and is the only party that can
        // answer whether the finished envelope carries any of them.
        await auditBytes(entry.seat, envelope.signedTransaction)
        const accepted = await submitCardMove({
          roomId: room.roomId,
          actorId: `seat-${entry.seat}`,
          move: entry.move,
          calldata: entry.calldata.calldata,
          signedTransaction: envelope.signedTransaction,
          block,
        })
        markMove(sequence, {
          status: 'submitted',
          actionId: accepted.actionId,
          block: accepted.block,
        })
        // The coordinator files the first action into block 1 and every later
        // one into block 2, in order. Tracked here rather than re-read so a
        // move does not cost a round trip it does not need.
        setRoom((current) =>
          current === null
            ? current
            : { ...current, actionCount: current.actionCount + 1, nextBlock: 2 },
        )
      } catch (caught) {
        const reported = message(caught, 'The room refused the move.')
        markMove(sequence, { status: 'failed', error: reported })
        setBlockedBy(reported)
      } finally {
        inFlight.current = false
        setActivity('idle')
      }
    },
    [auditBytes, dismissNotice, duelContract, entries, markMove, room, showNotice, signing.chainId, signing.reason],
  )

  const runCheckpoint = useCallback(
    async (sequences: readonly number[]) => {
      if (!room) return
      if (sequences.length === 0) {
        showNotice('No submitted move is waiting to be proven.')
        return
      }
      if (inFlight.current) return
      inFlight.current = true
      setActivity('checkpointing')
      dismissNotice()
      setStage(null)
      try {
        const landed = await checkpointCardRoom(room.roomId, setStage)
        const published = cardRoomCheckpoints(landed.room)
        const latest = published[published.length - 1]
        if (!latest) {
          showNotice(
            'The checkpoint job finished but the coordinator published no receipt for it, so nothing here is marked as settled.',
          )
          return
        }
        // A batch proves the actions the ROOM holds, so a move whose accepted
        // action the coordinator no longer lists is left submitted rather than
        // credited to this receipt.
        const { proven, dropped } = cardProvenSequences(
          sequences,
          entries,
          landed.room.actions.map((action) => action.id),
        )
        const index = checkpoints.length + 1
        setCheckpoints((current) => [
          ...current,
          cardCheckpointRecord({
            index,
            roomId: room.roomId,
            checkpoint: latest,
            sequences: proven,
            explorerBase: coordinator?.explorerUrl ?? null,
          }),
        ])
        if (proven.length > 0) markCheckpoint(proven, index)
        if (dropped.length > 0) {
          showNotice(
            `Checkpoint ${index} landed on L1, but the room no longer lists the action it accepted for move${
              dropped.length === 1 ? '' : 's'
            } ${dropped.join(', ')}. Those moves are NOT marked as proven.`,
          )
        }
      } catch (caught) {
        setBlockedBy(message(caught, 'The room could not prove and submit this batch.'))
      } finally {
        inFlight.current = false
        setActivity('idle')
        setStage(null)
        // The room's phase changes when a batch lands, so the panel must be
        // re-read rather than assumed still ACTIVE.
        await attach()
      }
    },
    [attach, checkpoints.length, coordinator?.explorerUrl, dismissNotice, entries, markCheckpoint, room, showNotice],
  )

  /**
   * The presenter's button. It goes through the SAME policy the driver uses,
   * with the move-count trigger waived and nothing else - so a batch that the
   * coordinator would refuse for its shape is explained here, in a sentence,
   * rather than sent and bounced.
   */
  const checkpointNow = useCallback(async () => {
    const decision = cardSettlementAction({
      entries,
      hasRoom: room !== null,
      policy,
      now: Date.now(),
      requested: true,
      autoSubmit: false,
    })
    if (decision.kind !== 'checkpoint') {
      showNotice(decision.kind === 'idle' ? decision.reason : 'There is nothing to checkpoint.')
      return
    }
    await runCheckpoint(decision.sequences)
  }, [entries, policy, room, runCheckpoint, showNotice])

  /* ------------------------------- the driver ------------------------------ */

  useEffect(() => {
    if (!auto || blockedBy !== null) return
    // Never while the vault is proving: `run` folds its move into the session it
    // captured, and settlement writing at the same time is only safe because
    // this gate keeps the two apart.
    if (busy !== null || activity !== 'idle') return
    const action = cardSettlementAction({
      entries,
      hasRoom: room !== null,
      policy,
      now,
      autoSubmit: true,
    })
    if (action.kind === 'submit') void submitMove(action.sequence)
    else if (action.kind === 'checkpoint') void runCheckpoint(action.sequences)
  }, [
    auto,
    blockedBy,
    busy,
    activity,
    entries,
    room,
    policy,
    now,
    submitMove,
    runCheckpoint,
  ])

  const hold = useMemo<string | null>(() => {
    if (activity === 'checkpointing') {
      return `Waiting for the room to prove ${counts.submitted} submitted move${
        counts.submitted === 1 ? '' : 's'
      } and land the batch on L1 - about ${policy.proofSeconds.toFixed(0)} s of GPU proving${
        stage ? ` (coordinator: ${stage})` : ''
      }.`
    }
    if (activity === 'opening') return 'Opening and deploying a room on L1.'
    if (activity === 'submitting') return 'Handing the last move to the room.'
    if (auto && blockedBy === null && room !== null && due.due && due.blocked === null) {
      return 'A checkpoint is due; autoplay pauses so the batch is not overfilled.'
    }
    return null
  }, [activity, auto, blockedBy, counts.submitted, due, policy.proofSeconds, room, stage])

  const clearBlock = useCallback(() => setBlockedBy(null), [])

  return {
    room,
    reason,
    rooms,
    deployment,
    deadlineSeconds,
    setDeadlineSeconds,
    deadlineBlocks: Math.max(
      CARD_ROOM_MINIMUM_DEADLINE_BLOCKS,
      deadlineBlocksForSeconds(deadlineSeconds, coordinator?.l1BlockSeconds ?? 12),
    ),
    template,
    coordinator,
    policy,
    counts,
    due,
    hint,
    checkpoints,
    chainId: signing.chainId,
    signingReason: signing.reason,
    activity,
    stage,
    blockedBy,
    notice,
    auto,
    setAuto,
    hold,
    attach,
    openRoom,
    submitMove,
    checkpointNow,
    clearBlock,
  }
}
