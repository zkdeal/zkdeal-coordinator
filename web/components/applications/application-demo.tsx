'use client'

/**
 * One application room, driving itself.
 *
 * Both demos on `/applications` are this component with a different script: the
 * commit-reveal uniform-price auction and the persistent tokenized shop are two
 * certified presets on the same coordinator, and the demo makes that visible
 * rather than dressing each one up as a bespoke machine.
 *
 * NOTHING HERE IS A MODEL. Every number on screen comes from the coordinator:
 * the cold state is the preset's own declared storage, the room is a real room
 * with a real chain id, the actions are the preset's own actions accepted into
 * real L2 blocks, and the checkpoint is a real Groth16 proof accepted on L1
 * whose transaction hash is a link in the log below. When a step cannot run -
 * no preset, GPU busy, coordinator unreachable - the run says so in the
 * coordinator's own words and stops, instead of continuing on a script.
 */
import { LoaderCircle, Server, ShieldCheck } from 'lucide-react'
import { PresenterBar } from '@/components/autoplay/presenter-bar'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { ActionLog } from '@/components/applications/action-log'
import { DEMO_DEADLINE_SECONDS } from '@/components/applications/autoplay-policy'
import { useDemoAutoplay } from '@/components/applications/use-application-autoplay'
import { Badge, Select } from '@/components/ui/primitives'
import { deadlineBlocksForSeconds } from '@/lib/demo-system'
import {
  DEMO_STAGES,
  demoStageIndex,
  type DemoScript,
} from '@/lib/applications/application-run'

const STAGE_LABELS: Record<(typeof DEMO_STAGES)[number], string> = {
  system: 'Coordinator',
  prepare: 'Cold state proved',
  open: 'Room on L1',
  action: 'Room actions',
  checkpoint: 'Checkpoint',
}

function Step({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div
      className={`rounded-lg border px-2 py-2 text-center text-[0.68rem] font-medium ${
        active
          ? 'border-primary bg-primary/15 text-primary'
          : done
            ? 'border-success/40 bg-success/10 text-success'
            : 'border-border bg-card text-muted-foreground'
      }`}
    >
      {label}
    </div>
  )
}

