import { randomUUID } from 'node:crypto'
import { keccak256, toBytes } from 'viem'
import { DEMO_PRESETS } from './demo-presets.js'
import type {
  DemoContractArtifact,
  DemoFailure,
  DemoStateSelection,
  DemoTemplate,
  DemoTemplateRequest,
} from './demo-types.js'

export function now(): string {
  return new Date().toISOString()
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function cleanHex(value: unknown, bytes: number | null, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} must be even-length hexadecimal bytes`)
  }
  if (bytes !== null && value.length !== 2 + bytes * 2) {
    throw new Error(`${label} must contain exactly ${bytes} bytes`)
  }
  return value.toLowerCase()
}

export function positiveInteger(value: unknown, fallback: number, label: string): number {
  const found = value ?? fallback
  if (!Number.isSafeInteger(found) || Number(found) <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return Number(found)
}

export function safeFailure(error: unknown): DemoFailure {
  const raw = error instanceof Error ? error.message : 'The operation failed without a readable reason.'
  return {
    explanation: raw
      .replace(/\b0x[0-9a-fA-F]{40,}\b/g, (value) => `${value.slice(0, 6)}…${value.slice(-4)}`)
      .replace(/https?:\/\/\S+/g, '[private service]'),
    effect: 'No unverified room state was accepted or submitted as canonical.',
    recovery: 'Correct the highlighted input or restore the unavailable service, then retry the operation.',
  }
}

function artifactBytecode(value: DemoContractArtifact['deployedBytecode']): string | null {
  if (typeof value === 'string') return cleanHex(value, null, 'deployed bytecode')
  if (value && typeof value.object === 'string') {
    return cleanHex(value.object, null, 'deployed bytecode')
  }
  return null
}

export function validateTemplateRequest(input: DemoTemplateRequest): Omit<DemoTemplate, 'id' | 'phase' | 'createdAt' | 'updatedAt'> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < 3 || name.length > 80) throw new Error('template name must contain 3 to 80 characters')
  const preset = input.presetId ? DEMO_PRESETS.find((item) => item.id === input.presetId) : null
  let source: DemoTemplate['source']
  let runtimeCode: string | null = null
  let selectedState: DemoStateSelection[]
  let allowedSelectors: string[]
  if (preset) {
    source = 'preset'
    selectedState = preset.initialStorage.map((item) => ({ ...item }))
    allowedSelectors = [...preset.allowedSelectors]
  } else if (input.contractMode === 'artifact') {
    if (!input.artifact || !Array.isArray(input.artifact.abi)) {
      throw new Error('a compiled artifact with an ABI is required')
    }
    runtimeCode = input.runtimeCode
      ? cleanHex(input.runtimeCode, null, 'runtime code')
      : artifactBytecode(input.artifact.deployedBytecode)
    if (!runtimeCode || runtimeCode === '0x') {
      throw new Error('the compiled artifact must include deployed runtime bytecode')
    }
    if ((runtimeCode.length - 2) / 2 > 24_576) {
      throw new Error('runtime bytecode exceeds the Ethereum contract-size limit')
    }
    source = 'artifact'
    if (!input.artifact.bytecode) {
      throw new Error('the compiled artifact must include creation bytecode')
    }
    selectedState = input.selectedState ?? []
    allowedSelectors = input.artifact.abi
      .filter((row): row is { type: string; name: string; inputs?: Array<{ type: string }> } => {
        return Boolean(row && typeof row === 'object' && (row as { type?: string }).type === 'function')
      })
      .map((row) => {
        const signature = `${row.name}(${(row.inputs ?? []).map((item) => item.type).join(',')})`
        return keccak256(toBytes(signature)).slice(0, 10)
      })
      .slice(0, 64)
    if (allowedSelectors.length === 0) allowedSelectors = ['0x00000000']
  } else if (input.contractMode === 'attached') {
    cleanHex(input.attachedAddress, 20, 'attached address')
    if (!input.artifact || !Array.isArray(input.artifact.abi)) {
      throw new Error('an attached contract requires its ABI artifact')
    }
    source = 'attached'
    selectedState = input.selectedState ?? []
    allowedSelectors = input.artifact.abi
      .filter((row): row is { type: string; name: string; inputs?: Array<{ type: string }> } => {
        return Boolean(row && typeof row === 'object' && (row as { type?: string }).type === 'function')
      })
      .map((row) => {
        const signature = `${row.name}(${(row.inputs ?? []).map((item) => item.type).join(',')})`
        return keccak256(toBytes(signature)).slice(0, 10)
      })
      .slice(0, 64)
    if (allowedSelectors.length === 0) allowedSelectors = ['0x00000000']
  } else {
    throw new Error('select a preset, compiled artifact, or attached contract')
  }
  if (selectedState.length > 512) throw new Error('selected state exceeds the 512-variable demo limit')
  selectedState = selectedState.map((item, index) => {
    if (!item || typeof item.label !== 'string' || item.label.trim() === '') {
      throw new Error(`state variable ${index + 1} requires a label`)
    }
    if (!['INITIAL_WITNESS', 'ROOM_LOCAL', 'L1_MIRROR', 'EXCLUDED'].includes(item.mode)) {
      throw new Error(`state variable ${index + 1} has an unsupported mode`)
    }
    return {
      label: item.label.trim(),
      slot: String(item.slot),
      value: String(item.value),
      mode: item.mode,
    }
  })
  const authorizationMode = input.authorizationMode ?? preset?.authorizationMode ?? 'VALIDITY_ONLY'
  const activeApprovers =
    authorizationMode === 'VALIDITY_ONLY'
      ? 0
      : positiveInteger(input.activeApprovers, preset?.activeApprovers || 1, 'active approvers')
  if (activeApprovers > 256) throw new Error('active approvers exceed the protocol limit of 256')
  const participantCapacity = positiveInteger(
    input.participantCapacity,
    preset?.participantCapacity ?? 128,
    'participant capacity',
  )
  if (participantCapacity < 128 || participantCapacity > 32_768 || (participantCapacity & (participantCapacity - 1)) !== 0) {
    throw new Error('participant capacity must be a power of two from 128 through 32,768')
  }
  return {
    name,
    presetId: preset?.id ?? null,
    source,
    authorizationMode,
    participantCapacity,
    activeApprovers,
    selectedState,
    allowedSelectors,
    runtimeCode,
    artifact: source === 'artifact' || source === 'attached' ? input.artifact : undefined,
    constructorArgs: source === 'artifact' ? (input.constructorArgs ?? []) : undefined,
    attachedAddress: source === 'attached' ? input.attachedAddress?.toLowerCase() : undefined,
  }
}
