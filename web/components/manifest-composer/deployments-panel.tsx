'use client'

/**
 * Deployment list of the manifest composer: the ordered genesis deploy list
 * (catalog picks and custom forge-artifact bytecode) plus the add-custom form.
 *
 * Split out of `components/manifest-composer.tsx` unchanged; every handler it
 * calls lives in `use-manifest-editor.ts`.
 */

import { ArrowDown, ArrowUp, Plus, Trash2, Upload } from 'lucide-react'
import { MANIFEST_LIMITS } from '@zkdeal/protocol'
import { Button } from '@/components/ui/button'
import { Badge, Field, Input, Select, Textarea } from '@/components/ui/primitives'
import type { ManifestEditor } from '@/components/manifest-composer/use-manifest-editor'

export function DeploymentsPanel({ editor }: { editor: ManifestEditor }) {
  const {
    entries,
    entryNames,
    totalCustomBytes,
    catalog,
    addCatalogId,
    setAddCatalogId,
    addCatalogEntry,
    customFormOpen,
    setCustomFormOpen,
    customName,
    setCustomName,
    customJson,
    setCustomJson,
    customError,
    setCustomError,
    addCustomEntry,
    removeEntry,
    moveEntry,
    renameEntry,
    setArg,
  } = editor
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
          Deployments (order = genesis deploy order)
        </span>
        <span className="font-mono text-[0.65rem] text-muted-foreground">
          {entries.length}/{MANIFEST_LIMITS.maxDeployments}
          {totalCustomBytes > 0 &&
            ` · custom ${totalCustomBytes}/${MANIFEST_LIMITS.maxTotalCustomBytecodeBytes} B`}
        </span>
      </div>

      {entries.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No deployments yet - add from the catalog or paste custom bytecode.
        </p>
      )}

      {entries.map((e, idx) => {
        const earlier = entryNames.slice(0, idx)
        return (
          <div key={e.key} className="rounded-md border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[0.65rem] text-muted-foreground">#{idx}</span>
              <Input
                aria-label={`deployment ${idx} name`}
                className="h-7 max-w-40 font-mono text-xs"
                value={e.name}
                onChange={(ev) => renameEntry(e.key, ev.target.value)}
              />
              {e.source === 'catalog' ? (
                <Badge tone="success">catalog · {e.catalogId}</Badge>
              ) : (
                <Badge tone="warning">custom · {e.byteLength ?? '?'} B</Badge>
              )}
              <div className="ml-auto flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="move up"
                  disabled={idx === 0}
                  onClick={() => moveEntry(e.key, -1)}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="move down"
                  disabled={idx === entries.length - 1}
                  onClick={() => moveEntry(e.key, 1)}
                >
                  <ArrowDown className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="remove"
                  onClick={() => removeEntry(e.key)}
                >
                  <Trash2 className="size-3 text-destructive" />
                </Button>
              </div>
            </div>
            {e.args.length > 0 && (
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {e.args.map((a, ai) => (
                  <div key={ai} className="flex flex-col gap-1">
                    <span className="text-[0.65rem] text-muted-foreground">
                      {a.label} <span className="font-mono">({a.kind})</span>
                    </span>
                    {a.kind === 'genesisDeployer' ? (
                      <Badge tone="muted" className="w-fit">
                        genesis deployer
                      </Badge>
                    ) : a.kind === 'contractAddress' ? (
                      <Select
                        className="h-7 text-xs"
                        value={a.value}
                        onChange={(ev) => setArg(e.key, ai, ev.target.value)}
                      >
                        <option value="">- earlier deployment -</option>
                        {earlier.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                    ) : a.kind === 'bool' ? (
                      <Select
                        className="h-7 text-xs"
                        value={a.value}
                        onChange={(ev) => setArg(e.key, ai, ev.target.value)}
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </Select>
                    ) : (
                      <Input
                        className="h-7 font-mono text-xs"
                        placeholder={
                          a.kind === 'uint256'
                            ? '0'
                            : a.kind === 'address'
                              ? '0x…40 hex'
                              : a.kind === 'bytes32'
                                ? '0x…64 hex'
                                : 'text'
                        }
                        value={a.value}
                        onChange={(ev) => setArg(e.key, ai, ev.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="add catalog contract"
          className="h-7 w-auto min-w-44 text-xs"
          value={addCatalogId}
          onChange={(ev) => setAddCatalogId(ev.target.value)}
        >
          <option value="">Add from catalog…</option>
          {catalog.map((c) => (
            <option key={c.catalogId} value={c.catalogId}>
              {c.name} ({c.catalogId})
            </option>
          ))}
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={!addCatalogId}
          onClick={() => {
            addCatalogEntry(addCatalogId)
            setAddCatalogId('')
          }}
        >
          <Plus className="size-3" />
          Add
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setCustomFormOpen((v) => !v)}
        >
          <Upload className="size-3" />
          {customFormOpen ? 'Close custom form' : 'Add custom bytecode'}
        </Button>
      </div>

      {customFormOpen && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5">
          <p className="text-[0.7rem] leading-snug text-warning">
            Custom bytecode is <strong>unreviewed</strong>. Every member sees it on the
            review screen and must acknowledge before approving genesis.
          </p>
          <Field label="Contract name" hint="Letters, digits, underscore; must start with a letter.">
            <Input
              className="h-7 max-w-48 font-mono text-xs"
              value={customName}
              onChange={(ev) => setCustomName(ev.target.value)}
              placeholder="MyEscrow"
            />
          </Field>
          <Field
            label="Forge artifact JSON"
            hint={`Paste out/<C>.sol/<C>.json - abi + bytecode.object are extracted. Max ${MANIFEST_LIMITS.maxCustomBytecodeBytes} bytes of creation code.`}
          >
            <Textarea
              className="min-h-24 font-mono text-[0.7rem]"
              value={customJson}
              onChange={(ev) => setCustomJson(ev.target.value)}
              placeholder='{"abi":[…],"bytecode":{"object":"0x…"}}'
            />
          </Field>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer text-[0.7rem] text-primary underline-offset-2 hover:underline">
              Upload artifact file
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(ev) => {
                  const file = ev.target.files?.[0]
                  if (!file) return
                  void file.text().then((text) => {
                    setCustomJson(text)
                    setCustomError(null)
                  })
                  ev.target.value = ''
                }}
              />
            </label>
            <Button
              type="button"
              size="xs"
              className="ml-auto"
              disabled={!customJson.trim()}
              onClick={addCustomEntry}
            >
              <Plus className="size-3" />
              Add deployment
            </Button>
          </div>
          {customError && <p className="text-xs text-destructive">{customError}</p>}
        </div>
      )}
    </div>
  )
}
