import { concatHex, encodeAbiParameters, keccak256, toBytes, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AuthorizationMode } from './demo-control.js'

export const DEFAULT_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex

export const roleKey = (role: string) => keccak256(toBytes(`zkdeal/kurtosis/role/${role}`)) as Hex

export const ROLE_KEYS = {
  governance: roleKey('governance'),
  nodeAdmin: roleKey('node-admin'),
  templateAdmin: roleKey('template-admin'),
  controller: roleKey('pool-controller'),
  guardian: roleKey('guardian'),
  service: roleKey('node-service'),
  treasury: roleKey('treasury'),
  customer: roleKey('customer'),
} as const

export function approverKey(index: number): Hex {
  return `0x${BigInt(index + 1).toString(16).padStart(64, '0')}` as Hex
}

export function approverTree(count: number): {
  accounts: ReturnType<typeof privateKeyToAccount>[]
  proofs: Hex[][]
} {
  const capacity = 2 ** Math.ceil(Math.log2(Math.max(2, count)))
  const accounts = Array.from({ length: count }, (_, index) => privateKeyToAccount(approverKey(index)))
  const levels: Hex[][] = [
    Array.from({ length: capacity }, (_, index) =>
      index < count
        ? keccak256(
            encodeAbiParameters(
              [{ type: 'uint64' }, { type: 'address' }, { type: 'uint64' }],
              [BigInt(index), accounts[index]!.address, 1n],
            ),
          )
        : zeroHash,
    ),
  ]
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!
    levels.push(
      Array.from({ length: previous.length / 2 }, (_, index) =>
        keccak256(concatHex([previous[index * 2]!, previous[index * 2 + 1]!])),
      ),
    )
  }
  const proofs = accounts.map((_, memberIndex) => {
    let index = memberIndex
    const proof: Hex[] = []
    for (const level of levels.slice(0, -1)) {
      proof.push(level[index ^ 1]!)
      index >>= 1
    }
    return proof
  })
  return { accounts, proofs }
}

export interface BatchApprovalInput {
  authorizationMode: AuthorizationMode
  activeApprovers: number
  /** Resolved per approver, exactly as the inline signing loop did. */
  chainId: () => Promise<number>
  verifyingContract: Hex
  roomId: bigint
  batchIndex: bigint
  journalHash: Hex
  approverRoot: Hex
  approverEpoch: bigint
  deadline: bigint
}

/**
 * EIP-712 `BatchApproval` signatures for the demo's deterministic approver set.
 * A validity-only room carries no approvals at all.
 */
export async function batchApprovals(input: BatchApprovalInput) {
  const approvers = approverTree(input.activeApprovers)
  return input.authorizationMode === 'VALIDITY_ONLY'
    ? []
    : await Promise.all(
        approvers.accounts.map(async (account, index) => ({
          index: BigInt(index),
          joinedEpoch: 1n,
          nonce: 0n,
          deadline: input.deadline,
          member: account.address,
          proof: approvers.proofs[index]!,
          signature: await account.signTypedData({
            domain: {
              name: 'ZkdealRoom',
              version: '6',
              chainId: await input.chainId(),
              verifyingContract: input.verifyingContract,
            },
            types: {
              BatchApproval: [
                { name: 'roomId', type: 'uint64' },
                { name: 'batchIndex', type: 'uint64' },
                { name: 'journalHash', type: 'bytes32' },
                { name: 'approverRoot', type: 'bytes32' },
                { name: 'approverEpoch', type: 'uint64' },
                { name: 'nonce', type: 'uint64' },
                { name: 'deadline', type: 'uint64' },
              ],
            },
            primaryType: 'BatchApproval',
            message: {
              roomId: input.roomId,
              batchIndex: input.batchIndex,
              journalHash: input.journalHash,
              approverRoot: input.approverRoot,
              approverEpoch: input.approverEpoch,
              nonce: 0n,
              deadline: input.deadline,
            },
          }),
        })),
      )
}
