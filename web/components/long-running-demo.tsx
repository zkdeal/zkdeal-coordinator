'use client'

/**
 * /demo - the long-running local demo console.
 *
 * The service wire types and fetch wrapper live in
 * `components/demo-console/api.ts`, the status dot / phase badge / topology
 * strip in `components/demo-console/chrome.tsx`, and the cold-state
 * preparation wizard in `components/demo-console/template-wizard.tsx`.
 */

import {
  Activity,
  Blocks,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Fullscreen,
  Gauge,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Spade,
  Sparkles,
  WalletCards,
} from 'lucide-react'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  formatSeconds,
  httpLink,
  idempotencyKey,
  phaseLabel,
} from '@/lib/demo-console'
import {
  API,
  api,
  type L1Block,
  type Preset,
  type PresetAction,
  type Room,
  type RoomAction,
  type SystemStatus,
  type Template,
} from '@/components/demo-console/api'
import { PhaseBadge, StatusDot, Topology } from '@/components/demo-console/chrome'
import { TemplateWizard } from '@/components/demo-console/template-wizard'
import { RoomStage } from '@/components/demo-console/room-stage'
import { Erc7540Presenter } from '@/components/erc7540-presenter'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { RoomLifePresenter } from '@/components/room-life-presenter'
import presenterStyles from '@/components/erc7540-presenter.module.css'
import { ApplicationDemo } from '@/components/applications/application-demo'
import { deadlineSecondsForBlocks, DEMO_L1_BLOCK_SECONDS_FALLBACK } from '@/lib/demo-system'
import { l1Receipt } from '@/lib/l1-receipt'
import { demoPresentation } from '@/lib/presentation'
import { useTransientAlert } from '@/lib/transient-alert'
import {
  AMM_SCRIPT,
  DVP_SCRIPT,
  ERC4626_SCRIPT,
} from '@/lib/applications/application-run'
import styles from '../app/demo/demo.module.css'

/** Mirrors /demo/v1/room-settings; the coordinator validates and is authoritative. */
const DEADLINE_BLOCKS_MIN = 5
const DEADLINE_BLOCKS_MAX = 50
/** 120 s of proving headroom at 12 s L1 blocks. */
const DEADLINE_BLOCKS_DEFAULT = 10

