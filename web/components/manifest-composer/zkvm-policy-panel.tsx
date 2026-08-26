'use client'

/**
 * zkVM execution-validity panel of the manifest composer.
 *
 * Split out of `components/manifest-composer.tsx` unchanged. The three
 * controls write straight through to the editor state that feeds the emitted
 * manifest's `zkvm` block; the defaults they start from come from the
 * protocol (`ZKVM_DEFAULTS` in editor-model.ts), never re-typed here.
 */

import { MANIFEST_LIMITS, type ZkvmBackendId, type ZkvmPolicy } from '@zkdeal/protocol'
import { Field, Input, Select } from '@/components/ui/primitives'
import type { ManifestEditor } from '@/components/manifest-composer/use-manifest-editor'

export function ZkvmPolicyPanel({ editor }: { editor: ManifestEditor }) {
  const {
    zkvmBackend,
    setZkvmBackend,
    maxLagBlocks,
    setMaxLagBlocks,
    settlePolicy,
    setSettlePolicy,
    programDigest,
    risc0Digest,
    ligetronDigest,
  } = editor
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
        zkVM execution validity
      </span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Backend">
          <Select
            className="h-7 text-xs"
            value={zkvmBackend}
            onChange={(ev) => setZkvmBackend(ev.target.value as ZkvmBackendId)}
          >
            <option value="none">none (JS re-execution only)</option>
            <option value="risc0" disabled={!risc0Digest}>
              risc0{!risc0Digest ? ' - artifacts not deployed' : ''}
            </option>
            <option value="ligetron" disabled={!ligetronDigest}>
              ligetron{!ligetronDigest ? ' - artifacts not deployed' : ''}
            </option>
          </Select>
        </Field>
        <Field label="Max lag (blocks)">
          <Input
            type="number"
            min={1}
            max={MANIFEST_LIMITS.maxLagBlocksCap}
            className="h-7 text-xs"
            value={maxLagBlocks}
            onChange={(ev) =>
              setMaxLagBlocks(
                Math.min(
                  MANIFEST_LIMITS.maxLagBlocksCap,
                  Math.max(1, Number(ev.target.value) || 1),
                ),
              )
            }
          />
        </Field>
        <Field label="Settle policy">
          <Select
            className="h-7 text-xs"
            value={settlePolicy}
            onChange={(ev) =>
              setSettlePolicy(ev.target.value as ZkvmPolicy['settle'])
            }
          >
            <option value="no-wait">no-wait</option>
            <option value="require-receipts">require-receipts</option>
          </Select>
        </Field>
      </div>
      {zkvmBackend !== 'none' && programDigest && (
        <p className="font-mono text-[0.65rem] break-all text-muted-foreground">
          programDigest {programDigest}
        </p>
      )}
    </div>
  )
}
