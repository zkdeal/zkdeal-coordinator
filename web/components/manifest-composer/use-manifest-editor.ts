'use client'

/**
 * All composer state, editing actions and draft validation.
 *
 * Split out of `components/manifest-composer.tsx` verbatim so the component
 * file carries only rendering. The hook returns one `ManifestEditor` object;
 * the panels take it as a single prop rather than a re-enumerated prop list,
 * which is what keeps this a move rather than a rewrite.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ROOM_MANIFEST_VERSION,
  validateManifestShape,
  type AttributionHintEntry,
  type ManifestDeployment,
  type RoomDeploymentManifest,
  type ZkvmBackendId,
  type ZkvmPolicy,
} from '@zkdeal/protocol'
import { fetchContractsManifest } from '@/lib/coordinator'
import { useRooms } from '@/lib/rooms-store'
import {
  MANIFEST_NAME_RE,
  customEntrySupportsHint,
  parseCatalog,
  parseForgeArtifact,
  presetManifest,
  zkvmProgramDigestFromConfig,
  type CatalogUiEntry,
  type PresetId,
} from '@/lib/manifest-presets'
import {
  ZKVM_DEFAULTS,
  editorArgToManifestArg,
  entriesFromManifest,
  hintsFromManifest,
  nextKey,
  sanitizeName,
  type ComposerValue,
  type EditorArg,
  type EditorEntry,
  type EditorHint,
} from '@/components/manifest-composer/editor-model'

export interface ManifestEditor {
  catalog: CatalogUiEntry[]
  customizing: boolean
  preset: PresetId
  entries: EditorEntry[]
  hints: EditorHint[]
  seededFrom: PresetId | null
  dirty: boolean
  zkvmBackend: ZkvmBackendId
  maxLagBlocks: number
  settlePolicy: ZkvmPolicy['settle']
  customFormOpen: boolean
  customName: string
  customJson: string
  customError: string | null
  addCatalogId: string
  /** Digest of the selected backend's deployed artifacts, null when absent. */
  programDigest: string | null
  risc0Digest: string | null
  ligetronDigest: string | null
  /** Names in deploy order; a contractAddress arg may only reference earlier ones. */
  entryNames: string[]
  totalCustomBytes: number
  unattributedCustom: EditorEntry[]
  value: ComposerValue
  setPreset: (p: PresetId) => void
  setCustomizing: (v: boolean) => void
  setZkvmBackend: (b: ZkvmBackendId) => void
  setMaxLagBlocks: (n: number) => void
  setSettlePolicy: (s: ZkvmPolicy['settle']) => void
  setCustomFormOpen: (fn: (v: boolean) => boolean) => void
  setCustomName: (v: string) => void
  setCustomJson: (v: string) => void
  setCustomError: (v: string | null) => void
  setAddCatalogId: (v: string) => void
  seedFromPreset: (p: PresetId | 'empty') => void
  openCustomize: () => void
  addCatalogEntry: (catalogId: string) => void
  addCustomEntry: () => void
  removeEntry: (key: string) => void
  moveEntry: (key: string, dir: -1 | 1) => void
  renameEntry: (key: string, name: string) => void
  setArg: (entryKey: string, argIdx: number, value: string) => void
  setHintKind: (key: string, kind: AttributionHintEntry['kind']) => void
  setHintContract: (key: string, contractName: string) => void
  removeHint: (key: string) => void
  addHint: () => void
}

