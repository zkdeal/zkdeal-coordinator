'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, Input } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import type { AbiFunction } from '@/lib/types'

function placeholderFor(type: string): string {
  if (type === 'address') return '0x0000…0000'
  if (type.startsWith('uint') || type.startsWith('int')) return '0'
  if (type === 'bool') return 'true / false'
  if (type.startsWith('bytes')) return '0x…'
  return type
}

export interface AbiCallOutcome {
  /** L2 transaction hash of the signed raw tx that was actually submitted. */
  txHash: string
}

/**
 * One ABI entry.
 *
 * Write calls encode the entered values against the declared input types and
 * submit a real signed L2 transaction through the room client; the panel shows
 * either the real transaction hash or the real error. Nothing is synthesised -
 * this card previously rendered random return values and a random "l2 tx"
 * hash after a 420ms delay regardless of what happened.
 *
 * Read (`view`) calls are DISABLED: the room client exposes no L2 eth_call
 * path, so there is no honest way to answer them. See `readDisabledReason`.
 */
export function AbiFunctionCard({
  fn,
  contractAddress,
  onCall,
  disabled,
  disabledReason,
  readDisabledReason,
}: {
  fn: AbiFunction
  contractAddress: string
  /** Must reject on failure. Resolves with the real submitted tx hash. */
  onCall: (fn: AbiFunction, values: Record<string, string>) => Promise<AbiCallOutcome>
  disabled?: boolean
  disabledReason?: string
  readDisabledReason: string
}) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<AbiCallOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const isRead = fn.stateMutability === 'view'
  const tone = isRead ? 'primary' : 'accent'
  const blocked = isRead || !!disabled

  async function run() {
    setPending(true)
    setError(null)
    setResult(null)
    try {
      setResult(await onCall(fn, values))
    } catch (e) {
      setError((e as Error).message || String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Badge tone={tone}>{isRead ? 'view' : fn.stateMutability}</Badge>
          <span className="font-mono text-xs font-medium text-foreground">{fn.name}</span>
          {isRead && <Badge tone="muted">not implemented</Badge>}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          {fn.description && (
            <p className="text-[0.7rem] leading-snug text-muted-foreground">{fn.description}</p>
          )}

          <p className="font-mono text-[0.65rem] break-all text-muted-foreground">
            {contractAddress}
          </p>

          {fn.inputs.length > 0 && (
            <div className="flex flex-col gap-2">
              {fn.inputs.map((input, i) => (
                <label key={`${input.name}-${i}`} className="flex flex-col gap-1">
                  <span className="font-mono text-[0.7rem] text-muted-foreground">
                    {input.name || `arg${i}`} <span className="text-primary/70">{input.type}</span>
                  </span>
                  <Input
                    value={values[input.name || `arg${i}`] ?? ''}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [input.name || `arg${i}`]: e.target.value }))
                    }
                    placeholder={placeholderFor(input.type)}
                    className="font-mono text-xs"
                    disabled={blocked}
                  />
                </label>
              ))}
            </div>
          )}

          <Button
            size="sm"
            variant={isRead ? 'outline' : 'default'}
            onClick={() => void run()}
            disabled={pending || blocked}
            title={isRead ? readDisabledReason : disabledReason}
          >
            <Play className="size-3.5" />
            {isRead ? 'Query unavailable' : pending ? 'Submitting…' : 'Send transaction'}
          </Button>

          {isRead && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[0.7rem] leading-snug text-warning">
              {readDisabledReason}
            </p>
          )}
          {!isRead && disabled && disabledReason && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[0.7rem] leading-snug text-warning">
              {disabledReason}
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="font-mono text-[0.7rem] break-all text-destructive">{error}</span>
            </div>
          )}

          {result && (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5">
              <span className="font-mono text-[0.7rem] text-muted-foreground">
                submitted to the room mempool
              </span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[0.7rem] text-muted-foreground">l2 tx</span>
                <span className="truncate font-mono text-[0.7rem] text-success">
                  {result.txHash}
                </span>
              </div>
              <span className="text-[0.65rem] leading-snug text-muted-foreground">
                This is the hash of the signed transaction that was broadcast. Inclusion and
                success are visible in the block feed once the sequencer seals a block - this
                panel does not decode receipts.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
