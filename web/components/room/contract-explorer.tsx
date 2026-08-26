'use client'

import { useState } from 'react'
import { FileCode2 } from 'lucide-react'
import { AbiFunctionCard, type AbiCallOutcome } from '@/components/room/abi-function'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives'
import { canonicalSignature, encodeArgs, isEncodable } from '@/lib/abi-encode'
import { shortAddr } from '@/lib/keys'
import { useRooms } from '@/lib/rooms-store'
import type { AbiFunction, ContractDef, Room } from '@/lib/types'

/**
 * There is no L2 read path in the room client (no eth_call surface), so view
 * functions cannot be answered. They are disabled rather than filled with
 * plausible-looking values.
 */
const READ_UNAVAILABLE =
  'Read (view) calls are not implemented in this build: the room client exposes no L2 eth_call path. Nothing is displayed rather than a fabricated value.'

const kindTone = {
  'ERC-4626': 'primary',
  DvP: 'accent',
  'ERC-20': 'muted',
  Custom: 'muted',
} as const

function ContractBlock({
  contract,
  roomId,
  attached,
}: {
  contract: ContractDef
  roomId: string
  attached: boolean
}) {
  const { submitCall } = useRooms()
  const [filter, setFilter] = useState<'all' | 'read' | 'write'>('all')

  const fns = contract.abi.filter((f) =>
    filter === 'all' ? true : filter === 'read' ? f.stateMutability === 'view' : f.stateMutability !== 'view',
  )

  async function handleCall(
    fn: AbiFunction,
    values: Record<string, string>,
  ): Promise<AbiCallOutcome> {
    // Encoding first: a bad input must fail before anything is signed.
    const argsData = encodeArgs(fn, values)
    const txHash = await submitCall(roomId, contract.address, canonicalSignature(fn), argsData)
    return { txHash }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <FileCode2 className="size-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">{contract.name}</span>
              <Badge tone={kindTone[contract.kind]}>{contract.kind}</Badge>
            </div>
            <span className="font-mono text-[0.7rem] text-muted-foreground">
              {contract.standard} · {shortAddr(contract.address)}
            </span>
          </div>
        </div>

        {contract.metrics && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(contract.metrics).map(([k, v]) => (
              <div key={k} className="rounded-md border border-border bg-background/40 p-2">
                <div className="font-mono text-[0.65rem] tracking-wide text-muted-foreground uppercase">
                  {k}
                </div>
                <div className="font-mono text-xs font-medium text-foreground">{v}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1 rounded-md border border-border bg-background/40 p-0.5 text-xs self-start">
          {(['all', 'read', 'write'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 font-medium capitalize transition-colors ${
                filter === f ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4">
        {fns.map((fn) => {
          const encodable = isEncodable(fn)
          return (
            <AbiFunctionCard
              key={fn.name}
              fn={fn}
              contractAddress={contract.address}
              onCall={handleCall}
              disabled={!attached || !encodable}
              disabledReason={
                !attached
                  ? `Not attached to channel ${roomId}. Join this channel before sending transactions - the client acts on the attached room only.`
                  : !encodable
                    ? 'This function takes a tuple or array argument, which this explorer cannot encode from text fields.'
                    : undefined
              }
              readDisabledReason={READ_UNAVAILABLE}
            />
          )
        })}
      </div>
    </div>
  )
}

export function ContractExplorer({ room }: { room: Room }) {
  const { isAttachedTo } = useRooms()
  const attached = isAttachedTo(room.id)
  return (
    <Card className="border-0 bg-transparent">
      <CardHeader className="px-0">
        <CardTitle>L2 contracts &amp; ABI</CardTitle>
        <p className="text-xs text-muted-foreground">
          ABIs from genesis / coordinator manifest. Write calls are encoded from the declared
          input types, signed as real L2 txs with the burner key and ordered FIFO at the sequencer
          (join-order leader). View calls are unavailable - see below.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-0">
        {!attached && room.contracts.length > 0 && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Not attached to channel <span className="font-mono">{room.id}</span>. Transactions are
            disabled: the shared client acts on its attached room, so sending from here could
            target a different channel.
          </p>
        )}
        {room.contracts.length ? (
          room.contracts.map((c) => (
            <ContractBlock key={c.address} contract={c} roomId={room.id} attached={attached} />
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No L2 contracts loaded yet. Join the channel and approve genesis to pull the
            coordinator manifest.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
