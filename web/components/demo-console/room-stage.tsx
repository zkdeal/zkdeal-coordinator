'use client'

/**
 * The studio's centre panel: which room is current, what it holds, and what of
 * it is actually on Ethereum.
 *
 * Split out of `components/long-running-demo.tsx` when it grew the two things
 * this file exists to make unambiguous:
 *
 *   1. WHICH ROOM. A settled room keeps its whole history and stops accepting
 *      actions. A presenter who has opened three over an afternoon needs the
 *      difference at a glance, not inferred from an empty action list - so the
 *      switcher names every room and says which of them still takes actions.
 *
 *   2. WHICH TRANSACTION. Every row that claims something reached L1 carries
 *      that transaction as a link whose href holds the whole 32-byte hash,
 *      pointed at the explorer the COORDINATOR advertises. A row that cannot
 *      resolve a full hash says so and renders no link at all - see
 *      `components/l1-transaction-link.tsx`.
 */
import {
  ArrowRight,
  Check,
  CircleAlert,
  Cpu,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Play,
  Radio,
  ShieldCheck,
} from 'lucide-react'
import type {
  DemoCheckpointView,
  Room,
  RoomAction,
  SystemStatus,
  Template,
} from '@/components/demo-console/api'
import { PhaseBadge } from '@/components/demo-console/chrome'
import { formatSeconds, phaseIndex, phaseLabel, roomProgress } from '@/lib/demo-console'
import { l1ReceiptLink, l1Receipt, type L1Receipt } from '@/lib/l1-receipt'
import styles from '../../app/demo/demo.module.css'
// The room switcher and the transaction rows are this panel's own; they live in
// their own module rather than growing the studio's already large stylesheet.
import stage from '../../app/demo/room-stage.module.css'

export function TransactionLink({ receipt, label }: { receipt: L1Receipt; label: string }) {
  const link = l1ReceiptLink(receipt)
  if (!link) return <span className={stage.txMissing}>{receipt.note}</span>
  return (
    <a
      className={stage.txLink}
      href={link.href}
      target="_blank"
      rel="noreferrer"
      title={link.title}
      data-transaction={link.title}
    >
      <ShieldCheck size={13} />
      {label} {link.text}
      <ExternalLink size={12} />
    </a>
  )
}

function checkpointReceipt(
  checkpoint: DemoCheckpointView,
  explorerUrl: string | null,
): L1Receipt {
  return l1Receipt(
    {
      hash: checkpoint.l1TransactionHash ?? null,
      transaction: checkpoint.transaction,
      explorerUrl: checkpoint.explorerUrl,
    },
    explorerUrl,
  )
}

