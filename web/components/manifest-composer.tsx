'use client'

/**
 * ManifestComposer - per-room contract selection inside the create dialog.
 *
 * Simple mode (default): three preset cards, preserving the 2-click flow.
 * "Customize contracts" expands the full composer: ordered deployment list
 * (catalog picks + custom forge-artifact bytecode), attribution-hints editor
 * and the zkVM execution-validity panel.
 *
 * Output policy: the composer ALWAYS emits a full RoomDeploymentManifest -
 * pure presets keep `presetId` set (scenario byte 0/1/2), modified sets drop
 * it (scenario byte 255) - so the manifest digest is verified end-to-end for
 * every room, preset or custom.
 *
 * This file is the shell: mode switch, seed picker and draft status. The
 * editor state and its actions live in `manifest-composer/use-manifest-editor`
 * and the three sections in the sibling panel components. `ComposerValue` is
 * re-exported so `@/components/manifest-composer` remains the one specifier
 * `create-room-dialog.tsx` imports.
 */

import { Settings2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/primitives'
import { PRESET_CARDS } from '@/lib/manifest-presets'
import { cn } from '@/lib/utils'
import type { ComposerValue } from '@/components/manifest-composer/editor-model'
import { useManifestEditor } from '@/components/manifest-composer/use-manifest-editor'
import { DeploymentsPanel } from '@/components/manifest-composer/deployments-panel'
import { AttributionHintsPanel } from '@/components/manifest-composer/attribution-hints-panel'
import { ZkvmPolicyPanel } from '@/components/manifest-composer/zkvm-policy-panel'

export type { ComposerValue }

export function ManifestComposer({ onChange }: { onChange: (v: ComposerValue) => void }) {
  const editor = useManifestEditor(onChange)
  const {
    customizing,
    setCustomizing,
    preset,
    setPreset,
    seededFrom,
    dirty,
    seedFromPreset,
    openCustomize,
    value,
  } = editor

  /* ---------------- simple mode ---------------- */

  if (!customizing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PRESET_CARDS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setPreset(c.id)}
              className={cn(
                'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
                preset === c.id
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border bg-background/40 hover:border-primary/30',
              )}
            >
              <span className="text-xs font-semibold text-foreground">{c.title}</span>
              <span className="text-[0.7rem] leading-snug text-muted-foreground">{c.blurb}</span>
              <span className="mt-1">
                {/* No audit report, auditor, version or bytecode attestation exists
                    for these contracts - do not imply one. */}
                <Badge tone="muted">built-in demo catalog</Badge>
              </span>
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={openCustomize}>
          <Settings2 className="size-3.5" />
          Customize contracts
        </Button>
      </div>
    )
  }

  /* ---------------- custom mode ---------------- */

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-background/30 p-3">
      {/* Seed picker */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[0.7rem] tracking-wide text-muted-foreground uppercase">
          Seed
        </span>
        {PRESET_CARDS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => seedFromPreset(c.id)}
            className={cn(
              'rounded-md border px-2 py-1 text-[0.7rem] transition-colors',
              seededFrom === c.id && !dirty
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {c.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => seedFromPreset('empty')}
          className="rounded-md border border-border px-2 py-1 text-[0.7rem] text-muted-foreground transition-colors hover:text-foreground"
        >
          Start empty
        </button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => setCustomizing(false)}
        >
          <X className="size-3" />
          Back to presets
        </Button>
      </div>

      <DeploymentsPanel editor={editor} />

      <AttributionHintsPanel editor={editor} />

      <ZkvmPolicyPanel editor={editor} />

      {value.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {value.error}
        </p>
      )}
      {!value.error && (
        <p className="text-[0.65rem] text-muted-foreground">
          {value.scenarioKey === 'custom'
            ? 'Custom manifest - every member must review and acknowledge before genesis.'
            : `Unmodified '${value.scenarioKey}' preset - standard 2-click flow.`}
        </p>
      )}
    </div>
  )
}
