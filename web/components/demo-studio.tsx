'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  ArrowRight,
  Boxes,
  CircleDollarSign,
  Clock3,
  Gamepad2,
  Gavel,
  Network,
  RefreshCcw,
  ShieldCheck,
  Store,
  WalletCards,
} from 'lucide-react'
import { demos, topology, type DemoId } from '@/components/demo-studio-data'

/**
 * The scenario scripts live in `components/demo-studio-data.ts`; this file is
 * the replay UI. `DemoId` is re-exported so `@/components/demo-studio` stays
 * the single import specifier for the page and its prop type.
 */
export type { DemoId }

function AppIcon({ id }: { id: DemoId }) {
  const Icon =
    id === 'dvp'
      ? WalletCards
      : id === 'amm'
        ? Network
        : id === 'vault'
          ? Boxes
          : id === 'card'
            ? Gamepad2
            : id === 'auction'
              ? Gavel
              : Store
  return <Icon className="size-5" />
}

export function DemoStudio({ initialApp }: { initialApp: DemoId }) {
  const [demoId, setDemoId] = useState<DemoId>(initialApp)
  const [stepIndex, setStepIndex] = useState(0)
  const demo = useMemo(() => demos.find((item) => item.id === demoId) ?? demos[0]!, [demoId])
  const step = demo.steps[stepIndex]!

  const selectDemo = (next: DemoId) => {
    setDemoId(next)
    setStepIndex(0)
  }

  return (
    <main className="grid-bg min-h-screen bg-background px-5 py-5 text-foreground">
      <div className="mx-auto max-w-[1500px]">
        <nav className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Image src="/zkdeal-icon.ico" alt="" width={24} height={24} />
            <span>zkdeal demo studio</span>
          </Link>
          <div className="flex items-center gap-2 rounded-full border border-warning/35 bg-warning/10 px-3 py-1.5 font-mono text-xs text-warning">
            <ShieldCheck className="size-3.5" />
            Application replay - not a live customer deployment
          </div>
        </nav>

        <header className="mt-5 flex items-end justify-between gap-8">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.22em] text-primary">
              More than a transaction. Less than a chain.
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Component-by-component application demonstrations
            </h1>
          </div>
          <div className="max-w-lg text-right text-sm leading-6 text-muted-foreground">
            Tested application logic is replayed through the same user, room, prover and
            Ethereum-checkpoint boundary.
          </div>
        </header>

        <div className="mt-5 grid grid-cols-6 gap-2" role="tablist" aria-label="Demo application">
          {demos.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`demo-tab-${item.id}`}
              onClick={() => selectDemo(item.id)}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                item.id === demo.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border bg-card/75 text-muted-foreground hover:text-foreground'
              }`}
            >
              <AppIcon id={item.id} />
              {item.short}
            </button>
          ))}
        </div>

        <section className="mt-4 grid grid-cols-[1.55fr_0.9fr] gap-4">
          <div className="rounded-2xl border border-border bg-card/85 p-5 shadow-2xl shadow-black/20">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="flex items-center gap-2 font-mono text-xs text-primary">
                  <AppIcon id={demo.id} />
                  {demo.mode}
                </div>
                <h2 className="mt-2 text-2xl font-semibold">{demo.title}</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                  {demo.claim}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStepIndex(0)}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-secondary"
              >
                <RefreshCcw className="size-3.5" />
                Reset
              </button>
            </div>

            <div className="mt-4 grid grid-cols-5 gap-2">
              {demo.steps.map((item, index) => (
                <div
                  key={item.phase}
                  className={`rounded-lg border px-2 py-2 text-center font-mono text-xs ${
                    index === stepIndex
                      ? 'border-primary bg-primary/15 text-primary'
                      : index < stepIndex
                        ? 'border-success/35 bg-success/10 text-success'
                        : 'border-border bg-background/45 text-muted-foreground'
                  }`}
                >
                  {index + 1}. {item.phase}
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                  <Clock3 className="size-5" />
                </span>
                <div>
                  <div className="font-mono text-xs uppercase tracking-wider text-primary">
                    In play - step {stepIndex + 1}
                  </div>
                  <div className="mt-1 text-lg font-semibold">{step.action}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{step.result}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              {[0, 1, 2].map((index) => (
                <div
                  key={step.metrics[index * 2]}
                  className="rounded-lg border border-border bg-background/55 p-3"
                >
                  <div className="text-xs text-muted-foreground">{step.metrics[index * 2]}</div>
                  <div className="mt-1 font-mono text-lg">{step.metrics[index * 2 + 1]}</div>
                </div>
              ))}
            </div>

            <button
              type="button"
              data-testid="advance-demo"
              onClick={() =>
                setStepIndex((current) =>
                  current === demo.steps.length - 1 ? 0 : current + 1,
                )
              }
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              {stepIndex === demo.steps.length - 1 ? 'Replay application' : 'Advance application'}
              <ArrowRight className="size-4" />
            </button>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-border bg-card/85 p-4">
              <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Owner / operator UX
              </div>
              <div className="mt-2 text-base font-semibold">{demo.operatorRole}</div>
              <div className="mt-2 rounded-lg border border-border bg-background/55 p-3 text-sm leading-6">
                {step.operator}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card/85 p-4">
              <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                User / counterparty UX
              </div>
              <div className="mt-2 text-base font-semibold">{demo.counterpartyRole}</div>
              <div className="mt-2 rounded-lg border border-border bg-background/55 p-3 text-sm leading-6">
                {step.counterparty}
              </div>
            </div>
            <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4">
              <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-warning">
                <CircleDollarSign className="size-4" />
                Claim boundary
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{demo.caveat}</p>
            </div>
          </aside>
        </section>

        <section className="mt-4 rounded-2xl border border-border bg-card/85 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-mono text-xs uppercase tracking-wider text-primary">
                Kurtosis component path
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Correctness flows left to right; ordering, liveness and data availability remain
                explicit responsibilities.
              </div>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              highlighted: {step.component}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2">
            {topology.map((node, index) => {
              const Icon = node.icon
              const active = node.id === step.component
              return (
                <div key={node.id} className="contents">
                  <div
                    className={`rounded-xl border p-3 text-center ${
                      active
                        ? 'border-primary bg-primary/15 text-primary shadow-lg shadow-primary/10'
                        : 'border-border bg-background/55 text-muted-foreground'
                    }`}
                  >
                    <Icon className="mx-auto size-5" />
                    <div className="mt-1 font-mono text-[0.68rem] font-semibold">{node.label}</div>
                    <div className="mt-1 text-[0.68rem]">{node.detail}</div>
                  </div>
                  {index < topology.length - 1 && (
                    <ArrowRight className="size-4 text-muted-foreground" />
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