export function useManifestEditor(onChange: (v: ComposerValue) => void): ManifestEditor {
  const { config } = useRooms()
  const [catalog, setCatalog] = useState<CatalogUiEntry[]>([])
  const [customizing, setCustomizing] = useState(false)
  const [preset, setPreset] = useState<PresetId>('erc4626')

  // Custom-mode editor state
  const [entries, setEntries] = useState<EditorEntry[]>([])
  const [hints, setHints] = useState<EditorHint[]>([])
  const [seededFrom, setSeededFrom] = useState<PresetId | null>(null)
  const [dirty, setDirty] = useState(false)

  // zkVM panel (custom mode; simple mode keeps the default policy). Seeded
  // from defaultZkvmPolicy() rather than re-typed: the manifest digest is
  // anchored into genesis, so a value that silently drifts from the protocol
  // default surfaces as a genesis mismatch, not as a build error.
  const [zkvmBackend, setZkvmBackend] = useState<ZkvmBackendId>(ZKVM_DEFAULTS.backend)
  const [maxLagBlocks, setMaxLagBlocks] = useState(ZKVM_DEFAULTS.proving.maxLagBlocks)
  const [settlePolicy, setSettlePolicy] = useState<ZkvmPolicy['settle']>(ZKVM_DEFAULTS.settle)

  // Add-custom form
  const [customFormOpen, setCustomFormOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customJson, setCustomJson] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [addCatalogId, setAddCatalogId] = useState('')

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    let cancelled = false
    fetchContractsManifest()
      .then((cm) => {
        if (!cancelled) setCatalog(parseCatalog(cm))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const catalogById = useMemo(
    () => new Map(catalog.map((c) => [c.catalogId, c])),
    [catalog],
  )

  function seedFromPreset(p: PresetId | 'empty'): void {
    if (p === 'empty') {
      setEntries([])
      setHints([])
      setSeededFrom(null)
      setDirty(true) // never a pure preset
      return
    }
    const m = presetManifest(p)
    setEntries(entriesFromManifest(m, catalog))
    setHints(hintsFromManifest(m))
    setSeededFrom(p)
    setDirty(false)
  }

  function openCustomize(): void {
    seedFromPreset(preset)
    setCustomizing(true)
  }

  /** Any structural edit drops the presetId (scenario byte becomes 255). */
  function touch(): void {
    setDirty(true)
  }

  function addCatalogEntry(catalogId: string): void {
    const cat = catalogById.get(catalogId)
    if (!cat) return
    touch()
    const taken = new Set(entries.map((e) => e.name))
    const name = sanitizeName(catalogId, taken)
    const earlier = entries.map((e) => e.name)
    const args: EditorArg[] = cat.constructorParams.map((p) => ({
      kind: p.kind,
      label: p.label,
      value:
        p.default ??
        (p.kind === 'contractAddress'
          ? (earlier[0] ?? '')
          : p.kind === 'bool'
            ? 'false'
            : ''),
    }))
    setEntries((prev) => [...prev, { key: nextKey(), source: 'catalog', name, catalogId, args }])
    if (cat.defaultHint) {
      const kind = cat.defaultHint.kind
      setHints((prev) =>
        prev.some((h) => h.contractName === name && h.kind === kind)
          ? prev
          : [...prev, { key: nextKey(), kind, contractName: name }],
      )
    }
  }

  function addCustomEntry(): void {
    setCustomError(null)
    try {
      const parsed = parseForgeArtifact(customJson)
      const taken = new Set(entries.map((e) => e.name))
      const name = customName.trim() || sanitizeName('Custom', taken)
      if (!MANIFEST_NAME_RE.test(name)) {
        throw new Error(`name '${name}' must match ${String(MANIFEST_NAME_RE)}`)
      }
      if (taken.has(name)) throw new Error(`name '${name}' is already used`)
      touch()
      setEntries((prev) => [
        ...prev,
        {
          key: nextKey(),
          source: 'custom',
          name,
          creationBytecode: parsed.creationBytecode,
          abi: parsed.abi,
          byteLength: parsed.byteLength,
          args: parsed.constructorParams.map((p) => ({
            kind: p.kind,
            label: p.label,
            value: p.kind === 'bool' ? 'false' : '',
          })),
        },
      ])
      setCustomFormOpen(false)
      setCustomName('')
      setCustomJson('')
    } catch (e) {
      setCustomError((e as Error).message)
    }
  }

  function removeEntry(key: string): void {
    touch()
    const entry = entries.find((e) => e.key === key)
    setEntries((prev) => prev.filter((e) => e.key !== key))
    if (entry) setHints((prev) => prev.filter((h) => h.contractName !== entry.name))
  }

  function moveEntry(key: string, dir: -1 | 1): void {
    touch()
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const a = next[i]!
      next[i] = next[j]!
      next[j] = a
      return next
    })
  }

  function renameEntry(key: string, name: string): void {
    touch()
    const old = entries.find((e) => e.key === key)?.name
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, name } : e)))
    if (old !== undefined && old !== name) {
      // Keep hints and backrefs pointing at the renamed entry.
      setHints((prev) => prev.map((h) => (h.contractName === old ? { ...h, contractName: name } : h)))
      setEntries((prev) =>
        prev.map((e) => ({
          ...e,
          args: e.args.map((a) =>
            a.kind === 'contractAddress' && a.value === old ? { ...a, value: name } : a,
          ),
        })),
      )
    }
  }

  function setArg(entryKey: string, argIdx: number, value: string): void {
    touch()
    setEntries((prev) =>
      prev.map((e) =>
        e.key === entryKey
          ? { ...e, args: e.args.map((a, i) => (i === argIdx ? { ...a, value } : a)) }
          : e,
      ),
    )
  }

  function setHintKind(key: string, kind: AttributionHintEntry['kind']): void {
    touch()
    setHints((prev) => prev.map((x) => (x.key === key ? { ...x, kind } : x)))
  }

  function setHintContract(key: string, contractName: string): void {
    touch()
    setHints((prev) => prev.map((x) => (x.key === key ? { ...x, contractName } : x)))
  }

  function removeHint(key: string): void {
    touch()
    setHints((prev) => prev.filter((x) => x.key !== key))
  }

  function addHint(): void {
    touch()
    setHints((prev) => [
      ...prev,
      { key: nextKey(), kind: 'wnative', contractName: entries[0]?.name ?? '' },
    ])
  }

  const programDigest = zkvmProgramDigestFromConfig(config, zkvmBackend)
  const risc0Digest = zkvmProgramDigestFromConfig(config, 'risc0')
  const ligetronDigest = zkvmProgramDigestFromConfig(config, 'ligetron')

  /** Compose + validate the draft into a ComposerValue. */
  const value: ComposerValue = useMemo(() => {
    if (!customizing) {
      const manifest = presetManifest(preset)
      return { manifest, scenarioKey: preset, error: null }
    }
    const presetId = !dirty && seededFrom ? seededFrom : undefined
    const deployments: ManifestDeployment[] = entries.map((e) =>
      e.source === 'catalog'
        ? {
            source: 'catalog',
            name: e.name,
            catalogId: e.catalogId ?? '',
            args: e.args.map(editorArgToManifestArg),
          }
        : {
            source: 'custom',
            name: e.name,
            creationBytecode: e.creationBytecode ?? '0x',
            abi: e.abi ?? [],
            args: e.args.map(editorArgToManifestArg),
          },
    )
    const manifest: RoomDeploymentManifest = {
      version: ROOM_MANIFEST_VERSION,
      ...(presetId ? { presetId } : {}),
      deployments,
      exitAttributionHints: hints.map((h) => ({ kind: h.kind, contractName: h.contractName })),
      zkvm: {
        backend: zkvmBackend,
        programDigest: zkvmBackend === 'none' ? null : programDigest,
        proving: {
          mode: ZKVM_DEFAULTS.proving.mode,
          maxLagBlocks,
          receiptGossip: ZKVM_DEFAULTS.proving.receiptGossip,
        },
        settle: settlePolicy,
      },
    }
    try {
      validateManifestShape(manifest)
      // Mirror the server's catalog/ABI-surface hint checks for early feedback.
      for (const h of manifest.exitAttributionHints) {
        const target = deployments.find((d) => d.name === h.contractName)
        if (!target) continue
        if (target.source === 'catalog') {
          const cat = catalogById.get(target.catalogId)
          if (cat && cat.defaultHint?.kind !== h.kind) {
            throw new Error(
              `hint '${h.kind}' is not supported by catalog contract '${target.catalogId}'`,
            )
          }
        } else if (!customEntrySupportsHint(target.abi, h.kind)) {
          throw new Error(
            `hint '${h.kind}' on '${target.name}': the ABI is missing the required functions`,
          )
        }
      }
      return { manifest, scenarioKey: presetId ?? 'custom', error: null }
    } catch (e) {
      return { manifest: null, scenarioKey: 'custom', error: (e as Error).message }
    }
  }, [
    customizing,
    preset,
    dirty,
    seededFrom,
    entries,
    hints,
    zkvmBackend,
    programDigest,
    maxLagBlocks,
    settlePolicy,
    catalogById,
  ])

  useEffect(() => {
    onChangeRef.current(value)
  }, [value])

  const totalCustomBytes = entries.reduce(
    (n, e) => n + (e.source === 'custom' ? (e.byteLength ?? 0) : 0),
    0,
  )
  const unattributedCustom = entries.filter(
    (e) => e.source === 'custom' && !hints.some((h) => h.contractName === e.name),
  )

  return {
    catalog,
    customizing,
    preset,
    entries,
    hints,
    seededFrom,
    dirty,
    zkvmBackend,
    maxLagBlocks,
    settlePolicy,
    customFormOpen,
    customName,
    customJson,
    customError,
    addCatalogId,
    programDigest,
    risc0Digest,
    ligetronDigest,
    entryNames: entries.map((e) => e.name),
    totalCustomBytes,
    unattributedCustom,
    value,
    setPreset,
    setCustomizing,
    setZkvmBackend,
    setMaxLagBlocks,
    setSettlePolicy,
    setCustomFormOpen,
    setCustomName,
    setCustomJson,
    setCustomError,
    setAddCatalogId,
    seedFromPreset,
    openCustomize,
    addCatalogEntry,
    addCustomEntry,
    removeEntry,
    moveEntry,
    renameEntry,
    setArg,
    setHintKind,
    setHintContract,
    removeHint,
    addHint,
  }
}
