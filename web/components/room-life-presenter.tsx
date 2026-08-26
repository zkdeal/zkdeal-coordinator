'use client'

import { Blocks, DoorOpen, Fingerprint, LogOut, UserRound } from 'lucide-react'
import type { Room, SystemStatus, Template } from '@/components/demo-console/api'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { formatSeconds, httpLink } from '@/lib/demo-console'
import { l1Receipt } from '@/lib/l1-receipt'
import styles from './room-life-presenter.module.css'

function lifecycle(room: Room | null, system: SystemStatus | null): string {
  if (room?.failure || room?.phase === 'FAILED') return 'Failed'
  if (room?.checkpoint || room?.phase === 'L1_FINALIZED') return 'Finalized on L1'
  if (room?.phase === 'L1_ACCEPTED') return 'Included on L1 · finality pending'
  if (
    room?.phase === 'PROVING'
    || room?.phase === 'LOCALLY_VERIFIED'
    || room?.phase === 'L1_PENDING'
  ) return 'Proving / held'
  if (room?.phase === 'ACTIVE') return 'Active · provisional'
  if (room) return 'Preparing / deploying'
  return system?.decision === 'READY' ? 'Idle · ready' : 'Reading services'
}

export function RoomLifePresenter({
  room,
  template,
  system,
}: {
  room: Room | null
  template: Template | null
  system: SystemStatus | null
}) {
  const currentLifecycle = lifecycle(room, system)
  const actions = room?.actions ?? []
  const actors = [...new Set(actions.map((action) => action.actorId))]
  const receipt = room?.checkpoint
    ? l1Receipt(
        {
          hash: room.checkpoint.l1TransactionHash ?? null,
          transaction: room.checkpoint.transaction,
          explorerUrl: room.checkpoint.explorerUrl,
        },
        httpLink(system?.explorerUrl),
      )
    : null
  const checkpointSequence =
    room?.checkpoints?.filter((checkpoint) => checkpoint.outcome === 'ACCEPTED').length ?? 0

  return (
    <section
      className={styles.presenter}
      data-testid="room-life-presentation-summary"
      data-lifecycle={currentLifecycle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}
    >
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.eyebrow}>Room anatomy · accounts, blocks and checkpoints</span>
          <h1>How a zkdeal room lives</h1>
          <p>A bounded group enters one prepared state, orders actions into room blocks, and exits through a proof-backed L1 checkpoint.</p>
        </div>
        <div className={styles.state}>
          <span className={styles.label}>Current live state</span>
          <strong>{currentLifecycle}</strong>
          <span>
            {room
              ? `${room.name} · ${room.chainRoomId ? `chain room #${room.chainRoomId}` : 'awaiting L1 room identity'}`
              : 'No room is open yet; the certified template and B200 prover are ready.'}
          </span>
        </div>
      </div>

      <div className={styles.steps} aria-label="Room lifecycle">
        {[
          ['1', 'Prepare', 'Cold proof fixes the starting state and allowed code.'],
          ['2', 'Enter', 'Accounts register against the room’s participant policy.'],
          ['3', 'Act', 'Signed actions are ordered into numbered room blocks.'],
          ['4', 'Checkpoint', 'One proof commits the batch and its post-state root.'],
          ['5', 'Exit / resume', 'Read the L1 receipt, leave, or continue from the checkpoint.'],
        ].map(([number, title, copy]) => (
          <div className={styles.step} key={number}>
            <span className={styles.stepNumber}>{number}</span>
            <strong>{title}</strong>
            <span>{copy}</span>
          </div>
        ))}
      </div>

      <div className={styles.body}>
        <article className={styles.panel}>
          <span className={styles.label}>Accounts and boundaries</span>
          <h2>Who gets in-and what “in” means</h2>
          <div className={styles.accountGrid}>
            {(actors.length > 0 ? actors : ['Account A', 'Account B']).slice(0, 3).map((actor, index) => (
              <div className={styles.account} key={actor}>
                <span className={styles.accountIcon}>
                  {index === 0 ? <UserRound size={15} /> : <Fingerprint size={15} />}
                </span>
                <div>
                  <strong>{actor}</strong>
                  <small>{actions.filter((action) => action.actorId === actor).length} accepted action(s) · identity stays bound to signatures</small>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.entryExit}>
            <div className={styles.fact}>
              <DoorOpen size={14} />
              <strong>Getting in</strong>
              <small>Registration joins an account to room #{room?.chainRoomId ?? '-'} under the prepared policy.</small>
            </div>
            <div className={styles.fact}>
              <LogOut size={14} />
              <strong>Getting out</strong>
              <small>Disconnect any time; treat balances as final only after the checkpoint receipt succeeds.</small>
            </div>
          </div>
          <div className={styles.facts} style={{ marginTop: 7 }}>
            <div className={styles.fact}>
              <strong>{template?.authorizationMode ?? 'Prepared authorization policy'}</strong>
              <small>{template?.participantCapacity ?? '-'} account capacity · {template?.activeApprovers ?? '-'} active approver(s)</small>
            </div>
          </div>
        </article>

        <article className={styles.panel}>
          <span className={styles.label}>Room-local ordering</span>
          <h2>How actions become blocks</h2>
          <div className={styles.blocks}>
            {[1, 2].map((blockNumber) => {
              const blockActions = actions.filter((action) => action.block === blockNumber)
              return (
                <div className={styles.block} key={blockNumber}>
                  <span className={styles.blockNumber}>{blockNumber}</span>
                  <strong>Room block {blockNumber}</strong>
                  <small>{blockActions.length} action(s), kept in coordinator acceptance order</small>
                  <div className={styles.actionList}>
                    {blockActions.length > 0
                      ? blockActions.map((action) => (
                          <span key={action.id}>{action.actorId} · {action.label}</span>
                        ))
                      : <span>waiting for an admitted action</span>}
                  </div>
                </div>
              )
            })}
          </div>
          <div className={styles.provisional}>
            <strong>Accepted is not settled.</strong> These actions are useful room-local state, but they remain provisional until the B200 proof verifies and the L1 transaction succeeds.
          </div>
        </article>

        <article className={styles.panel}>
          <span className={styles.label}>Checkpoint reader</span>
          <h2>How to read the receipt</h2>
          <div className={styles.checkpointGrid}>
            <div className={styles.checkpointRead}>
              <Blocks size={14} />
              <strong>Sequence {checkpointSequence || '-'}</strong>
              <small>{actions.filter((action) => action.checkpointSequence != null).length} action(s) bound to accepted checkpoints</small>
            </div>
            <div className={styles.checkpointRead}>
              <strong>{room?.checkpoint ? formatSeconds(room.checkpoint.proofMs) : 'Waiting'}</strong>
              <small>B200 outer proof · {room?.checkpoint ? `${formatSeconds(room.checkpoint.localVerificationMs)} local verify` : 'no proof yet'}</small>
            </div>
            <div className={styles.checkpointRead}>
              <strong>Post-state root</strong>
              <small className={styles.hash}>{room?.checkpoint?.postStateRoot ?? 'appears after proof verification'}</small>
            </div>
            <div className={styles.checkpointRead}>
              <strong>L1 inclusion</strong>
              <small>{room?.checkpoint ? `Block ${room.checkpoint.l1Block}; a successful transaction makes this checkpoint canonical.` : 'No canonical L1 block yet.'}</small>
            </div>
          </div>
          <div className={styles.receipt}>
            {receipt ? (
              <>
                <span>Canonical checkpoint · L1 block {room?.checkpoint?.l1Block}</span>
                <L1TransactionLink receipt={receipt} label="open complete checkpoint transaction" full />
              </>
            ) : room?.failure ? (
              <span>{room.failure.explanation} · {room.failure.recovery}</span>
            ) : (
              <span>The full 32-byte transaction hash and explorer link appear here only after successful L1 settlement.</span>
            )}
          </div>
        </article>
      </div>
    </section>
  )
}
