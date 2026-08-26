/**
 * Client-side room-manifest helpers for the create-room composer and the
 * joiner review screen:
 *
 * - Preset expansion mirroring server/src/manifest.ts presetToManifest -
 *   the SAME deployments/args/hints as contracts/scenarios.json, so a
 *   client-expanded preset digests identically to the server expansion.
 * - Catalog parsing from GET /artifacts/contracts.json (top-level `catalog`,
 *   entries keyed by catalogId: { name, artifact, constructorParams, defaultHint? }).
 * - zkVM program-digest lookup from GET /config (tolerates absence - a
 *   backend without a published digest is not selectable).
 * - Forge-artifact parsing for custom deployments (abi + bytecode.object).
 */

import {
  MANIFEST_LIMITS,
  ROOM_MANIFEST_VERSION,
  defaultZkvmPolicy,
  type AttributionHintEntry,
  type CatalogDeploymentEntry,
  type Hex,
  type ManifestArg,
  type RoomDeploymentManifest,
  type ZkvmBackendId,
  type ZkvmPolicy,
} from '@zkdeal/protocol'
import type { ContractsManifest, CoordinatorConfig } from '@zkdeal/room-client'

export type PresetId = 'generic' | 'erc4626' | 'dvp'

/** Logical-name rule shared with @zkdeal/protocol validateManifestShape. */
export const MANIFEST_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

const HEX_RE = /^0x[0-9a-fA-F]*$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

/* ------------------------------------------------------------------ */
/* Preset expansion (mirror of server presetToManifest)                */
/* ------------------------------------------------------------------ */

function wnativeEntry(): CatalogDeploymentEntry {
  return { source: 'catalog', name: 'WNative', catalogId: 'WNative', args: [] }
}

function dealTokenEntry(): CatalogDeploymentEntry {
  return {
    source: 'catalog',
    name: 'DealToken',
    catalogId: 'DealToken',
    args: [
      { kind: 'string', value: 'Deal Token' },
      { kind: 'string', value: 'DEAL' },
      { kind: 'uint256', value: '1000000000000000000000' },
      { kind: 'genesisDeployer' },
    ],
  }
}

function vaultDemoEntry(): CatalogDeploymentEntry {
  return {
    source: 'catalog',
    name: 'VaultDemo',
    catalogId: 'VaultDemo',
    args: [{ kind: 'contractAddress', name: 'WNative' }],
  }
}

function dvpSettlementEntry(): CatalogDeploymentEntry {
  return { source: 'catalog', name: 'DvPSettlement', catalogId: 'DvPSettlement', args: [] }
}

/** Expand a preset into its canned catalog-sourced manifest (server mirror). */
export function presetManifest(
  preset: PresetId,
  zkvm: ZkvmPolicy = defaultZkvmPolicy(),
): RoomDeploymentManifest {
  switch (preset) {
    case 'generic':
      return {
        version: ROOM_MANIFEST_VERSION,
        presetId: 'generic',
        deployments: [wnativeEntry(), dealTokenEntry()],
        exitAttributionHints: [{ kind: 'wnative', contractName: 'WNative' }],
        zkvm,
      }
    case 'erc4626':
      return {
        version: ROOM_MANIFEST_VERSION,
        presetId: 'erc4626',
        deployments: [wnativeEntry(), vaultDemoEntry()],
        exitAttributionHints: [
          { kind: 'wnative', contractName: 'WNative' },
          { kind: 'erc4626', contractName: 'VaultDemo' },
        ],
        zkvm,
      }
    case 'dvp':
      return {
        version: ROOM_MANIFEST_VERSION,
        presetId: 'dvp',
        deployments: [wnativeEntry(), dealTokenEntry(), dvpSettlementEntry()],
        exitAttributionHints: [
          { kind: 'wnative', contractName: 'WNative' },
          { kind: 'dvpEscrow', contractName: 'DvPSettlement' },
        ],
        zkvm,
      }
  }
}

export const PRESET_CARDS: Array<{ id: PresetId; title: string; blurb: string }> = [
  {
    id: 'erc4626',
    title: 'ERC-4626 vault demo',
    blurb: 'WNative + VaultDemo - wrap, deposit, accrue, withdraw.',
  },
  {
    id: 'dvp',
    title: 'Delivery vs payment',
    blurb: 'WNative + DealToken + DvP escrow for atomic swaps.',
  },
  {
    id: 'generic',
    title: 'Generic channel',
    blurb: 'WNative + DealToken - plain transfers and calls.',
  },
]

/* ------------------------------------------------------------------ */
/* Catalog parsing (contracts.json top-level `catalog`)                */
/* ------------------------------------------------------------------ */

