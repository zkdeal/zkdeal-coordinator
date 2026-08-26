'use client'

/**
 * Exit-attribution hints panel of the manifest composer.
 *
 * Split out of `components/manifest-composer.tsx`. The inline
 * `touch(); setHints(…)` closures became the editor's `setHintKind`,
 * `setHintContract`, `removeHint` and `addHint` actions - same bodies, same
 * order, now owned by `use-manifest-editor.ts`.
 */

import { Plus, Trash2 } from 'lucide-react'
import { MANIFEST_LIMITS, type AttributionHintEntry } from '@zkdeal/protocol'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/primitives'
import { HINT_KIND_LABEL } from '@/components/manifest-composer/editor-model'
import type { ManifestEditor } from '@/components/manifest-composer/use-manifest-editor'

export function AttributionHintsPanel({ editor }: { editor: ManifestEditor }) {
  const {
    entries,
    entryNames,
    hints,
    unattributedCustom,
    setHintKind,
    setHintContract,
    removeHint,
    addHint,
  } = editor
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
        Exit attribution hints
      </span>
      {hints.map((h) => (
        <div key={h.key} className="flex items-center gap-2">
          <Select
            aria-label="hint kind"
            className="h-7 w-auto min-w-40 text-xs"
            value={h.kind}
            onChange={(ev) => setHintKind(h.key, ev.target.value as AttributionHintEntry['kind'])}
          >
            {(Object.keys(HINT_KIND_LABEL) as Array<AttributionHintEntry['kind']>).map((k) => (
              <option key={k} value={k}>
                {HINT_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="hint contract"
            className="h-7 w-auto min-w-36 text-xs"
            value={h.contractName}
            onChange={(ev) => setHintContract(h.key, ev.target.value)}
          >
            <option value="">- contract -</option>
            {entryNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="remove hint"
            onClick={() => removeHint(h.key)}
          >
            <Trash2 className="size-3 text-destructive" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className="self-start"
        disabled={entries.length === 0 || hints.length >= MANIFEST_LIMITS.maxHints}
        onClick={addHint}
      >
        <Plus className="size-3" />
        Add hint
      </Button>
      {unattributedCustom.length > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[0.7rem] leading-snug text-warning">
          {unattributedCustom.map((e) => e.name).join(', ')}: value held in unattributed
          contracts falls to the dust policy - assigned to the last member in join order.
        </p>
      )}
    </div>
  )
}
