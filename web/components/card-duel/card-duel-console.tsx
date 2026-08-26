'use client'

/**
 * `/card-duel` - the hidden-card duel.
 *
 * This is the only view in the project where confidentiality is the product,
 * so the page is arranged to make the boundary checkable rather than asserted:
 * each seat shows its public `Seat` next to the hand only this tab holds, every
 * move renders the complete transaction body it publishes, and the vault worker
 * that owns the deck audits those bytes before they are released.
 *
 * Nothing here fabricates a proof. If the coordinator cannot serve the circom
 * artifacts, the gate at the top says which file is missing and the duel stays
 * unplayable.
 */
import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { EyeOff, KeyRound, RotateCcw, Spade } from 'lucide-react'
import { CARD_RULES, type CardSeatIndex } from '@zkdeal/card'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { Badge, StatTile } from '@/components/ui/primitives'
import { cardProvingMs, cardPublishedBytes, cardTurnSummary } from '@/lib/card/session'
import { cardProvenMoveCount } from '@/lib/card/steps'
import { cardPresentation } from '@/lib/presentation'
import { AutoplayBar } from './autoplay-bar'
import { CheckpointPanel } from './checkpoint-panel'
import { MoveControls } from './move-controls'
import { MoveLog } from './move-log'
import { PayloadInspector } from './payload-inspector'
import { ProvingGate } from './proving-gate'
import { RoomPanel } from './room-panel'
import { SeatPanel } from './seat-panel'
import { useCardAutoplay } from './use-card-autoplay'
import { useCardDuel } from './use-card-duel'
import { useCardSettlement } from './use-card-settlement'

const SEATS: readonly CardSeatIndex[] = [0, 1]

