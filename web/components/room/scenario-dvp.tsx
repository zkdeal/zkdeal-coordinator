'use client'

import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { Panel, Badge, StatTile, Field } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import type { Room } from '@/lib/types'

/**
 * Central-Limit Delivery-versus-Payment (CL DvP) - OFFLINE ILLUSTRATION.
 *
 * This panel is NOT connected to the room: it imports no client, sends no L2
 * transaction, reads no contract state, and its "settlements" are local React
 * state transitions. It exists to illustrate the DvP workflow shape only.
 *
 * Everything user-visible here is therefore labelled SIMULATED, uses obviously
 * synthetic identifiers, and deliberately renders NO block numbers, tx hashes,
 * roots or addresses that could be mistaken for real chain data. It also makes
 * no atomicity or principal-risk claim about anything that happened - because
 * nothing happened.
 *
 * A real implementation must load trades from deterministic L2 state, use the
 * attached signer for propose/affirm/cancel, await block acknowledgement, and
 * derive status from verified chain state. Note also that the deployed
 * DvPSettlement contract has an open exit-attribution defect
 * (review/contracts.md H-01), so it must not be wired up until that is fixed.
 */

type TradeStatus = 'matched' | 'affirmed' | 'locked' | 'completed'

interface SimTrade {
  id: string
  seller: string
  buyer: string
  qty: number
  price: number
  status: TradeStatus
  /** Local step counter - NOT an L2 block height. */
  step?: number
}

const SECURITY_SYMBOL = 'SIM-SECURITY'
const CASH_SYMBOL = 'SIM-CASH'

const INITIAL_TRADES: SimTrade[] = [
  {
    id: 'SIM-0001',
    seller: 'Counterparty A',
    buyer: 'Counterparty B',
    qty: 500_000,
    price: 0.9842,
    status: 'completed',
    step: 3,
  },
  {
    id: 'SIM-0002',
    seller: 'Counterparty B',
    buyer: 'Counterparty C',
    qty: 250_000,
    price: 0.9851,
    status: 'affirmed',
  },
]

const STATUS_TONE: Record<TradeStatus, 'ok' | 'warn' | 'info' | 'muted'> = {
  matched: 'info',
  affirmed: 'warn',
  locked: 'info',
  completed: 'ok',
}

const NEXT_LABEL: Record<TradeStatus, string> = {
  matched: 'Affirm (simulated)',
  affirmed: 'Lock legs (simulated)',
  locked: 'Complete (simulated)',
  completed: '',
}

function SimulatedBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="text-xs leading-relaxed text-warning">
        <strong>SIMULATED - not connected to this channel.</strong> Nothing on this tab touches the
        room, the sequencer, L1, or any contract. The orders, statuses and totals below are local
        browser state that resets on reload; no transaction is created and no value moves. Use the
        Contracts tab for real L2 transactions.
      </div>
    </div>
  )
}

export function ScenarioDvp({ room }: { room: Room }) {
  const [trades, setTrades] = useState<SimTrade[]>(INITIAL_TRADES)
  const [log, setLog] = useState<string[]>(['[SIMULATED] local order book initialised'])
  const [qty, setQty] = useState('100000')
  const [price, setPrice] = useState('0.9850')
  const [nextId, setNextId] = useState(3)

  const pushLog = (msg: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  [SIMULATED] ${msg}`, ...l].slice(0, 8))

  function submitTrade() {
    const q = Number(qty)
    const p = Number(price)
    if (!q || !p) return
    const id = `SIM-${String(nextId).padStart(4, '0')}`
    setNextId((n) => n + 1)
    setTrades((t) => [
      {
        id,
        seller: 'Counterparty A',
        buyer: 'Counterparty C',
        qty: q,
        price: p,
        status: 'matched',
      },
      ...t,
    ])
    pushLog(`${id} added to the local list - ${q.toLocaleString()} ${SECURITY_SYMBOL} @ ${p}`)
  }

  function advance(id: string) {
    setTrades((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        const next: TradeStatus =
          t.status === 'matched'
            ? 'affirmed'
            : t.status === 'affirmed'
              ? 'locked'
              : t.status === 'locked'
                ? 'completed'
                : t.status
        if (next === t.status) return t
        pushLog(`${id} local status ${t.status} → ${next} (no transaction was sent)`)
        return { ...t, status: next, step: (t.step ?? 0) + 1 }
      }),
    )
  }

  const completedNotional = trades
    .filter((t) => t.status === 'completed')
    .reduce((s, t) => s + t.qty * t.price, 0)
  const openNotional = trades
    .filter((t) => t.status !== 'completed')
    .reduce((s, t) => s + t.qty * t.price, 0)

  const fmt = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${CASH_SYMBOL}`

  return (
    <div className="flex flex-col gap-4">
      <SimulatedBanner />

      <Panel
        title="CL DvP walkthrough (SIMULATED)"
        subtitle="Illustration of the delivery-versus-payment workflow - no room, contract or chain interaction"
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Security (sim)" value={SECURITY_SYMBOL} hint="Placeholder instrument" />
          <StatTile label="Cash leg (sim)" value={CASH_SYMBOL} hint="Placeholder unit of account" />
          <StatTile label="Completed (sim)" value={fmt(completedNotional)} tone="muted" />
          <StatTile label="Open (sim)" value={fmt(openNotional)} tone="muted" />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          In a real DvP room the security and cash legs would be escrowed and released inside a
          single L2 block, so neither counterparty is exposed to principal risk. This panel does
          not implement that: it only steps a local status machine, so no atomicity, escrow or
          settlement guarantee is demonstrated here. Channel{' '}
          <span className="font-mono text-foreground">{room.id}</span> is unaffected by anything on
          this tab.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="New order (SIMULATED)" className="lg:col-span-1">
          <div className="flex flex-col gap-3">
            <Field label={`Quantity (${SECURITY_SYMBOL})`}>
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-ring"
              />
            </Field>
            <Field label={`Limit price (${CASH_SYMBOL})`}>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-ring"
              />
            </Field>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {'Notional '}
              <span className="font-mono text-foreground">
                {fmt((Number(qty) || 0) * (Number(price) || 0))}
              </span>
            </div>
            <Button onClick={submitTrade} variant="secondary" className="w-full">
              Add to local list (simulated)
            </Button>
          </div>
        </Panel>

        <Panel title="Blotter (SIMULATED)" className="lg:col-span-2">
          <div className="flex flex-col gap-2">
            {trades.map((t) => (
              <div key={t.id} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-foreground">{t.id}</span>
                    <Badge tone={STATUS_TONE[t.status]}>{t.status} (sim)</Badge>
                  </div>
                  {t.status !== 'completed' && (
                    <Button size="sm" variant="secondary" onClick={() => advance(t.id)}>
                      {NEXT_LABEL[t.status]}
                    </Button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground md:grid-cols-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide">Seller (sim)</div>
                    <div className="text-foreground">{t.seller}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide">Buyer (sim)</div>
                    <div className="text-foreground">{t.buyer}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide">Quantity</div>
                    <div className="font-mono text-foreground">{t.qty.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide">Price</div>
                    <div className="font-mono text-foreground">{t.price}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Local event log (SIMULATED)" subtitle="UI state changes only - not chain events">
        <div className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
          {log.map((l, i) => (
            <div key={i} className="border-b border-border/50 py-1 last:border-0">
              {l}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
