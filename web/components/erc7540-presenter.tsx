'use client'

import { useEffect, useMemo } from 'react'
import { ArrowRight, CircleCheck, CircleDashed, KeyRound, ShieldCheck, UserRound } from 'lucide-react'
import { PresenterBar } from '@/components/autoplay/presenter-bar'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { ActionLog } from '@/components/applications/action-log'
import { useDemoAutoplay } from '@/components/applications/use-application-autoplay'
import { ERC7540_SCRIPT, demoMayLoop } from '@/lib/applications/application-run'
import styles from './erc7540-presenter.module.css'

type Lifecycle = 'Waiting' | 'Pending' | 'Claimable' | 'Claimed'

const ACTORS = [
  { id: 'alice', label: 'Alice', signer: 0, deposit: [0, 2, 4], redeem: [6, 8, 10] },
  { id: 'bob', label: 'Bob', signer: 1, deposit: [1, 3, 5], redeem: [7, 9, 11] },
] as const

function short(address: string | undefined): string {
  if (!address) return 'available after preparation'
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address
}

function lifecycle(accepted: number, indexes: readonly number[]): Lifecycle {
  if (accepted > indexes[2]!) return 'Claimed'
  if (accepted > indexes[1]!) return 'Claimable'
  if (accepted > indexes[0]!) return 'Pending'
  return 'Waiting'
}

