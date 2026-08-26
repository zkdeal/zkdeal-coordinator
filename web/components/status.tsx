'use client'

import { useEffect, useState } from 'react'

type ServiceState = 'checking' | 'ready' | 'not-ready' | 'offline'

interface RuntimeStatus {
  coordinator: ServiceState
  roomManager: string | null
  admission: ServiceState
}

/** Routes that exist in `app/` but are linked from nowhere else. */
const ROUTES = [
  { href: '/applications', label: 'Application demos' },
  { href: '/card-duel', label: 'Hidden-card duel (browser proving)' },
  { href: '/room-pool', label: 'Allocate a room (Web3)' },
  { href: '/demo', label: 'Live room studio' },
  { href: '/demo-studio', label: 'Demo studio' },
] as const

const initialStatus: RuntimeStatus = {
  coordinator: 'checking',
  roomManager: null,
  admission: 'checking',
}

function StatusDot({ state }: { state: ServiceState }) {
  const color =
    state === 'ready'
      ? 'bg-emerald-300'
      : state === 'checking'
        ? 'bg-amber-300'
        : 'bg-slate-500'
  return <span aria-hidden className={`inline-block size-2 rounded-full ${color}`} />
}

function stateLabel(state: ServiceState): string {
  if (state === 'ready') return 'ready'
  if (state === 'checking') return 'checking'
  if (state === 'offline') return 'offline'
  return 'not configured'
}

/** `0x1234…cdef`; the full address is not useful chrome on a landing page. */
function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

async function readJson(path: string): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(path, { cache: 'no-store' })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A reverse proxy may return plain text; the status code remains useful.
  }
  return { ok: response.ok, body }
}

function readField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' && key in body
    ? (body as Record<string, unknown>)[key]
    : undefined
}