export function ApplicationDemo({
  script,
  accent,
  eyebrow,
  icon,
  summary,
  focused = false,
  caveat,
}: {
  script: DemoScript
  accent: 'primary' | 'accent'
  eyebrow: string
  icon: React.ReactNode
  summary: string
  focused?: boolean
  caveat?: string
}) {
  const autoplay = useDemoAutoplay(script)
  const { state, system, preset, template, room, log } = autoplay
  const stageIndex = demoStageIndex(state.focus)
  const acting = state.acting
  const latestCheckpoint =
    [...log].reverse().find((entry) => entry.kind === 'checkpoint' && entry.receipt) ?? null
  const settledCheckpointCount = log.filter(
    (entry) => entry.kind === 'checkpoint' && entry.receipt,
  ).length
  const expectedCheckpointCount = script.checkpointAfterActions?.length ?? 1
  const fullySettled = settledCheckpointCount >= expectedCheckpointCount
  const refused = [...log].reverse().find((entry) => entry.status === 'refused') ?? null
  const acceptedActionIds = new Set(room?.actions.map((action) => action.actionId) ?? [])
  const presentationState =
    refused
      ? 'Failed'
      : latestCheckpoint && fullySettled
        ? 'Settled on L1'
        : state.focus === 'checkpoint' || state.hold
          ? 'Proving / held'
            : room?.phase === 'ACTIVE' || (latestCheckpoint && !fullySettled)
              ? 'Active · provisional'
            : room
              ? 'Preparing / deploying'
              : system
                ? 'Idle · ready'
                : 'Reading services'

  return (
    <section
      className={`rounded-2xl border border-border bg-card/80 ${focused ? 'p-4' : 'p-5'} shadow-2xl shadow-black/20`}
      data-testid={focused ? `${script.key}-presentation` : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Written out rather than interpolated: Tailwind only emits classes
              it can see literally in the source. */}
          <div
            className={`flex items-center gap-2 ${accent === 'accent' ? 'text-accent' : 'text-primary'}`}
          >
            {icon}
            <span className="font-mono text-xs uppercase tracking-[0.18em]">{eyebrow}</span>
          </div>
          <h2 className={`mt-2 font-semibold ${focused ? 'text-2xl' : 'text-xl'}`}>{script.title}</h2>
          <p className={`mt-1 max-w-2xl text-sm text-muted-foreground ${focused ? 'line-clamp-2' : ''}`}>
            {preset?.summary ?? summary}
          </p>
        </div>
        <span className="font-mono text-[0.68rem] text-muted-foreground">
          preset &ldquo;{script.presetId}&rdquo;
          {preset ? ` · ${preset.authorizationMode.toLowerCase().replace(/_/g, ' ')}` : ''}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-5 gap-1.5">
        {DEMO_STAGES.map((stage, index) => (
          <Step
            key={stage}
            label={STAGE_LABELS[stage]}
            active={stageIndex === index}
            done={stageIndex > index}
          />
        ))}
      </div>

      {script.key === 'amm' ? (
        <div
          className="mt-3 grid grid-cols-2 gap-1.5 lg:grid-cols-5"
          data-testid="amm-mev-protection-strip"
        >
          {[
            {
              label: 'Opaque commits',
              value:
                `${Number(acceptedActionIds.has('victim-commit')) + Number(acceptedActionIds.has('attacker-commit'))}/2 locked`,
              done:
                acceptedActionIds.has('victim-commit') && acceptedActionIds.has('attacker-commit'),
            },
            {
              label: 'Order seal',
              value: acceptedActionIds.has('seal-order') ? 'closed before reveal' : 'waiting',
              done: acceptedActionIds.has('seal-order'),
            },
            {
              label: 'Reactive leg',
              value: acceptedActionIds.has('reactive-front-run-blocked')
                ? latestCheckpoint
                  ? 'no price effect · proved'
                  : 'rejection queued'
                : 'not attempted',
              done: acceptedActionIds.has('reactive-front-run-blocked'),
            },
            {
              label: 'Reveal order',
              value: acceptedActionIds.has('out-of-order-reveal-blocked')
                ? latestCheckpoint
                  ? 'early reveal rejected'
                  : 'enforcement queued'
                : 'position 0 reserved',
              done: acceptedActionIds.has('out-of-order-reveal-blocked'),
            },
            {
              label: 'Committed swaps',
              value:
                latestCheckpoint && acceptedActionIds.has('blind-order-reveal')
                  ? '2 executed · L1 final'
                  : `${Number(acceptedActionIds.has('victim-reveal')) + Number(acceptedActionIds.has('blind-order-reveal'))}/2 revealed`,
              done: acceptedActionIds.has('blind-order-reveal'),
            },
          ].map((item) => (
            <div
              key={item.label}
              className={`rounded-lg border px-2 py-2 ${
                item.done
                  ? 'border-success/40 bg-success/10'
                  : 'border-border bg-background/45'
              }`}
            >
              <small className="block font-mono text-[0.58rem] uppercase tracking-wider text-muted-foreground">
                {item.label}
              </small>
              <strong className="mt-0.5 block text-[0.7rem] leading-tight">{item.value}</strong>
            </div>
          ))}
        </div>
      ) : null}

      {script.key === 'erc4626' ? (
        <div
          className="mt-3 grid grid-cols-3 gap-1.5"
          data-testid="erc4626-checkpoint-lifecycle"
        >
          {[
            {
              label: 'Checkpoint 1 · shares out',
              value:
                settledCheckpointCount >= 1
                  ? '100 assets → 100 shares · final'
                  : acceptedActionIds.has('issue-shares')
                    ? '100 shares queued'
                    : 'awaiting deposit',
              done: settledCheckpointCount >= 1,
            },
            {
              label: 'Checkpoint 2 · liquidity in',
              value:
                settledCheckpointCount >= 2
                  ? '+50 assets · 150 total · final'
                  : acceptedActionIds.has('add-liquidity')
                    ? '+50 assets queued'
                    : 'starts from checkpoint 1',
              done: settledCheckpointCount >= 2,
            },
            {
              label: 'Checkpoint 3 · shares liquid',
              value:
                settledCheckpointCount >= 3
                  ? '100 shares → 149 assets · final'
                  : acceptedActionIds.has('redeem-shares')
                    ? 'redemption queued'
                    : 'starts from checkpoint 2',
              done: settledCheckpointCount >= 3,
            },
          ].map((item) => (
            <div
              key={item.label}
              className={`rounded-lg border px-2 py-2 ${
                item.done
                  ? 'border-success/40 bg-success/10'
                  : 'border-border bg-background/45'
              }`}
            >
              <small className="block font-mono text-[0.58rem] uppercase tracking-wider text-muted-foreground">
                {item.label}
              </small>
              <strong className="mt-0.5 block text-[0.7rem] leading-tight">{item.value}</strong>
            </div>
          ))}
        </div>
      ) : null}

      {focused ? (
        <div
          className="mt-3 grid gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.9fr)]"
          data-testid="presentation-critical-state"
          data-lifecycle={presentationState.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={fullySettled ? 'success' : refused ? 'danger' : 'primary'}>
                {presentationState}
              </Badge>
              {acting ? <strong className="text-sm">{acting.label}</strong> : null}
              {autoplay.phase ? (
                <span className="font-mono text-[0.68rem] text-accent">
                  coordinator {autoplay.phase}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {room
                ? `${room.name} · ${room.chainRoomId ? `chain room #${room.chainRoomId}` : 'awaiting L1 deployment'} · ${room.actions.length} accepted action${room.actions.length === 1 ? '' : 's'}`
                : 'The coordinator and GPU readiness are checked before a room is opened.'}
            </p>
            {caveat ? (
              <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[0.68rem] leading-snug text-warning">
                {caveat}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 rounded-lg border border-border bg-background/55 p-2">
            {latestCheckpoint?.receipt ? (
              <>
                <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem]">
                   <span>
                     checkpoint {settledCheckpointCount}/{expectedCheckpointCount} · L1 block{' '}
                     {latestCheckpoint.l1Block}
                   </span>
                  <span>{latestCheckpoint.proofMs ? `${(latestCheckpoint.proofMs / 1_000).toFixed(1)} s proof` : 'proof accepted'}</span>
                </div>
                <div className="mt-1">
                  <L1TransactionLink receipt={latestCheckpoint.receipt} label="settled in" full />
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {state.hold ?? 'The complete L1 transaction hash and proof duration appear here after settlement.'}
              </p>
            )}
          </div>
        </div>
      ) : caveat ? (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          {caveat}
        </p>
      ) : null}

      {/* --------------------------- the real room --------------------------- */}

      <div className="mt-4 rounded-xl border border-border bg-background/45 p-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Server className="size-4 text-muted-foreground" />
          {room ? (
            <>
              <Badge tone={room.phase === 'ACTIVE' ? 'success' : 'accent'}>{room.phase}</Badge>
              <span className="font-medium">{room.name}</span>
              <span className="font-mono text-[0.68rem] text-muted-foreground">
                {room.chainRoomId ? `chain room #${room.chainRoomId}` : 'not yet deployed'} ·{' '}
                {room.actions.length} action{room.actions.length === 1 ? '' : 's'} held · deadline{' '}
                {room.deadlineBlocksFromStart} L1 blocks
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              No room has been opened yet. Auto-play prepares the cold state, opens one and deploys
              it on L1.
            </span>
          )}
        </div>
        {template ? (
          <p className="mt-1.5 font-mono text-[0.65rem] text-muted-foreground">
            cold template &ldquo;{template.name}&rdquo; · {template.phase}
          </p>
        ) : null}
      </div>

      {/* ------------------------ the declared cold state --------------------- */}

      {!focused && preset && preset.initialStorage.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[1.4fr_0.6fr_0.9fr] bg-secondary/60 px-3 py-1.5 font-mono text-[0.62rem] uppercase tracking-wider text-muted-foreground">
            <span>Cold state fixed by the proof</span>
            <span>Initial</span>
            <span>Room policy</span>
          </div>
          {preset.initialStorage.map((slot) => (
            <div
              key={`${slot.slot}-${slot.label}`}
              className="grid grid-cols-[1.4fr_0.6fr_0.9fr] border-t border-border px-3 py-1.5 text-xs"
            >
              <span>{slot.label}</span>
              <span className="font-mono">{slot.value}</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">
                {slot.mode.toLowerCase().replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {!focused ? <p className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
        These are the values the cold proof fixes before the room opens. What the room does to them
        is settled by the checkpoint below - the coordinator does not publish live room storage, so
        nothing here is restated as though it were read back out.
      </p> : null}

      {!focused ? <ActionLog log={log} /> : null}

      <div className="mt-4">
        <PresenterBar
          state={state}
          running={autoplay.running}
          canStart={autoplay.canStart}
          onStart={autoplay.start}
          onStop={autoplay.stop}
          onRestart={autoplay.restart}
          onDelayMs={autoplay.setDelayMs}
          onLoop={autoplay.setLoop}
          unit="step"
          eyebrow="Presenter mode · real room"
          startLabel={`Run the ${script.noun} for real`}
          idleNarration="Starting…"
          unavailable="This coordinator reports itself degraded; a room opened now may not settle."
          chips={
            acting ? (
              <>
                <Badge tone="primary">{acting.label}</Badge>
                {autoplay.phase ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[0.7rem] text-accent">
                    <LoaderCircle className="size-3 animate-spin" />
                    coordinator {autoplay.phase}
                  </span>
                ) : null}
              </>
            ) : null
          }
          settings={
            <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              proving deadline
              <Select
                className="h-8 w-24"
                value={autoplay.deadlineSeconds}
                disabled={autoplay.running}
                onChange={(event) => autoplay.setDeadlineSeconds(Number(event.target.value))}
              >
                {DEMO_DEADLINE_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} s
                  </option>
                ))}
              </Select>
              <span className="font-mono text-[0.65rem]">
                ={' '}
                {deadlineBlocksForSeconds(
                  autoplay.deadlineSeconds,
                  system?.l1BlockSeconds ?? 12,
                )}{' '}
                L1 blocks
              </span>
            </label>
          }
        />
      </div>

      {focused ? (
        <details className="mt-2 rounded-lg border border-border bg-background/35 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium">
            Cold-state declaration and full event history
          </summary>
          {preset && preset.initialStorage.length > 0 ? (
            <div className="mt-2 grid gap-1 text-[0.68rem] text-muted-foreground sm:grid-cols-3">
              {preset.initialStorage.map((slot) => (
                <span key={`${slot.slot}-${slot.label}`}>
                  {slot.label}: <strong className="text-foreground">{slot.value}</strong>
                </span>
              ))}
            </div>
          ) : null}
          <ActionLog log={log} />
        </details>
      ) : null}
    </section>
  )
}