function LifecycleTrack({ value }: { value: Lifecycle }) {
  const states: Lifecycle[] = ['Pending', 'Claimable', 'Claimed']
  const current = states.indexOf(value)
  return (
    <div className="mt-1 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1">
      {states.map((state, index) => (
        <div key={state} className="contents">
          <span
            className={`rounded-md border px-2 py-0.5 text-center font-mono text-[0.62rem] ${
              current >= index
                ? index === 2
                  ? 'border-success/50 bg-success/10 text-success'
                  : 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border bg-background/40 text-muted-foreground'
            }`}
          >
            {state}
          </span>
          {index < states.length - 1 ? (
            <ArrowRight className="size-3 text-muted-foreground" />
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function Erc7540Presenter({
  onActiveChange,
  focused = false,
}: {
  onActiveChange?: (active: boolean) => void
  focused?: boolean
}) {
  const autoplay = useDemoAutoplay(ERC7540_SCRIPT)
  const { state, preset, template, room, actionsTaken, log } = autoplay
  const waitingToLoop =
    state.status === 'ended'
    && state.loop
    && demoMayLoop(state.end)
  const standActive = autoplay.running || autoplay.closing || waitingToLoop

  useEffect(() => onActiveChange?.(standActive), [onActiveChange, standActive])

  const binding = template?.preparation?.erc7540Room
  const addresses: Record<string, string | undefined> = {
    alice: binding?.aliceAddress,
    bob: binding?.bobAddress,
    manager: binding?.managerAddress,
  }
  const activeAction =
    state.acting?.kind === 'action' ? preset?.actions[actionsTaken] ?? null : null
  const settled = Boolean(room?.checkpoint)
  const finalCheckpoint = useMemo(
    () => [...log].reverse().find((entry) => entry.kind === 'checkpoint' && entry.receipt) ?? null,
    [log],
  )

  return (
    <section
      className={`${styles.dayTheme} ${focused ? 'm-2' : 'mx-4 mb-5'} overflow-hidden rounded-2xl border border-primary/25 bg-card`}
      data-testid={focused ? 'erc7540-presentation' : undefined}
      data-lifecycle={
        focused
          ? finalCheckpoint
            ? 'settled-on-l1'
            : state.focus === 'checkpoint' || state.hold
              ? 'proving-held'
              : room?.phase === 'ACTIVE'
                ? 'active-provisional'
                : room
                  ? 'preparing-deploying'
                  : 'idle-ready'
          : undefined
      }
    >
      <div className={`grid gap-2 ${focused ? 'p-2' : 'p-5'} xl:grid-cols-[1.1fr_.9fr]`}>
        <div>
          <div className="flex flex-wrap items-center gap-2 text-primary">
            <ShieldCheck className="size-5" />
            <span className="font-mono text-xs tracking-[0.18em] uppercase">
              ERC-7540 self-playing proof room
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[0.62rem] ${
                settled
                  ? 'border-success/50 bg-success/10 text-success'
                  : 'border-warning/40 bg-warning/10 text-warning'
              }`}
            >
              {settled ? 'proof-backed' : 'provisional until checkpoint'}
            </span>
          </div>
          <h2 className={`mt-1 font-semibold ${focused ? 'text-lg' : 'text-2xl'}`}>A complete async vault round trip, live</h2>
          {!focused ? (
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Alice and Bob keep separate controller state while a vault manager only moves requests
              from Pending to Claimable. Users make the distinct claim calls themselves-exactly the
              separation ERC-7540 requires.
            </p>
          ) : null}
          <div className={`${focused ? 'mt-1' : 'mt-4'} flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/45 px-3 py-1`}>
            <strong className="text-primary">12 signed peer transactions</strong>
            <ArrowRight className="size-4 text-muted-foreground" />
            <strong>2 ordered room blocks</strong>
            <ArrowRight className="size-4 text-muted-foreground" />
            <strong className="text-success">1 proof checkpoint</strong>
          </div>
          {!focused ? <p className="mt-2 text-xs text-muted-foreground">
            The first run prepares and proves a reusable cold template. Later runs reuse it, open a
            fresh room, and leave each final L1 receipt on screen before looping.
          </p> : null}
        </div>

        <div className="rounded-xl border border-border bg-background/45 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[0.68rem] tracking-[0.16em] text-muted-foreground uppercase">
              current signer
            </span>
            <span className="font-mono text-[0.68rem] text-muted-foreground">
              completed run {autoplay.sessionRuns}/100 · 8 h cap
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
              <KeyRound className="size-5" />
            </span>
            <div>
              <strong className="block">
                {activeAction
                  ? preset?.peers?.find((peer) => peer.id === activeAction.actor)?.label
                    ?? activeAction.actor
                  : standActive
                    ? 'Coordinator lifecycle'
                    : 'Waiting for presenter'}
              </strong>
              <small className="font-mono text-muted-foreground">
                {activeAction
                  ? `${short(addresses[activeAction.actor])} · fixture signer #${activeAction.fixtureSignerIndex}`
                  : binding
                    ? `vault ${short(binding.vaultAddress)}`
                    : 'Press start to read the certified preset'}
              </small>
            </div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${Math.round((actionsTaken / 12) * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[0.65rem] text-muted-foreground">
            <span>{actionsTaken}/12 coordinator-accepted actions</span>
            <span>{room?.chainRoomId ? `room #${room.chainRoomId}` : 'fresh room each run'}</span>
          </div>
          {finalCheckpoint?.receipt ? (
            <div
              className="mt-2 rounded-lg border border-success/30 bg-success/5 p-2"
              data-testid={focused ? 'erc7540-presentation-receipt' : undefined}
            >
              <div className="mb-1 flex flex-wrap gap-3 font-mono text-[0.65rem] text-success">
                <span>L1 block {finalCheckpoint.l1Block}</span>
                <span>
                  {finalCheckpoint.proofMs
                    ? `${(finalCheckpoint.proofMs / 1_000).toFixed(1)} s proof`
                    : 'proof accepted'}
                </span>
              </div>
              <L1TransactionLink
                receipt={finalCheckpoint.receipt}
                label="settled in"
                full={focused}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className={`grid gap-2 border-y border-border bg-background/30 ${focused ? 'p-2' : 'p-5'} lg:grid-cols-3`}>
        {ACTORS.map((actor) => {
          const mine = preset?.actions
            .slice(0, actionsTaken)
            .filter((action) => action.actor === actor.id).length ?? 0
          return (
            <article
              key={actor.id}
              className={`rounded-xl border ${focused ? 'p-2' : 'p-4'} transition-colors ${
                activeAction?.actor === actor.id
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border bg-card/65'
              }`}
            >
              <div className="flex items-center gap-2">
                <UserRound className="size-4 text-primary" />
                <strong>{actor.label}</strong>
                <span className="ml-auto font-mono text-[0.62rem] text-muted-foreground">
                  signer #{actor.signer}
                </span>
              </div>
              <p className="mt-1 font-mono text-[0.64rem] text-muted-foreground">
                {short(addresses[actor.id])} · {mine}/4 accepted
              </p>
              <div className="mt-2">
                <div className="flex items-center justify-between text-[0.68rem]">
                  <span>Deposit request</span>
                  <strong>{lifecycle(actionsTaken, actor.deposit)}</strong>
                </div>
                <LifecycleTrack value={lifecycle(actionsTaken, actor.deposit)} />
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between text-[0.68rem]">
                  <span>Redeem request</span>
                  <strong>{lifecycle(actionsTaken, actor.redeem)}</strong>
                </div>
                <LifecycleTrack value={lifecycle(actionsTaken, actor.redeem)} />
              </div>
            </article>
          )
        })}

        <article
          className={`rounded-xl border ${focused ? 'p-2' : 'p-4'} transition-colors ${
            activeAction?.actor === 'manager'
              ? 'border-accent/60 bg-accent/10'
              : 'border-border bg-card/65'
          }`}
        >
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-accent" />
            <strong>Vault Manager</strong>
            <span className="ml-auto font-mono text-[0.62rem] text-muted-foreground">signer #2</span>
          </div>
          <p className="mt-1 font-mono text-[0.64rem] text-muted-foreground">
            {short(addresses.manager)} · role enforced by vault runtime
          </p>
          {[
            { label: 'Deposit fulfillment', indexes: [2, 3] },
            { label: 'Redeem fulfillment', indexes: [8, 9] },
          ].map((group) => {
            const count = group.indexes.filter((index) => actionsTaken > index).length
            return (
              <div className="mt-2" key={group.label}>
                <div className="flex items-center justify-between text-[0.68rem]">
                  <span>{group.label}</span>
                  <strong>{count}/2 Claimable</strong>
                </div>
                <div className="mt-2 flex gap-2">
                  {group.indexes.map((index) =>
                    actionsTaken > index ? (
                      <span key={index} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-accent/40 bg-accent/10 py-1 font-mono text-[0.62rem] text-accent">
                        <CircleCheck className="size-3" /> accepted
                      </span>
                    ) : (
                      <span key={index} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background/40 py-1 font-mono text-[0.62rem] text-muted-foreground">
                        <CircleDashed className="size-3" /> waiting
                      </span>
                    ),
                  )}
                </div>
              </div>
            )
          })}
        </article>
      </div>

      <div className={focused ? 'p-2' : 'p-5'}>
        <PresenterBar
          state={state}
          running={autoplay.running}
          compact={focused}
          canStart={autoplay.canStart}
          onStart={() => {
            autoplay.setLoop(true)
            autoplay.start()
          }}
          onStop={autoplay.stop}
          onRestart={() => {
            autoplay.setLoop(true)
            autoplay.restart()
          }}
          onDelayMs={autoplay.setDelayMs}
          onLoop={autoplay.setLoop}
          unit="step"
          eyebrow="Proof stand controls"
          startLabel="Start looped self-play"
          unavailable="The coordinator reports the stand degraded."
          chips={
            <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[0.66rem] text-primary">
              {state.acting?.label}
            </span>
          }
        />
        <details className={`${focused ? 'hidden' : 'mt-4 p-4'} rounded-xl border border-border bg-background/35`}>
          <summary className="cursor-pointer text-sm font-medium">
            Accepted actions and L1 receipts
          </summary>
          <ActionLog log={log} />
        </details>
      </div>
    </section>
  )
}