export interface CatalogParamSpec {
  label: string
  kind:
    | 'string'
    | 'uint256'
    | 'address'
    | 'bool'
    | 'bytes32'
    | 'genesisDeployer'
    | 'contractAddress'
  default?: string
}

export interface CatalogUiEntry {
  catalogId: string
  name: string
  artifact: string
  constructorParams: CatalogParamSpec[]
  defaultHint?: { kind: AttributionHintEntry['kind'] }
}

const PARAM_KINDS: ReadonlySet<string> = new Set([
  'string',
  'uint256',
  'address',
  'bool',
  'bytes32',
  'genesisDeployer',
  'contractAddress',
])

const HINT_KINDS: ReadonlySet<string> = new Set(['wnative', 'erc4626', 'dvpEscrow'])

/** Defensive parse of the `catalog` key served in /artifacts/contracts.json. */
export function parseCatalog(cm: ContractsManifest | null | undefined): CatalogUiEntry[] {
  const raw = cm?.catalog
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: CatalogUiEntry[] = []
  for (const [catalogId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const params: CatalogParamSpec[] = []
    let paramsOk = true
    const rawParams = Array.isArray(v.constructorParams) ? v.constructorParams : []
    for (const p of rawParams) {
      if (!p || typeof p !== 'object') {
        paramsOk = false
        break
      }
      const spec = p as Record<string, unknown>
      const kind = String(spec.kind ?? '')
      if (!PARAM_KINDS.has(kind)) {
        paramsOk = false
        break
      }
      params.push({
        label: String(spec.label ?? kind),
        kind: kind as CatalogParamSpec['kind'],
        ...(typeof spec.default === 'string' ? { default: spec.default } : {}),
      })
    }
    if (!paramsOk) continue
    const hintKind =
      v.defaultHint && typeof v.defaultHint === 'object'
        ? String((v.defaultHint as Record<string, unknown>).kind ?? '')
        : ''
    out.push({
      catalogId,
      name: String(v.name ?? catalogId),
      artifact: String(v.artifact ?? ''),
      constructorParams: params,
      ...(HINT_KINDS.has(hintKind)
        ? { defaultHint: { kind: hintKind as AttributionHintEntry['kind'] } }
        : {}),
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* zkVM program digests from /config                                   */
/* ------------------------------------------------------------------ */

/**
 * Tolerant lookup of a zkVM program digest published via GET /config.
 * Accepted shapes (current server publishes none - every accessor is
 * defensive): config.zkvm[backend].programDigest, config.zkvm[backend].imageId,
 * config.zkvm.programDigests[backend], config[`${backend}ProgramDigest`].
 */
export function zkvmProgramDigestFromConfig(
  config: CoordinatorConfig | null | undefined,
  backend: ZkvmBackendId,
): Hex | null {
  if (!config || backend === 'none') return null
  const candidates: unknown[] = []
  const zkvm = (config as Record<string, unknown>).zkvm
  if (zkvm && typeof zkvm === 'object') {
    const z = zkvm as Record<string, unknown>
    const perBackend = z[backend]
    if (perBackend && typeof perBackend === 'object') {
      const pb = perBackend as Record<string, unknown>
      candidates.push(pb.programDigest, pb.imageId, pb.digest)
    } else {
      candidates.push(perBackend)
    }
    const digests = z.programDigests
    if (digests && typeof digests === 'object') {
      candidates.push((digests as Record<string, unknown>)[backend])
    }
  }
  candidates.push((config as Record<string, unknown>)[`${backend}ProgramDigest`])
  for (const c of candidates) {
    if (typeof c === 'string' && BYTES32_RE.test(c)) return c.toLowerCase()
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Forge artifact parsing (custom deployments)                         */
/* ------------------------------------------------------------------ */

export interface ParsedForgeArtifact {
  abi: unknown[]
  creationBytecode: Hex
  byteLength: number
  /** Constructor inputs derived from the ABI, mapped to manifest arg kinds. */
  constructorParams: CatalogParamSpec[]
}

/**
 * Extract abi + creation bytecode from a pasted/uploaded forge artifact JSON
 * ({ abi, bytecode: { object } | string }). Throws with a human-readable
 * message on any problem; size caps mirror MANIFEST_LIMITS.
 */
export function parseForgeArtifact(jsonText: string): ParsedForgeArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('not valid JSON - paste the full forge artifact (out/<C>.sol/<C>.json)')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('artifact must be a JSON object')
  const obj = parsed as { abi?: unknown; bytecode?: { object?: unknown } | string }
  const abi = obj.abi
  if (!Array.isArray(abi)) throw new Error('artifact is missing an `abi` array')
  const rawBytecode =
    typeof obj.bytecode === 'string'
      ? obj.bytecode
      : typeof obj.bytecode?.object === 'string'
        ? obj.bytecode.object
        : null
  if (!rawBytecode) throw new Error('artifact is missing `bytecode.object`')
  const creation = (rawBytecode.startsWith('0x') ? rawBytecode : `0x${rawBytecode}`) as Hex
  if (!HEX_RE.test(creation) || creation.length % 2 !== 0) {
    throw new Error('creation bytecode is not valid hex (unlinked libraries?)')
  }
  const byteLength = (creation.length - 2) / 2
  if (byteLength === 0) throw new Error('creation bytecode is empty')
  if (byteLength > MANIFEST_LIMITS.maxCustomBytecodeBytes) {
    throw new Error(
      `creation bytecode ${byteLength} bytes exceeds the ${MANIFEST_LIMITS.maxCustomBytecodeBytes}-byte cap (EIP-3860)`,
    )
  }
  const abiBytes = new TextEncoder().encode(JSON.stringify(abi)).length
  if (abiBytes > MANIFEST_LIMITS.maxAbiJsonBytes) {
    throw new Error(`ABI JSON ${abiBytes} bytes exceeds the ${MANIFEST_LIMITS.maxAbiJsonBytes}-byte cap`)
  }
  return { abi, creationBytecode: creation, byteLength, constructorParams: constructorParamsFromAbi(abi) }
}

/**
 * Derive composer inputs from a custom contract's ABI constructor. Solidity
 * types map onto manifest arg kinds; address params additionally accept the
 * genesis deployer or an earlier deployment in the UI. Unsupported types throw.
 */
export function constructorParamsFromAbi(abi: unknown[]): CatalogParamSpec[] {
  const ctor = abi.find(
    (e): e is { type: string; inputs?: unknown } =>
      !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'constructor',
  )
  if (!ctor) return []
  const inputs = Array.isArray(ctor.inputs) ? ctor.inputs : []
  const params: CatalogParamSpec[] = []
  for (const [i, input] of inputs.entries()) {
    const inp = (input ?? {}) as { name?: unknown; type?: unknown }
    const solType = String(inp.type ?? '')
    const label = String(inp.name ?? '') || `arg${i}`
    const kind =
      solType === 'string'
        ? 'string'
        : solType === 'uint256'
          ? 'uint256'
          : solType === 'address'
            ? 'address'
            : solType === 'bool'
              ? 'bool'
              : solType === 'bytes32'
                ? 'bytes32'
                : null
    if (!kind) {
      throw new Error(
        `constructor param '${label}' has type '${solType}' - manifests support string, uint256, address, bool, bytes32`,
      )
    }
    params.push({ label, kind })
  }
  return params
}

/* ------------------------------------------------------------------ */
/* Attribution-hint ABI surface (mirror of server HINT_ABI_SURFACE)    */
/* ------------------------------------------------------------------ */

const HINT_ABI_SURFACE: Record<
  AttributionHintEntry['kind'],
  Array<{ name: string; inputs: string[] }>
> = {
  wnative: [{ name: 'balanceOf', inputs: ['address'] }],
  erc4626: [
    { name: 'balanceOf', inputs: ['address'] },
    { name: 'convertToAssets', inputs: ['uint256'] },
  ],
  dvpEscrow: [{ name: 'escrowedGiveOf', inputs: ['address'] }],
}

function abiHasFunction(abi: unknown[], name: string, inputs: string[]): boolean {
  return abi.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const f = entry as { type?: unknown; name?: unknown; inputs?: unknown }
    if (f.type !== 'function' || f.name !== name) return false
    const ins = Array.isArray(f.inputs) ? f.inputs : []
    if (ins.length !== inputs.length) return false
    return ins.every((p, i) => {
      if (!p || typeof p !== 'object') return false
      return (p as { type?: unknown }).type === inputs[i]
    })
  })
}

/** Server-mirror: can this custom ABI honor the given attribution hint kind? */
export function customEntrySupportsHint(
  abi: unknown[],
  kind: AttributionHintEntry['kind'],
): boolean {
  return HINT_ABI_SURFACE[kind].every((fn) => abiHasFunction(abi, fn.name, fn.inputs))
}

/* ------------------------------------------------------------------ */
/* Misc shared helpers                                                 */
/* ------------------------------------------------------------------ */

/** Human label for a manifest constructor arg (review screen + composer). */
export function describeArg(a: ManifestArg): string {
  switch (a.kind) {
    case 'genesisDeployer':
      return 'genesis deployer'
    case 'contractAddress':
      return `→ ${a.name}`
    case 'bool':
      return a.value ? 'true' : 'false'
    default:
      return a.value
  }
}

/** Scenario byte key for a composed manifest: preset key or 'custom' (255). */
export function scenarioKeyForManifest(
  m: RoomDeploymentManifest,
): PresetId | 'custom' {
  return m.presetId ?? 'custom'
}