export function LongRunningDemo() {
  const presentation = demoPresentation(useSearchParams().get('present'))
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [blocks, setBlocks] = useState<L1Block[]>([])
  /**
   * Null until the coordinator's own default is known, so the picker adopts
   * `checkpointPolicy.defaultDeadlineBlocks` rather than a number chosen here.
   * A hardcoded four blocks was BELOW the wall clock a checkpoint needs on this
   * stand, i.e. every room created with it raced its own deadline.
   */
  const [roomDeadlineBlocks, setRoomDeadlineBlocks] = useState<number | null>(null)
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const {
    message: notice,
    show: showNotice,
    dismiss: dismissNotice,
  } = useTransientAlert()
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [autoplayLocked, setAutoplayLocked] = useState(false)
  const mounted = useRef(true)
  const refreshing = useRef(false)
  const refreshQueued = useRef(false)

  const runRefresh = useCallback(async () => {
    try {
      const [nextSystem, nextPresets, nextTemplates, nextRooms, nextBlocks] = await Promise.all([
        api<SystemStatus>('/demo/v1/system'),
        api<{ presets: Preset[] }>('/demo/v1/presets'),
        api<{ templates: Template[] }>('/demo/v1/templates'),
        api<{ rooms: Room[] }>('/demo/v1/rooms'),
        api<{ blocks: L1Block[] }>('/demo/v1/l1/blocks'),
      ])
      if (!mounted.current) return
      setSystem(nextSystem)
      setPresets(nextPresets.presets)
      setTemplates(nextTemplates.templates)
      setRooms(nextRooms.rooms)
      setBlocks(nextBlocks.blocks)
      // Adopted once, so a presenter who has chosen a deadline keeps it.
      setRoomDeadlineBlocks(
        (current) =>
          current ??
          nextSystem.checkpointPolicy?.defaultDeadlineBlocks ??
          nextSystem.gpu?.recommendedDeadlineBlocks ??
          4,
      )
      // Prefer a room that still ACCEPTS actions: after a checkpoint lands, the
      // newest room may be the settled one, and selecting it silently leaves
      // the action panel empty with no explanation.
      setSelectedRoomId(
        (current) =>
          current ??
          nextRooms.rooms.filter((room) => room.phase === 'ACTIVE').at(-1)?.id ??
          nextRooms.rooms.at(-1)?.id ??
          null,
      )
      setLastRefresh(new Date())
    } catch (caught) {
      if (mounted.current) {
        showNotice(caught instanceof Error ? caught.message : 'Demo services are not ready.')
      }
    }
  }, [showNotice])

  /**
   * Single scheduler for the poll and the SSE trigger.
   *
   * Both drove `runRefresh` directly, and each pass fans out five parallel
   * requests: a run emitting update events produced five requests per event on
   * top of the unconditional 4 s poll, against a service backed by one queued
   * CUDA worker. Overlapping calls now collapse into one trailing pass.
   */
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      refreshQueued.current = true
      return
    }
    refreshing.current = true
    try {
      do {
        refreshQueued.current = false
        await runRefresh()
      } while (refreshQueued.current && mounted.current)
    } finally {
      refreshing.current = false
    }
  }, [runRefresh])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const poll = window.setInterval(() => void refresh(), 4_000)
    const stream = new EventSource(`${API}/demo/v1/stream`)
    stream.addEventListener('update', () => void refresh())
    // EventSource reconnects on its own; say so rather than leaving the page
    // silently stale while only the 4 s poll is still running.
    stream.addEventListener('error', () => {
      if (mounted.current) {
        showNotice('The demo event stream dropped; updates continue on the slower poll.')
      }
    })
    return () => {
      mounted.current = false
      clearInterval(poll)
      stream.close()
    }
  }, [refresh, showNotice])

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null
  const selectedTemplate = selectedRoom
    ? templates.find((template) => template.id === selectedRoom.templateId) ?? null
    : null
  const selectedPreset = selectedTemplate?.presetId
    ? presets.find((preset) => preset.id === selectedTemplate.presetId) ?? null
    : null
  // Explorer destinations come from the demo service as untyped JSON; only
  // http(s) URLs become link hrefs.
  const systemExplorerUrl = httpLink(system?.explorerUrl)
  const canaryExplorerUrl = httpLink(system?.canary?.explorerUrl)
  const blockSeconds =
    system?.checkpointPolicy?.l1BlockSeconds ?? DEMO_L1_BLOCK_SECONDS_FALLBACK
  // The coordinator refuses a deadline below DEADLINE_BLOCKS_MIN: a whole
  // checkpoint (prepare, ~18 s proof, L1 inclusion) does not fit in less, and
  // it validates the range itself with the arithmetic in its 400. These bounds
  // mirror /demo/v1/room-settings so the control cannot offer a value the
  // server will reject; the server stays the authority.
  const deadlineBlocks = roomDeadlineBlocks ?? DEADLINE_BLOCKS_DEFAULT

  const createRoom = async (template: Template) => {
    if (autoplayLocked) return
    setBusy(`room:${template.id}`)
    try {
      const result = await api<Room>('/demo/v1/rooms', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('room') },
        body: JSON.stringify({
          name: `${template.name.replace(/ template$/i, '')} · ${rooms.length + 1}`,
          templateId: template.id,
          managed: false,
          deadlineBlocksFromStart: deadlineBlocks,
        }),
      })
      setSelectedRoomId(result.id)
      await refresh()
    } catch (caught) {
      showNotice(caught instanceof Error ? caught.message : 'Room creation failed.')
    } finally {
      setBusy(null)
    }
  }

  const deployRoom = async (room: Room) => {
    if (autoplayLocked) return
    setBusy(`deploy:${room.id}`)
    try {
      await api(`/demo/v1/rooms/${room.id}/deploy`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('deploy') },
        body: '{}',
      })
      await refresh()
    } catch (caught) {
      showNotice(caught instanceof Error ? caught.message : 'Room deployment failed.')
    } finally {
      setBusy(null)
    }
  }

  const triggerAction = async (room: Room, action: PresetAction) => {
    if (autoplayLocked) return
    setBusy(`action:${action.id}`)
    try {
      await api(`/demo/v1/rooms/${room.id}/actions`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('action') },
        body: JSON.stringify({
          actionId: action.id,
          actorId: action.actor,
          block: action.recommendedBlock,
        }),
      })
      await refresh()
    } catch (caught) {
      showNotice(caught instanceof Error ? caught.message : 'Room action was not admitted.')
    } finally {
      setBusy(null)
    }
  }

  const checkpoint = async (room: Room) => {
    if (autoplayLocked) return
    setBusy(`checkpoint:${room.id}`)
    try {
      await api(`/demo/v1/rooms/${room.id}/checkpoints`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('checkpoint') },
        body: '{}',
      })
      await refresh()
    } catch (caught) {
      showNotice(caught instanceof Error ? caught.message : 'Checkpoint did not start.')
    } finally {
      setBusy(null)
    }
  }

  const roomBlockActions = useMemo(() => {
    if (!selectedRoom) return [[], []] as RoomAction[][]
    return [
      selectedRoom.actions.filter((action) => action.block === 1),
      selectedRoom.actions.filter((action) => action.block === 2),
    ]
  }, [selectedRoom])
  const overviewPresentationState =
    selectedRoom?.failure || selectedRoom?.phase === 'FAILED'
      ? 'Failed'
      : selectedRoom?.checkpoint || selectedRoom?.phase === 'L1_FINALIZED'
        ? 'Finalized on L1'
        : selectedRoom?.phase === 'L1_ACCEPTED'
          ? 'Included on L1 · finality pending'
        : selectedRoom?.phase === 'PROVING'
            || selectedRoom?.phase === 'LOCALLY_VERIFIED'
            || selectedRoom?.phase === 'L1_PENDING'
            || busy === `checkpoint:${selectedRoom?.id ?? ''}`
          ? 'Proving / held'
          : selectedRoom?.phase === 'ACTIVE'
            ? 'Active · provisional'
            : selectedRoom
              ? 'Preparing / deploying'
              : system?.decision === 'READY'
                ? 'Idle · ready'
                : 'Reading services'
  const overviewLatestAction = selectedRoom?.actions.at(-1) ?? null
  const overviewCheckpointReceipt = selectedRoom?.checkpoint
    ? l1Receipt(
        {
          hash: selectedRoom.checkpoint.l1TransactionHash ?? null,
          transaction: selectedRoom.checkpoint.transaction,
          explorerUrl: selectedRoom.checkpoint.explorerUrl,
        },
        systemExplorerUrl,
      )
    : null

  return (
    <main
      className={`${styles.demoShell} ${presentation ? styles.presentShell : ''}`}
      data-presentation={presentation ?? undefined}
    >
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Image src="/zkdeal-icon.ico" alt="" width={30} height={30} priority />
          </span>
          <div><strong>zkdeal</strong><span>live room studio</span></div>
        </div>
        <div className={styles.systemRibbon}>
          {(system?.services ?? []).map((service) => (
            <span key={service.id}><StatusDot status={service.status} />{service.label}</span>
          ))}
          {!system ? <span><StatusDot status="STARTING" />Connecting</span> : null}
        </div>
        <div className={styles.topActions}>
          <a className={styles.ghostButton} href="/room-pool"><WalletCards size={16} />Web3 direct</a>
          {/* The card room's moves cannot be canned into preset actions, so the
              stand hands that scenario to the browser client that can build
              them. */}
          <a className={styles.ghostButton} href="/card-duel"><Spade size={16} />Hidden-card duel</a>
          <button className={styles.iconButton} onClick={() => void refresh()} aria-label="Refresh">
            <RefreshCw size={17} />
          </button>
          {/* A denied or unsupported request is a user choice, not an
              unhandled rejection. */}
          <button className={styles.iconButton} onClick={() => { void document.documentElement.requestFullscreen().catch(() => undefined) }} aria-label="Full screen">
            <Fullscreen size={17} />
          </button>
        </div>
      </header>

      {notice ? (
        <div className={styles.notice} role="status" data-testid="transient-alert">
          <CircleAlert size={16} />
          {notice}
          <button onClick={dismissNotice}>Dismiss</button>
        </div>
      ) : null}

      {presentation === null || presentation === 'overview' ? (
      <section className={styles.heroBand}>
        <div>
          <span className={styles.eyebrow}>Workflow-scoped execution · local Ethereum</span>
          <h1>Open a provable room. Watch it settle.</h1>
          <p>Build the cold state, run two real room blocks, prove the combined transition, and follow its acceptance into Ethereum.</p>
        </div>
        <Topology active={selectedRoom?.phase ?? (system?.canary ? 'L1_FINALIZED' : null)} />
        <div className={styles.gpuCard}>
          <span><Gauge size={16} /> Current proof allowance</span>
          <strong>{system?.gpu ? `${system.gpu.recommendedProofSeconds} s` : 'Measuring'}</strong>
          <small>{system?.gpu?.name ?? 'Single CUDA device'} · {system?.gpu?.recommendedDeadlineBlocks ?? '-'} L1 blocks recommended</small>
        </div>
      </section>
      ) : null}

      {presentation === 'overview' ? (
        <section
          className={styles.presentationSummary}
          data-testid="overview-presentation-summary"
          data-lifecycle={overviewPresentationState.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}
        >
          <div className={styles.presentationSummaryState}>
            <strong>{overviewPresentationState}</strong>
            <span>
              {selectedRoom
                ? `${selectedRoom.name} · ${selectedRoom.chainRoomId ? `chain room #${selectedRoom.chainRoomId}` : 'awaiting L1 deployment'}`
                : system?.decision === 'READY'
                  ? 'Services and the single GPU are ready. Start by preparing or opening a fresh room.'
                  : 'Waiting for coordinator, GPU, and local Ethereum readiness.'}
            </span>
          </div>
          <div className={styles.presentationSummaryValues}>
            <span>
              <small>Current action</small>
              <strong>
                {overviewLatestAction
                  ? `${overviewLatestAction.actorId} · ${overviewLatestAction.label}`
                  : busy
                    ? busy.replace(/^[^:]+:/, '').replace(/-/g, ' ')
                    : 'Start a fresh room'}
              </strong>
            </span>
            <span>
              <small>Room blocks</small>
              <strong>
                {selectedRoom
                  ? `${roomBlockActions[0].length} in block 1 · ${roomBlockActions[1].length} in block 2`
                  : 'No provisional actions'}
              </strong>
            </span>
            <span>
              <small>GPU / queue</small>
              <strong>
                {system?.gpu
                  ? `${system.gpu.name} · ${system.gpu.recommendedProofSeconds} s allowance`
                  : 'Reading GPU readiness'}
              </strong>
            </span>
          </div>
          <div className={styles.presentationSummaryReceipt}>
            {selectedRoom?.checkpoint ? (
              <>
                <span>
                  L1 block {selectedRoom.checkpoint.l1Block} ·{' '}
                  {formatSeconds(selectedRoom.checkpoint.proofMs)} proof
                </span>
                {overviewCheckpointReceipt ? (
                  <L1TransactionLink
                    receipt={overviewCheckpointReceipt}
                    label="settled in"
                    full
                  />
                ) : null}
              </>
            ) : selectedRoom?.failure ? (
              <>
                <strong>{selectedRoom.failure.explanation}</strong>
                <span>{selectedRoom.failure.recovery}</span>
              </>
            ) : (
              <span>
                Accepted room actions remain provisional until the complete L1 receipt appears here.
              </span>
            )}
          </div>
        </section>
      ) : null}

      {presentation === 'room-life' ? (
        <RoomLifePresenter
          room={selectedRoom}
          template={selectedTemplate}
          system={system}
        />
      ) : null}

      {presentation === null || presentation === 'erc7540' ? (
        <Erc7540Presenter
          focused={presentation === 'erc7540'}
          onActiveChange={setAutoplayLocked}
        />
      ) : null}

      {presentation === 'dvp' || presentation === 'erc4626' || presentation === 'amm' ? (
        <div className={`${presenterStyles.dayTheme} ${styles.focusedApplication}`}>
          <ApplicationDemo
            focused
            script={
              presentation === 'dvp'
                ? DVP_SCRIPT
                : presentation === 'erc4626'
                  ? ERC4626_SCRIPT
                  : AMM_SCRIPT
            }
            accent={presentation === 'amm' ? 'accent' : 'primary'}
            eyebrow={
              presentation === 'amm'
                ? 'Live MEV-protected AMM'
                : presentation === 'erc4626'
                  ? 'Live progressive ERC-4626 vault'
                  : 'Live generic-storage prototype'
            }
            icon={
              presentation === 'dvp'
                ? <Blocks className="size-5" />
                : presentation === 'erc4626'
                  ? <WalletCards className="size-5" />
                  : <Activity className="size-5" />
            }
            summary={
              presentation === 'amm'
                ? 'A real constant-product room seals opaque orders before reveal, proves rejected reactive ordering attempts, and settles the resulting reserves on L1.'
                : presentation === 'erc4626'
                  ? 'A real tokenized vault carries issued shares, new liquidity, and a final redemption across three consecutive proof-backed checkpoints.'
                : 'This certified preset runs through the live coordinator, the single GPU prover and a real L1 checkpoint.'
            }
            caveat={
              presentation === 'amm'
                ? 'Precise boundary: commit-reveal prevents reveal-reactive insertion and reordering. It does not prevent commitment censorship or metadata leakage; forced inclusion and encrypted admission are separate policies.'
                : presentation === 'erc4626'
                  ? 'Exact arithmetic: the vault uses one virtual asset and one virtual share. After 100 assets mint 100 shares and 50 assets arrive without dilution, redeeming all shares returns 149 assets and leaves one rounding unit in the vault.'
                : 'Prototype boundary: this live preset exercises the generic storage workload. It demonstrates the room lifecycle and proof-backed settlement, not a domain-complete production implementation of this application.'
            }
          />
        </div>
      ) : null}

      {(presentation === null || presentation === 'overview') && autoplayLocked ? (
        <div className={styles.persistentNotice}>
          <ShieldCheck size={16} />
          Self-play owns the stand’s single operator key and GPU. Manual mutations are paused;
          room history and receipts remain readable.
        </div>
      ) : null}

      {presentation === null || presentation === 'overview' ? (
      <section className={styles.workspace}>
        <aside className={styles.libraryPanel}>
          <div className={styles.panelTitle}>
            <div><span className={styles.eyebrow}>Reusable state</span><h2>Templates</h2></div>
            <button className={styles.addButton} disabled={autoplayLocked} onClick={() => setWizard(true)}><Plus size={17} />New</button>
          </div>
          {/*
            The room setting the coordinator exposes, where the person creating
            a room can see and choose it - and in the unit a presenter thinks
            in. A checkpoint on this stand needs roughly `wallClockSeconds`; a
            deadline below that races itself, which is invisible until a batch
            is refused.
          */}
          <label className={styles.deadlinePicker}>
            <span>New room proof deadline</span>
            <div>
              <input
                type="number"
                min={DEADLINE_BLOCKS_MIN}
                max={DEADLINE_BLOCKS_MAX}
                value={deadlineBlocks}
                disabled={autoplayLocked}
                onChange={(event) =>
                  setRoomDeadlineBlocks(
                    Math.max(
                      DEADLINE_BLOCKS_MIN,
                      Math.min(DEADLINE_BLOCKS_MAX, Number(event.target.value) || DEADLINE_BLOCKS_MIN),
                    ),
                  )
                }
              />
              <strong>blocks after start</strong>
            </div>
            <small>
              ≈ {deadlineSecondsForBlocks(deadlineBlocks, blockSeconds)} s at {blockSeconds} s
              blocks · coordinator default{' '}
              {system?.checkpointPolicy?.defaultDeadlineBlocks ??
                system?.gpu?.recommendedDeadlineBlocks ??
                4}{' '}
              blocks
              {system?.checkpointPolicy?.wallClockSeconds
                ? ` · a checkpoint needs about ${Math.ceil(system.checkpointPolicy.wallClockSeconds)} s`
                : ''}
            </small>
          </label>
          <div className={styles.templateList}>
            {templates.length === 0 ? (
              <button className={styles.emptyCard} disabled={autoplayLocked} onClick={() => setWizard(true)}>
                <Sparkles size={23} /><strong>Prepare your first room</strong><span>Choose a certified preset or compiled contract.</span>
              </button>
            ) : templates.map((template) => (
              <article className={styles.templateCard} key={template.id}>
                <div className={styles.cardTop}>
                  <span className={styles.templateIcon}><Box size={17} /></span>
                  <PhaseBadge phase={template.phase} />
                </div>
                <h3>{template.name}</h3>
                <p>{template.authorizationMode === 'VALIDITY_ONLY' ? 'Validity-only' : `${template.activeApprovers} unanimous approvers`} · {template.participantCapacity.toLocaleString()} users</p>
                {template.failure ? <small className={styles.failureText}>{template.failure.explanation}</small> : null}
                <div className={styles.templateMeta}>
                  <span>Cold proof</span><strong>{formatSeconds(template.preparation?.coldProofMs)}</strong>
                </div>
                <button
                  className={styles.cardAction}
                  disabled={autoplayLocked || template.phase !== 'ROOM_READY' || busy === `room:${template.id}`}
                  onClick={() => void createRoom(template)}
                >
                  {busy === `room:${template.id}` ? <LoaderCircle className={styles.spin} size={15} /> : <Plus size={15} />}
                  Create room
                </button>
              </article>
            ))}
          </div>
        </aside>

        <RoomStage
          rooms={rooms}
          selectedRoom={selectedRoom}
          selectedRoomId={selectedRoomId}
          onSelectRoom={setSelectedRoomId}
          selectedTemplate={selectedTemplate}
          system={system}
          blockActions={roomBlockActions}
          busy={busy}
          lastRefresh={lastRefresh}
          onDeploy={(room) => void deployRoom(room)}
          onCheckpoint={(room) => void checkpoint(room)}
          mutationsDisabled={autoplayLocked}
        />

        <aside className={styles.actionPanel}>
          <div className={styles.panelTitle}><div><span className={styles.eyebrow}>Presentation controls</span><h2>Actions</h2></div></div>
          {selectedRoom?.phase === 'ACTIVE' && selectedPreset ? (
            <div className={styles.actionList}>
              {selectedPreset.actions.map((action) => {
                const used = selectedRoom.actions.some((item) => item.actionId === action.id)
                return (
                  <button
                    key={action.id}
                    disabled={autoplayLocked || used || busy === `action:${action.id}`}
                    onClick={() => void triggerAction(selectedRoom, action)}
                  >
                    <span className={styles.actionNumber}>{action.recommendedBlock}</span>
                    <div><strong>{action.label}</strong><small>{action.actor}</small></div>
                    {used ? <Check size={17} /> : busy === `action:${action.id}` ? <LoaderCircle className={styles.spin} size={17} /> : <ChevronRight size={17} />}
                  </button>
                )
              })}
              <div className={styles.actionHint}><Clock3 size={15} />Actions are admitted now; canonical state changes only after the proof is accepted.</div>
            </div>
          ) : (
            <div className={styles.actionEmpty}><Activity size={28} /><strong>{selectedRoom ? phaseLabel(selectedRoom.phase) : 'Choose a room'}</strong><span>Scenario controls appear after deployment.</span></div>
          )}
          <div className={styles.ethereumRail}>
            <div className={styles.railHeader}><span><Blocks size={16} />Local Ethereum</span>{systemExplorerUrl ? <a href={systemExplorerUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a> : null}</div>
            {blocks.map((block) => (
              <div className={styles.ethBlockRow} key={block.number}>
                <span>#{block.number}</span><strong>{block.transactions} tx</strong><small>{new Date(block.timestamp).toLocaleTimeString()}</small>
              </div>
            ))}
            {system?.canary ? (
              (() => {
                const body = (
                  <>
                    <ShieldCheck size={16} /><div><strong>Startup room accepted</strong><span>{system.canary.transactionReference} · L1 #{system.canary.l1Block}</span></div>
                  </>
                )
                // Without a usable explorer URL this stays a row, not an
                // anchor to '#' that pretends to be one.
                return canaryExplorerUrl ? (
                  <a className={styles.canaryRow} href={canaryExplorerUrl} target="_blank" rel="noreferrer">{body}</a>
                ) : (
                  <div className={styles.canaryRow}>{body}</div>
                )
              })()
            ) : null}
          </div>
        </aside>
      </section>
      ) : null}

      {presentation === null || presentation === 'overview' ? (
      <footer className={styles.footer}>
        <span>Single GPU · persistent room history · 12-second local Ethereum blocks</span>
        <span>Correctness is proof-backed. Ordering and liveness remain service responsibilities.</span>
      </footer>
      ) : null}
      {(presentation === null || presentation === 'overview') && wizard && !autoplayLocked ? <TemplateWizard presets={presets} onClose={() => setWizard(false)} onCreated={refresh} /> : null}
    </main>
  )
}
