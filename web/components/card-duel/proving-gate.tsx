'use client'

/**
 * The gate between "this stand can prove" and "this stand cannot".
 *
 * It never degrades into a server-side prover and never renders a placeholder
 * proof. When the artifacts are absent it says which file, on which
 * coordinator, and the command that produces it - because the honest failure is
 * the second most useful thing this page can show.
 */
import { CloudDownload, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/primitives'
import type { CardArtifactProgress, CardProvingGate } from '@/lib/card/artifacts'
import type { CardArtifactPhase } from './use-card-duel'

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

export function ProvingGate({
  gate,
  phase,
  progress,
  busy,
  onPrepare,
}: {
  gate: CardProvingGate | null
  phase: CardArtifactPhase
  progress: CardArtifactProgress | null
  busy: string | null
  onPrepare: () => void
}) {
  const ready = phase === 'ready'
  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-primary">
            {ready ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
            <span className="font-mono text-xs tracking-[0.18em] uppercase">Browser prover</span>
          </div>
          <h2 className="mt-2 text-lg font-semibold">
            {ready ? 'Proving locally' : 'The prover is not armed'}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Inner proofs are produced by snarkjs inside a dedicated worker in this tab. The circom
            wasm and proving keys are fetched from the coordinator and checked against
            <span className="font-mono"> circuits/card-artifacts.lock.json</span> before a single
            byte reaches the prover.
          </p>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!gate?.ready || phase === 'downloading' || ready || busy !== null}
          onClick={onPrepare}
        >
          <CloudDownload className="size-4" />
          {ready
            ? 'Artifacts verified'
            : phase === 'downloading'
              ? 'Downloading'
              : `Fetch and verify ${gate ? megabytes(gate.downloadBytes) : 'artifacts'}`}
        </button>
      </div>

      {progress ? (
        <div className="mt-4 rounded-xl border border-border bg-background/45 p-3 font-mono text-xs text-muted-foreground">
          {progress.loadedFiles}/{progress.totalFiles} · {progress.path} · {megabytes(progress.bytes)}
        </div>
      ) : null}

      {gate && !gate.ready ? (
        <ul className="mt-4 flex flex-col gap-2">
          {gate.missing.map((reason) => (
            <li
              key={reason}
              className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning"
            >
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone="warning" className="gap-1.5">
          <KeyRound className="size-3" />
          {gate?.ceremony ?? 'ceremony unknown'}
        </Badge>
        <span className="text-xs leading-relaxed text-muted-foreground">
          These proving keys never went through a multi-party ceremony. Anyone holding one can
          forge a proof of any statement of the circuit, so nothing on this page is a production
          confidentiality guarantee. What it does demonstrate is where the secret material lives.
        </span>
      </div>
    </section>
  )
}
