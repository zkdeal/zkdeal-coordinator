'use client'

import { useMemo, useState } from 'react'
import { parseEther } from 'viem'
import { ArrowDownToLine, TrendingUp, Vault } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardContent, CardHeader, CardTitle, Input, Stat } from '@/components/ui/primitives'
import { useRooms } from '@/lib/rooms-store'
import type { Room } from '@/lib/types'

export function ScenarioErc4626({ room }: { room: Room }) {
  const { client, isAttachedTo } = useRooms()
  // The shared client acts on ITS attached room; require exact identity.
  const attached = isAttachedTo(room.id)
  const [depositAmt, setDepositAmt] = useState('0.01')
  const [yieldAmt, setYieldAmt] = useState('0.001')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])

  const vault = useMemo(
    () => room.contracts.find((c) => c.kind === 'ERC-4626' || /vault/i.test(c.name)),
    [room.contracts],
  )

  async function deposit() {
    if (!vault || !attached) return
    setBusy(true)
    try {
      const assets = parseEther(depositAmt || '0')
      await client.vaultDeposit(assets, vault.address as `0x${string}`)
      setLog((l) => [`deposit ${depositAmt} ETH → vault`, ...l].slice(0, 8))
    } catch (e) {
      setLog((l) => [`error: ${(e as Error).message}`, ...l].slice(0, 8))
    } finally {
      setBusy(false)
    }
  }

  async function accrueYield() {
    if (!vault || !attached) return
    setBusy(true)
    try {
      const assets = parseEther(yieldAmt || '0')
      await client.vaultAccrueYield(vault.address as `0x${string}`, assets)
      setLog((l) => [
        `accrueYield ${yieldAmt} (caller-funded WNative - not organic yield)`,
        ...l,
      ].slice(0, 8))
    } catch (e) {
      setLog((l) => [`error: ${(e as Error).message}`, ...l].slice(0, 8))
    } finally {
      setBusy(false)
    }
  }

  async function withdrawUnwind() {
    if (!vault || !attached) return
    setBusy(true)
    try {
      const assets = parseEther(depositAmt || '0')
      await client.vaultWithdraw(assets, vault.address as `0x${string}`)
      setLog((l) => [`withdraw+unwrap ${depositAmt} (unwind before seal)`, ...l].slice(0, 8))
    } catch (e) {
      setLog((l) => [`error: ${(e as Error).message}`, ...l].slice(0, 8))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Vault className="size-4 text-primary" />
            <CardTitle>ERC-4626 vault scenario</CardTitle>
          </div>
          <Badge tone="primary">demo tokens in-channel</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat
              label="Vault"
              value={vault ? `${vault.address.slice(0, 8)}…` : '-'}
              sub={vault?.name ?? 'load genesis first'}
            />
            <Stat label="Asset scope" value="ETH / WNative" sub="not production RWA" />
            <Stat label="Yield source" value="caller-funded" sub="accrueYield demo" />
          </div>

          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[0.7rem] text-warning">
            Demo <span className="font-mono">accrueYield</span> injects caller-funded WNative - a
            redistribution of escrowed value, not organic yield.
          </div>

          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-background/40 p-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[0.7rem] text-muted-foreground">Deposit (ETH wei via L2)</span>
              <Input
                type="text"
                value={depositAmt}
                onChange={(e) => setDepositAmt(e.target.value)}
                placeholder="0.01"
              />
            </label>
            <Button size="sm" disabled={busy || !vault || !attached} onClick={() => void deposit()}>
              <ArrowDownToLine className="size-3.5" />
              Deposit
            </Button>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[0.7rem] text-muted-foreground">Yield inject (caller-funded)</span>
              <Input
                type="text"
                value={yieldAmt}
                onChange={(e) => setYieldAmt(e.target.value)}
                placeholder="0.001"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !vault || !attached}
              onClick={() => void accrueYield()}
            >
              <TrendingUp className="size-3.5" />
              Accrue (demo)
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !vault || !attached}
              onClick={() => void withdrawUnwind()}
            >
              Withdraw / unwind
            </Button>
          </div>

          {log.length > 0 && (
            <ul className="font-mono text-[0.7rem] text-muted-foreground">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}

          <p className="text-[0.7rem] leading-snug text-muted-foreground">
            Calls are signed as L2 typed txs (EIP-1559 zero-fee by default), gossiped to the FIFO sequencer, and only signed
            into a checkpoint after every member re-executes the block.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
