import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerConfig } from './config.js'

export interface ContractsJson {
  roomManager: `0x${string}`
  roomManagerAbi: unknown[]
  addresses: Record<string, string>
  framing: string
}

function loadContractAbi(contractsOut: string, source: string, contract: string): unknown[] {
  const path = join(contractsOut, source, `${contract}.json`)
  if (!existsSync(path)) {
    return []
  }
  const j = JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[] }
  return j.abi
}

/**
 * Address keys published on the UNAUTHENTICATED `/artifacts/contracts.json`.
 *
 * Allow-by-default copied every string in the operator's `addresses.json` -
 * deployment tooling routinely writes RPC URLs, deployer accounts and
 * per-environment tokens into such a file, and the previous three-key denylist
 * meant every new key leaked by default. Values must additionally look like an
 * address, so a key on this list cannot smuggle a URL either.
 */
const PUBLISHED_ADDRESS_KEYS: readonly string[] = [
  'roomManager',
  'RoomManager',
  'roomPool',
  'RoomPoolManager',
  'accessToken',
  'ZkdealAccessToken',
  'groth16Verifier',
  'Groth16Verifier',
  'risc0Verifier',
  'Risc0Verifier',
  'verifierRouter',
  'VerifierRouter',
]

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function loadAddresses(cfg: ServerConfig): Record<string, string> {
  const out: Record<string, string> = {
    roomManager: cfg.roomManager,
  }
  if (existsSync(cfg.addressesPath)) {
    try {
      const j = JSON.parse(readFileSync(cfg.addressesPath, 'utf8')) as Record<string, unknown>
      for (const key of PUBLISHED_ADDRESS_KEYS) {
        const value = j[key]
        if (typeof value === 'string' && ADDRESS.test(value)) out[key] = value
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

export function buildContractsJson(cfg: ServerConfig): ContractsJson {
  return {
    roomManager: cfg.roomManager,
    roomManagerAbi: loadContractAbi(cfg.contractsOut, 'RoomManager.sol', 'RoomManager'),
    addresses: loadAddresses(cfg),
    framing:
      'pre-release receipts cover generic room-local EVM execution; claims for pinned presets remain blocked until exits/accounting are guest-derived and genesis is canonically L1-anchored',
  }
}