export function CardDuelConsole() {
  const focused = cardPresentation(useSearchParams().get('present'))
  const duel = useCardDuel()
  // Settlement is passed to autoplay as back-pressure, not as a dependency of
  // the duel itself: with no room the console keeps working exactly as before,
  // building and auditing moves locally with `hold` permanently null.
  const settlement = useCardSettlement(duel)
  const autoplay = useCardAutoplay(duel, settlement.hold)
  const [exported, setExported] = useState<string | null>(null)
  const [password, setPassword] = useState('')

  const ready = duel.phase === 'ready'
  const focus = autoplay.state.focus
  const latestCheckpoint = settlement.checkpoints.at(-1) ?? null
  const lastEntry = duel.session.entries.at(-1) ?? null
  const seats = duel.session.duel.seats
  const outerGpu = settlement.coordinator?.gpuName ?? 'current CUDA GPU'

  return (
    <main
      className={`grid-bg min-h-screen px-4 ${focused ? 'py-3' : 'py-8'}`}
      data-presentation={focused ? 'cards' : undefined}
    >
      <div className={`mx-auto flex max-w-6xl flex-col ${focused ? 'gap-3' : 'gap-6'}`}>
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/"
            prefetch={false}
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <Image src="/zkdeal-icon.ico" alt="" width={26} height={26} />
            <span>zkdeal</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {/*
              `prefetch={false}`: this app is `output: 'export'`, and a static
              stand has no route to answer the RSC payload the default prefetch
              asks for - it 404s on hover, repeatedly, in a console a demo is
              meant to keep clean.
            */}
            <Link
              href="/applications"
              prefetch={false}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Auction + shop
            </Link>
            <span className="rounded-full border border-warning/30 bg-warning/10 px-3 py-1 font-mono text-xs text-warning">
              Demo-only proving keys
            </span>
          </div>
        </nav>

        <header>
          <div className="flex items-center gap-2 font-mono text-xs tracking-[0.24em] text-primary uppercase">
            <Spade className="size-4" />
            Validity-only room · hidden state
          </div>
          <h1 className={`${focused ? 'mt-1 text-2xl sm:text-3xl' : 'mt-3 text-4xl sm:text-5xl'} max-w-4xl font-semibold tracking-tight text-balance`}>
            Two players. One public board. Two decks nobody else can read.
          </h1>
          {!focused ? <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
            Each seat shuffles a {CARD_RULES.catalogSize}-card deck inside a worker in this tab
            and commits to it with a Poseidon root. Every draw, burn and play proves the hand
            transition with a Groth16 proof generated here, and publishes only roots, counters, the
            one card a play reveals, and 256 bytes of proof. The coordinator and the outer prover
            never see a deck order, a salt, a hand or a Merkle path - and the payload inspector
            below lets you check that rather than take it on trust.
          </p> : (
            <p className="mt-1 text-sm text-muted-foreground">
              Inner card proofs run in this browser; the {outerGpu} produces the outer room checkpoint.
            </p>
          )}
        </header>

        {!focused || !ready ? <ProvingGate
          gate={duel.gate}
          phase={duel.phase}
          progress={duel.progress}
          busy={duel.busy}
          onPrepare={() => void duel.prepare()}
        /> : (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
            <Badge tone="success">Browser prover ready</Badge>
            Artifacts verified; inner Groth16 proofs stay in this tab.
            <Badge tone="warning">Demo-only proving keys</Badge>
          </div>
        )}

        <AutoplayBar autoplay={autoplay} />

        {duel.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {duel.error}
          </div>
        ) : null}

        {!focused ? <section className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-card/60 p-4 sm:grid-cols-4">
          <StatTile label="Duel phase" value={duel.session.duel.phase} tone="primary" />
          <StatTile
            label="Proven moves"
            value={cardProvenMoveCount(duel.session)}
            hint="carried an inner Groth16 proof"
          />
          <StatTile
            label="In-browser proving"
            value={`${(cardProvingMs(duel.session) / 1000).toFixed(1)} s`}
            hint="measured, not estimated"
            tone="accent"
          />
          <StatTile
            label="Bytes published"
            value={cardPublishedBytes(duel.session)}
            hint="everything an L1 observer sees"
          />
        </section> : (
          <section
            className="rounded-2xl border border-primary/30 bg-card/80 p-3 shadow-2xl shadow-black/20"
            data-testid="cards-presentation-summary"
            data-lifecycle={
              duel.error
                ? 'failed'
                : latestCheckpoint
                  ? 'settled-on-l1'
                  : settlement.activity === 'checkpointing'
                    ? 'proving-held'
                    : cardProvenMoveCount(duel.session) > 0
                      ? 'active-provisional'
                      : 'idle-ready'
            }
          >
            <div className="grid grid-cols-4 gap-2 lg:grid-cols-8">
              <StatTile label="Phase" value={duel.session.duel.phase} tone="primary" />
              <StatTile label="Turn" value={`Seat ${duel.session.duel.turn}`} />
              <StatTile label="Seat 0" value={`${seats[0].health} HP · ${seats[0].handCount} hand`} />
              <StatTile label="Seat 1" value={`${seats[1].health} HP · ${seats[1].handCount} hand`} />
              <StatTile
                label="Last public move"
                value={lastEntry?.move ?? 'none'}
                hint={lastEntry?.status ?? 'nothing published'}
              />
              <StatTile
                label="Browser proof"
                value={duel.lastMove?.provingMs ? `${(duel.lastMove.provingMs / 1_000).toFixed(1)} s` : 'waiting'}
                hint="inner proof in this tab"
                tone="accent"
              />
              <StatTile
                label="Outer settlement"
                value={`${settlement.counts.checkpointed}/${settlement.counts.total}`}
                hint={`${settlement.counts.submitted} accepted, not yet on L1`}
                tone="success"
              />
              <StatTile
                label="Checkpoints"
                value={settlement.checkpoints.length}
                hint={
                  settlement.activity === 'checkpointing'
                    ? `${outerGpu} · ${settlement.stage ?? 'proving'}`
                    : `${outerGpu} outer proof`
                }
              />
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs">
              <Badge tone={latestCheckpoint ? 'success' : settlement.activity === 'checkpointing' ? 'warning' : 'muted'}>
                {latestCheckpoint ? `L1 block ${latestCheckpoint.l1Block}` : settlement.activity === 'checkpointing' ? 'Outer proof running' : 'No outer checkpoint yet'}
              </Badge>
              {latestCheckpoint ? (
                <>
                  <span className="font-mono">{(latestCheckpoint.proofMs / 1_000).toFixed(1)} s proof</span>
                  <L1TransactionLink receipt={latestCheckpoint.receipt} label="settled in" full />
                </>
              ) : (
                <span className="text-muted-foreground">
                  Room-accepted moves remain provisional until the {outerGpu} checkpoint is accepted on L1.
                </span>
              )}
            </div>
          </section>
        )}

        <p className="text-sm text-muted-foreground">{cardTurnSummary(duel.session)}</p>

        <RoomPanel
          settlement={settlement}
          duelAddress={duel.duelAddress}
          onDuelAddress={duel.setDuelAddress}
          identity={duel.identity}
        />

        <CheckpointPanel settlement={settlement} />

        <div className="grid gap-6 xl:grid-cols-2">
          {SEATS.map((seat) => (
            <SeatPanel
              key={seat}
              seat={seat}
              session={duel.session}
              view={duel.views[seat]}
              owner={duel.identity.seats[seat].owner}
              demoKeyNote={duel.identity.seats[seat].demoKeyNote}
              isTurn={duel.session.duel.phase === 'Active' && duel.session.duel.turn === seat}
              acting={autoplay.state.acting?.seat === seat}
              focus={focus?.seat === seat ? focus.region : null}
            />
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <MoveControls
            steps={duel.steps}
            session={duel.session}
            views={duel.views}
            busy={duel.busy}
            disabled={!ready}
            onRun={(step, choice) => void duel.run(step, choice)}
          />
          <PayloadInspector move={duel.lastMove} />
        </div>

        <MoveLog
          session={duel.session}
          checkpoints={settlement.checkpoints}
          canSubmit={settlement.room !== null}
          busy={duel.busy !== null || settlement.activity !== 'idle'}
          onSubmit={(sequence) => void settlement.submitMove(sequence)}
        />

        <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
          <div className="flex items-center gap-2 text-accent">
            <EyeOff className="size-5" />
            <span className="font-mono text-xs tracking-[0.18em] uppercase">Vault custody</span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            The deck, the salts and the hand exist only inside this tab&apos;s worker. Closing the
            tab destroys them, and no public data can rebuild a hand once its bundle has advanced.
            The one sanctioned way to keep a duel across a reload is an AES-256-GCM export under a
            password you choose; there is deliberately no server copy and no recovery.
          </p>
          {/*
            The password field lives in a real <form> with an autocomplete hint:
            a bare <input type="password"> outside one makes every browser log a
            console warning and offer to save a credential this page does not
            have. `onSubmit` is preventDefault-only - nothing is ever posted.
          */}
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => event.preventDefault()}
          >
            <label htmlFor="card-vault-export-password" className="sr-only">
              Vault export password
            </label>
            <input
              id="card-vault-export-password"
              name="card-vault-export-password"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder="Export password (12 characters or more)"
              onChange={(event) => setPassword(event.target.value)}
              className="h-8 w-72 rounded-md border border-input bg-background/60 px-2.5 text-sm outline-none focus-visible:border-ring"
            />
            {SEATS.map((seat) => (
              <button
                key={seat}
                type="submit"
                disabled={!ready || password.length < 12}
                onClick={() => {
                  void duel
                    .exportVault(seat, password)
                    .then(setExported)
                    .catch(() => setExported(null))
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <KeyRound className="size-3.5" /> Export seat {seat}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setExported(null)
                void duel.reset()
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
            >
              <RotateCcw className="size-3.5" /> Reset duel
            </button>
          </form>
          {exported ? (
            <>
              <Badge tone="success" className="mt-3">
                ciphertext only
              </Badge>
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-border bg-background/60 p-3 font-mono text-[0.62rem] break-all whitespace-pre-wrap">
                {exported}
              </pre>
            </>
          ) : null}
        </section>
      </div>
    </main>
  )
}