export function Status() {
  const [runtime, setRuntime] = useState<RuntimeStatus>(initialStatus)

  useEffect(() => {
    let active = true
    // `/health` and `/config` are the two unconditional coordinator routes;
    // every other surface is deployment-gated, so polling one would report
    // "offline" for a healthy coordinator that simply has demos disabled.
    void Promise.allSettled([readJson('/health'), readJson('/config')]).then((results) => {
      if (!active) return
      const health = results[0]
      const config = results[1]
      const configBody = config.status === 'fulfilled' ? config.value.body : null
      const roomManager = readField(configBody, 'roomManager')
      const admissionEnabled = readField(configBody, 'admissionEnabled')
      setRuntime({
        coordinator:
          health.status === 'fulfilled' ? (health.value.ok ? 'ready' : 'not-ready') : 'offline',
        roomManager: typeof roomManager === 'string' && roomManager.length > 0 ? roomManager : null,
        admission:
          config.status !== 'fulfilled'
            ? 'offline'
            : admissionEnabled === true
              ? 'ready'
              : 'not-ready',
      })
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <main className="grid-bg min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg border border-cyan-300/30 bg-cyan-300/10 font-mono text-sm font-semibold text-cyan-200">
              zk
            </span>
            <div>
              <p className="font-mono text-sm font-semibold tracking-[0.18em]">ZKDEAL</p>
              <p className="text-xs text-muted-foreground">proof-backed long-lived rooms</p>
            </div>
          </div>
          <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 font-mono text-[0.68rem] tracking-[0.16em] text-amber-200">
            EVIDENCE GATED
          </span>
        </header>

        <section className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[1.2fr_0.8fr] lg:py-20">
          <div>
            <p className="mb-5 font-mono text-xs tracking-[0.22em] text-cyan-200">
              ORDER · APPROVE · PROVE · ADVANCE
            </p>
            <h1 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.04em] sm:text-6xl">
              Long-lived rooms with room-local EVM execution and an L1 proof boundary.
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
              A room repeatedly accepts ordered room-local EVM batches, authenticated L1 inputs,
              approver changes, deposits and withdrawals. Small jointly controlled rooms use
              unanimous checkpoint approval; application rooms use signed customer transactions and
              a validity proof without customer checkpoint consensus. Both are committed by the L1
              RoomManager. Execution is room-local, not live Ethereum composability.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="/kurtosis"
                className="rounded-lg bg-cyan-200 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-100"
              >
                Play protocol stories
              </a>
              {/* These routes existed but were reachable only by typing the
                  URL - nothing on the landing page linked to them. */}
              {ROUTES.map((route) => (
                <a
                  key={route.href}
                  href={route.href}
                  className="rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.08]"
                >
                  {route.label}
                </a>
              ))}
            </div>
            {/* These are Fastify JSON handlers, not pages: they leave the SPA
                on a coordinator-served deployment and do not exist at all
                under the package's own static start script. Labelled and
                opened in a new tab rather than presented as app navigation. */}
            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono tracking-[0.14em]">RAW COORDINATOR JSON</span>
              <a
                href="/config"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-white/25 underline-offset-4 transition hover:text-foreground"
              >
                /config
              </a>
              <a
                href="/health"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-white/25 underline-offset-4 transition hover:text-foreground"
              >
                /health
              </a>
            </div>
          </div>

          <aside className="rounded-2xl border border-white/10 bg-slate-950/65 p-5 shadow-2xl shadow-black/30 backdrop-blur">
            <p className="font-mono text-xs tracking-[0.18em] text-muted-foreground">
              CURRENT OPERATIONAL CLAIM
            </p>
            <p className="mt-4 text-lg leading-7">
              Unanimous approval or validity-only authorization, both settled behind a pinned
              proof program and a verifier-accepted seal on L1.
            </p>
            <div className="mt-6 grid gap-3 border-t border-white/10 pt-5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Coordinator</span>
                <span className="flex items-center gap-2 font-mono text-xs">
                  <StatusDot state={runtime.coordinator} /> {stateLabel(runtime.coordinator)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Admission service</span>
                <span className="flex items-center gap-2 font-mono text-xs">
                  <StatusDot state={runtime.admission} /> {stateLabel(runtime.admission)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">L1 RoomManager</span>
                <span className="font-mono text-xs">
                  {runtime.roomManager ? shortAddress(runtime.roomManager) : '-'}
                </span>
              </div>
            </div>
          </aside>
        </section>

        <section className="grid gap-4 border-t border-white/10 py-10 md:grid-cols-3">
          {[
            {
              eyebrow: 'VALIDITY-ONLY ROOM',
              title: 'Commit-reveal auction',
              body: 'Uniform-price clearing with deterministic partial fills; bids stay committed until reveal.',
            },
            {
              eyebrow: 'PERSISTENT WORKLOAD',
              title: 'Tokenized shop',
              body: 'A long-lived room that keeps serving purchases across checkpoints instead of closing out.',
            },
            {
              eyebrow: 'PRIVATE APP DEMO',
              title: 'Hidden card duel',
              body: 'Browser-local deck and hand proofs; the server never receives unrevealed card witnesses.',
            },
          ].map((item) => (
            <article key={item.title} className="rounded-xl border border-white/10 bg-white/[0.035] p-5">
              <p className="font-mono text-[0.68rem] tracking-[0.18em] text-cyan-200">{item.eyebrow}</p>
              <h2 className="mt-3 text-lg font-semibold">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-4 pb-12 md:grid-cols-2">
          <article className="rounded-xl border border-emerald-300/20 bg-emerald-300/[0.055] p-5">
            <p className="font-mono text-[0.68rem] tracking-[0.18em] text-emerald-200">
              MEASURED COMPATIBILITY
            </p>
            <p className="mt-3 text-2xl font-semibold">17,902 / 17,902 official cases</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every applicable official Osaka case passes in both REVM and EthereumJS, and all 256
              opcode byte values are classified and tested.
            </p>
          </article>
          <article className="rounded-xl border border-amber-300/20 bg-amber-300/[0.055] p-5">
            <p className="font-mono text-[0.68rem] tracking-[0.18em] text-amber-200">
              GPU / L1 LATENCY GATE
            </p>
            <p className="mt-3 text-2xl font-semibold">NOT REQUALIFIED</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The 8x H100 p95 target has not been requalified with the final production binary, so no
              one-slot claim ships.
            </p>
          </article>
        </section>

        <footer className="flex flex-col gap-2 border-t border-white/10 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Reusable approver Merkle set with epochs · deposits escrowed on L1 until proven</span>
          <span>Room-local execution with public post-submission calldata, not confidentiality</span>
        </footer>
      </div>
    </main>
  )
}
