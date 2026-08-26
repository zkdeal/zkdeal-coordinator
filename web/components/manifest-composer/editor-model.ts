/**
 * Editor model for the manifest composer: the draft shapes the UI edits and
 * the pure conversions between them and a RoomDeploymentManifest.
 *
 * Split out of `components/manifest-composer.tsx`. No React, no JSX - the
 * composer's rendering and state live alongside it (see `use-manifest-editor`
 * and the panel components).
 */

import {
  defaultZkvmPolicy,
  type AttributionHintEntry,
  type Hex,
  type ManifestArg,
  type RoomDeploymentManifest,
} from '@zkdeal/protocol'
import type { CatalogParamSpec, CatalogUiEntry, PresetId } from '@/lib/manifest-presets'

/** Protocol zkVM defaults; never re-typed here (see the panel state below). */
export const ZKVM_DEFAULTS = defaultZkvmPolicy()

export interface ComposerValue {
  /** Valid manifest ready to send, or null while the draft is invalid. */
  manifest: RoomDeploymentManifest | null
  /** L1 scenario byte key: preset id when unmodified, else 'custom' (255). */
  scenarioKey: PresetId | 'custom'
  /** First validation error of the current draft (inline display). */
  error: string | null
}

export interface EditorArg {
  kind: CatalogParamSpec['kind']
  label: string
  value: string
}

export interface EditorEntry {
  key: string
  source: 'catalog' | 'custom'
  name: string
  catalogId?: string
  creationBytecode?: Hex
  abi?: unknown[]
  byteLength?: number
  args: EditorArg[]
}

export interface EditorHint {
  key: string
  kind: AttributionHintEntry['kind']
  contractName: string
}

let keySeq = 0
export const nextKey = () => `k${++keySeq}`

export function argsFromManifest(args: ManifestArg[], specs?: CatalogParamSpec[]): EditorArg[] {
  return args.map((a, i) => {
    const spec = specs?.[i]
    const kind = (spec?.kind ?? a.kind) as CatalogParamSpec['kind']
    let value = ''
    if (a.kind === 'contractAddress') value = a.name
    else if (a.kind === 'bool') value = a.value ? 'true' : 'false'
    else if (a.kind !== 'genesisDeployer') value = a.value
    return { kind, label: spec?.label ?? a.kind, value }
  })
}

export function entriesFromManifest(
  m: RoomDeploymentManifest,
  catalog: CatalogUiEntry[],
): EditorEntry[] {
  return m.deployments.map((d) => {
    if (d.source === 'catalog') {
      const cat = catalog.find((c) => c.catalogId === d.catalogId)
      return {
        key: nextKey(),
        source: 'catalog' as const,
        name: d.name,
        catalogId: d.catalogId,
        args: argsFromManifest(d.args, cat?.constructorParams),
      }
    }
    return {
      key: nextKey(),
      source: 'custom' as const,
      name: d.name,
      creationBytecode: d.creationBytecode,
      abi: d.abi,
      byteLength: (d.creationBytecode.length - 2) / 2,
      args: argsFromManifest(d.args),
    }
  })
}

export function hintsFromManifest(m: RoomDeploymentManifest): EditorHint[] {
  return m.exitAttributionHints.map((h) => ({
    key: nextKey(),
    kind: h.kind,
    contractName: h.contractName,
  }))
}

export function editorArgToManifestArg(a: EditorArg): ManifestArg {
  switch (a.kind) {
    case 'genesisDeployer':
      return { kind: 'genesisDeployer' }
    case 'contractAddress':
      return { kind: 'contractAddress', name: a.value }
    case 'bool':
      return { kind: 'bool', value: a.value === 'true' }
    case 'address':
      return { kind: 'address', value: a.value.trim() }
    case 'bytes32':
      return { kind: 'bytes32', value: a.value.trim() }
    case 'uint256':
      return { kind: 'uint256', value: a.value.trim() }
    case 'string':
      return { kind: 'string', value: a.value }
  }
}

export function sanitizeName(base: string, taken: ReadonlySet<string>): string {
  let s = base.replace(/[^A-Za-z0-9_]/g, '').slice(0, 28)
  if (!/^[A-Za-z]/.test(s)) s = `C${s}`
  if (!taken.has(s)) return s
  for (let i = 2; ; i++) {
    const candidate = `${s}${i}`
    if (!taken.has(candidate)) return candidate
  }
}

export const HINT_KIND_LABEL: Record<AttributionHintEntry['kind'], string> = {
  wnative: 'wnative (balanceOf)',
  erc4626: 'erc4626 (shares → assets)',
  dvpEscrow: 'dvpEscrow (give legs)',
}