export function RoomStage({
  rooms,
  selectedRoom,
  selectedRoomId,
  onSelectRoom,
  selectedTemplate,
  system,
  blockActions,
  busy,
  lastRefresh,
  onDeploy,
  onCheckpoint,
  mutationsDisabled = false,
}: {
  rooms: Room[]
  selectedRoom: Room | null
  selectedRoomId: string | null
  onSelectRoom: (id: string) => void
  selectedTemplate: Template | null
  system: SystemStatus | null
  blockActions: RoomAction[][]
  busy: string | null
  lastRefresh: Date | null
  onDeploy: (room: Room) => void
  onCheckpoint: (room: Room) => void
  mutationsDisabled?: boolean
}) {
  const explorerUrl = system?.explorerUrl ?? null
  // Attempts, unwrapped to the ones that actually produced a receipt. A running
  // or failed attempt has no transaction and must not be rendered as one.
  const accepted = (selectedRoom?.checkpoints ?? []).filter((attempt) => attempt.result)
  const settled = accepted.length
    ? accepted.map((attempt) => attempt.result!)
    : selectedRoom?.checkpoint
      ? [selectedRoom.checkpoint]
      : []
  /** Which accepted attempt proved each action, so a row can name its receipt. */
  const receiptOfAction = new Map<string, DemoCheckpointView>()
  for (const attempt of accepted) {
    for (const actionId of attempt.actionIds ?? []) receiptOfAction.set(actionId, attempt.result!)
  }
  const deployment = selectedRoom
    ? l1Receipt(
        {
          hash: selectedRoom.deploymentTransactionHash ?? null,
          transaction: selectedRoom.deploymentTransaction,
          explorerUrl: selectedRoom.deploymentExplorerUrl ?? null,
        },
        explorerUrl,
      )
    : null

  return (
    <section className={styles.stagePanel}>
      <div className={styles.stageHeader}>
        <div>
          <span className={styles.eyebrow}>Canonical room</span>
          <h2>{selectedRoom?.name ?? 'Select or create a room'}</h2>
        </div>
        {selectedRoom ? <PhaseBadge phase={selectedRoom.phase} /> : null}
      </div>

      {rooms.length > 1 ? (
        <div className={stage.roomSwitcher}>
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={`${stage.roomChip} ${room.id === selectedRoomId ? stage.roomChipCurrent : ''}`}
              onClick={() => onSelectRoom(room.id)}
            >
              <strong>{room.name}</strong>
              <small>
                {room.id === selectedRoomId ? 'current · ' : ''}
                {room.phase === 'ACTIVE'
                  ? 'accepting actions'
                  : `${phaseLabel(room.phase)} · closed to actions`}
              </small>
            </button>
          ))}
        </div>
      ) : null}

      {selectedRoom ? (
        <>
          <div className={styles.roomStats}>
            <div><span>Room</span><strong>{selectedRoom.chainRoomId ? `#${selectedRoom.chainRoomId}` : 'Not deployed'}</strong></div>
            <div><span>Authorization</span><strong>{selectedTemplate?.authorizationMode === 'VALIDITY_ONLY' ? 'Validity proof' : 'Unanimous consent'}</strong></div>
            <div><span>Deadline</span><strong>start + {selectedRoom.deadlineBlocksFromStart} blocks</strong></div>
            <div><span>Checkpoint</span><strong>{selectedRoom.checkpoint ? `L1 #${selectedRoom.checkpoint.l1Block}` : 'Pending'}</strong></div>
          </div>

          <div className={stage.txRow}>
            {deployment ? <TransactionLink receipt={deployment} label="room deployed in" /> : null}
            {settled.map((entry, index) => (
              <TransactionLink
                key={`${entry.l1Block}-${index}`}
                receipt={checkpointReceipt(entry, explorerUrl)}
                label={`checkpoint ${index + 1} settled in`}
              />
            ))}
          </div>

          <div className={styles.blockTimeline}>
            {[1, 2].map((blockNumber, index) => (
              <div className={styles.roomBlock} key={blockNumber}>
                <div className={styles.blockHeader}>
                  <span>L2 block {blockNumber}</span>
                  <small>{blockActions[index]!.length} accepted tx</small>
                </div>
                <div className={styles.blockActions}>
                  {blockActions[index]!.length ? (
                    blockActions[index]!.map((action) => {
                      // An action reaches L1 only inside the batch that proved
                      // it, so the row carries that batch's transaction - and
                      // nothing at all while it is still only accepted.
                      const settledIn = receiptOfAction.get(action.id)
                      return (
                        <div className={styles.blockAction} key={action.id}>
                          <span className={styles.actorAvatar}>
                            {action.actorId.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <strong>{action.label}</strong>
                            <small>
                              {action.actorId} · {new Date(action.acceptedAt).toLocaleTimeString()}
                            </small>
                            {settledIn ? (
                              <TransactionLink
                                receipt={checkpointReceipt(settledIn, explorerUrl)}
                                label="on L1 in"
                              />
                            ) : (
                              <small>accepted · not on L1 yet</small>
                            )}
                          </div>
                          <Check size={15} />
                        </div>
                      )
                    })
                  ) : (
                    <div className={styles.emptyBlock}>Waiting for a signed room action</div>
                  )}
                </div>
              </div>
            ))}
            <div className={styles.timelineArrow}><ArrowRight size={18} /></div>
            <div className={`${styles.proofBlock} ${phaseIndex(selectedRoom.phase) >= phaseIndex('PROVING') ? styles.proofActive : ''}`}>
              <Cpu size={22} />
              <div><span>Groth16 receipt</span><strong>{formatSeconds(selectedRoom.checkpoint?.proofMs)}</strong></div>
            </div>
            <div className={styles.timelineArrow}><ArrowRight size={18} /></div>
            <div className={`${styles.l1Block} ${selectedRoom.phase === 'L1_FINALIZED' ? styles.l1Accepted : ''}`}>
              <ShieldCheck size={22} />
              <div><span>Ethereum checkpoint</span><strong>{selectedRoom.checkpoint ? `Block ${selectedRoom.checkpoint.l1Block}` : phaseLabel(selectedRoom.phase)}</strong></div>
            </div>
          </div>

          <div className={styles.progressTrack}>
            <span style={{ width: `${roomProgress(selectedRoom.phase)}%` }} />
          </div>
          {selectedRoom.failure ? (
            <div className={styles.failurePanel}>
              <CircleAlert size={18} />
              <div><strong>{selectedRoom.failure.explanation}</strong><span>{selectedRoom.failure.recovery}</span></div>
            </div>
          ) : null}
          <div className={styles.stageFooter}>
            <span>
              <Radio size={15} />{' '}
              {lastRefresh
                ? `Live · refreshed ${lastRefresh.toLocaleTimeString()}`
                : 'Connecting to room stream'}
            </span>
            {selectedRoom.phase === 'ROOM_READY' ? (
              <button className={styles.primaryButton} disabled={mutationsDisabled || busy === `deploy:${selectedRoom.id}`} onClick={() => onDeploy(selectedRoom)}>
                {busy === `deploy:${selectedRoom.id}` ? <LoaderCircle className={styles.spin} size={17} /> : <Play size={17} />}Deploy room
              </button>
            ) : null}
            {selectedRoom.phase === 'ACTIVE' ? (
              <button className={styles.primaryButton} disabled={mutationsDisabled || busy === `checkpoint:${selectedRoom.id}`} onClick={() => onCheckpoint(selectedRoom)}>
                {busy === `checkpoint:${selectedRoom.id}` ? <LoaderCircle className={styles.spin} size={17} /> : <ShieldCheck size={17} />}Prove and checkpoint
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className={styles.stageEmpty}>
          <Layers3 size={42} />
          <h3>No room selected</h3>
          <p>Prepare a cold template, create a room, then deploy it when you are ready to present.</p>
        </div>
      )}
    </section>
  )
}
