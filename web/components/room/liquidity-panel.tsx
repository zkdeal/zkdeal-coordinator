'use client'

import { Lock } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives'
import { formatNumber } from '@/lib/format'
import { shortAddr } from '@/lib/keys'
import type { Room } from '@/lib/types'

export function LiquidityPanel({ room }: { room: Room }) {
  const escrowEth = room.totalEscrowWei
    ? Number(BigInt(room.totalEscrowWei)) / 1e18
    : room.liquidity.reduce((s, l) => s + l.amount, 0)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-primary" />
          <CardTitle>L1 escrow</CardTitle>
        </div>
        <Badge tone="primary">{formatNumber(escrowEth)} ETH</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Deposits are locked in RoomManager at <span className="font-mono">joinRoom</span>. Exits
          become claimable after <span className="font-mono">finalize</span> (or abort refunds) -
          members pull via <span className="font-mono">claim</span>.
        </p>
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-secondary/50 font-mono text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {room.liquidity.length ? (
                room.liquidity.map((l) => (
                  <tr key={l.symbol}>
                    <td className="px-3 py-2">
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">{l.symbol}</span>
                        <span className="text-[0.7rem] text-muted-foreground">{l.token}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground tabular-nums">
                      {formatNumber(l.amount)}
                    </td>
                    <td className="hidden px-3 py-2 text-right font-mono text-muted-foreground sm:table-cell">
                      {shortAddr(l.provider)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No escrow yet - join with the room deposit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
