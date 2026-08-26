'use client'

/**
 * /applications - two APPLICATION rooms, each able to drive itself end to end.
 *
 * Both were interactive models until the coordinator on this stand grew the
 * presets behind them. They are now real: pressing one button prepares a cold
 * template from the certified preset and proves it on the GPU, opens a room,
 * deploys it on L1, submits the preset's own room actions, and proves and
 * settles the batch - with the resulting transaction hash rendered as a link
 * into the block explorer the coordinator itself advertises.
 *
 * The page therefore no longer carries a "not a live proof" warning, because
 * that would now be false. What it carries instead is the honest boundary: this
 * demonstrates TOKENIZED delivery, and physical fulfilment is still outside
 * anything a proof can promise.
 *
 * The self-driving machinery is shared with the hidden-card duel
 * (`lib/autoplay/run.ts`, `components/autoplay/presenter-bar.tsx`) so the
 * gesture a presenter learns on one page works on the other.
 */
import Link from 'next/link'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { Gavel, Store } from 'lucide-react'

import { ApplicationDemo } from '@/components/applications/application-demo'
import {
  AUCTION_SCRIPT,
  SHOP_SCRIPT,
} from '@/lib/applications/application-run'
import { applicationPresentation } from '@/lib/presentation'

export function ApplicationDemos() {
  const selected = applicationPresentation(useSearchParams().get('demo'))
  const focused = selected !== null

  return (
    <main
      className={`grid-bg min-h-screen px-4 ${focused ? 'py-3' : 'py-8'}`}
      data-presentation={selected ?? undefined}
    >
      <div className="mx-auto max-w-7xl">
        <nav className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Image src="/zkdeal-icon.ico" alt="" width={26} height={26} />
            <span>zkdeal</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {/* The card duel is the one application whose moves cannot be
                canned into preset actions: every one of them depends on a
                participant leaf, a nonce and a proof only the player holds. So
                it is linked as a peer rather than folded into this page. */}
            <Link
              href="/card-duel"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Hidden-card duel
            </Link>
            <Link
              href="/demo"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Live room studio
            </Link>
            <span className="rounded-full border border-success/30 bg-success/10 px-3 py-1 font-mono text-xs text-success">
              Real rooms · real proofs · real L1 transactions
            </span>
          </div>
        </nav>
        <header className={focused ? 'py-4' : 'py-10'}>
          <div className="font-mono text-xs uppercase tracking-[0.24em] text-primary">
            More than a transaction. Less than a chain.
          </div>
          <h1 className={`mt-3 max-w-4xl font-semibold tracking-tight ${focused ? 'text-2xl sm:text-3xl' : 'text-4xl sm:text-5xl'}`}>
            {focused
              ? `${selected === 'auction' ? 'Auction' : 'Shop'} · live proof-backed room`
              : 'Large audiences transact. A validity proof replaces customer consensus.'}
          </h1>
          <p className={`${focused ? 'mt-2 text-sm leading-5' : 'mt-4 text-base leading-7'} max-w-3xl text-muted-foreground`}>
            Each panel below opens a real room on this stand and settles it on Ethereum. Admission,
            application state, the proof checkpoint and the settling transaction are all shown as
            they happen. They demonstrate tokenized delivery only; physical fulfillment remains
            outside the guarantee.
          </p>
          {!focused ? <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            There is one GPU behind both panels and proofs serialize on it. Running both at once
            works - the second one waits, visibly, and says how many proofs are ahead of it.
          </p> : null}
        </header>
        <div className={`grid gap-6 ${focused ? 'grid-cols-1' : 'xl:grid-cols-2'}`}>
          {selected !== 'shop' ? (
          <ApplicationDemo
            focused={focused}
            script={AUCTION_SCRIPT}
            accent="primary"
            eyebrow="Validity-only room"
            icon={<Gavel className="size-5" />}
            summary="Prices stay committed until reveal. Tokenized items clear at the marginal accepted price with deterministic partial fills."
          />
          ) : null}
          {selected !== 'auction' ? (
          <ApplicationDemo
            focused={focused}
            script={SHOP_SCRIPT}
            accent="accent"
            eyebrow="Persistent application room"
            icon={<Store className="size-5" />}
            summary="Registration establishes a session key and spending limit. A later purchase is one signed room transaction; the customer can leave before the proof checkpoint."
          />
          ) : null}
        </div>
      </div>
    </main>
  )
}
