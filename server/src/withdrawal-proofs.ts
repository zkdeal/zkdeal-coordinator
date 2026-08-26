import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Hex,
} from 'viem'

export const MAX_WITHDRAWALS_PER_EPOCH = 32_768
export const MAX_WITHDRAWAL_PROOF_DEPTH = 15
export const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
export const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as `0x${string}`

export interface WithdrawalValue {
  index: string
  approverEpoch: string
  recipient: `0x${string}`
  asset: `0x${string}`
  amount: string
}

export interface WithdrawalWitness {
  schemaVersion: 1
  deploymentDomain: Hex
  roomId: string
  outboxEpoch: string
  capacity: number
  withdrawals: WithdrawalValue[]
}

export interface WithdrawalProofRecord extends WithdrawalValue {
  leafHash: Hex
  positionalProof: Hex[]
}

export interface BuiltWithdrawalEpoch {
  witness: WithdrawalWitness
  root: Hex
  records: WithdrawalProofRecord[]
}

export const WITHDRAWAL_CLAIM_ABI = [{
  type: 'function',
  name: 'claimWithdrawal',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'roomId', type: 'uint64' },
    { name: 'outboxEpoch', type: 'uint64' },
    {
      name: 'withdrawal',
      type: 'tuple',
      components: [
        { name: 'index', type: 'uint64' },
        { name: 'approverEpoch', type: 'uint64' },
        { name: 'recipient', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    { name: 'proof', type: 'bytes32[]' },
  ],
  outputs: [],
}, {
  type: 'function',
  name: 'verifyWithdrawalProof',
  stateMutability: 'view',
  inputs: [
    { name: 'roomId', type: 'uint64' },
    { name: 'outboxEpoch', type: 'uint64' },
    {
      name: 'withdrawal',
      type: 'tuple',
      components: [
        { name: 'index', type: 'uint64' },
        { name: 'approverEpoch', type: 'uint64' },
        { name: 'recipient', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    { name: 'proof', type: 'bytes32[]' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}, {
  type: 'function',
  name: 'isWithdrawalClaimed',
  stateMutability: 'view',
  inputs: [
    { name: 'roomId', type: 'uint64' },
    { name: 'outboxEpoch', type: 'uint64' },
    { name: 'index', type: 'uint64' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const

function decimal(value: unknown, field: string, bits: 64 | 256): string {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${field} must be an unsigned canonical decimal`)
  }
  const parsed = BigInt(text)
  if (parsed >= 1n << BigInt(bits)) throw new Error(`${field} exceeds uint${bits}`)
  return parsed.toString()
}

function hex(value: unknown, bytes: number, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${field} must be ${bytes}-byte hexadecimal data`)
  }
  return text as Hex
}

export function normalizeWithdrawal(value: WithdrawalValue): WithdrawalValue {
  const withdrawal: WithdrawalValue = {
    index: decimal(value.index, 'withdrawal.index', 64),
    approverEpoch: decimal(value.approverEpoch, 'withdrawal.approverEpoch', 64),
    recipient: hex(value.recipient, 20, 'withdrawal.recipient') as `0x${string}`,
    asset: hex(value.asset, 20, 'withdrawal.asset') as `0x${string}`,
    amount: decimal(value.amount, 'withdrawal.amount', 256),
  }
  if (withdrawal.recipient === ZERO_ADDRESS) throw new Error('withdrawal.recipient cannot be zero')
  if (withdrawal.amount === '0') throw new Error('withdrawal.amount must be greater than zero')
  return withdrawal
}

export function normalizeWithdrawalWitness(value: WithdrawalWitness): WithdrawalWitness {
  if (value.schemaVersion !== 1) throw new Error('withdrawal witness schemaVersion must be 1')
  const capacity = Number(value.capacity)
  if (
    !Number.isSafeInteger(capacity)
    || capacity < 1
    || capacity > MAX_WITHDRAWALS_PER_EPOCH
    || (capacity & (capacity - 1)) !== 0
  ) throw new Error('withdrawal capacity must be a power of two from 1 through 32768')
  if (!Array.isArray(value.withdrawals)) throw new Error('withdrawal witness requires an array')
  const withdrawals = value.withdrawals.map(normalizeWithdrawal)
  let previous = -1n
  for (const withdrawal of withdrawals) {
    const index = BigInt(withdrawal.index)
    if (index <= previous) throw new Error('withdrawals must be strictly ordered by index')
    if (index >= BigInt(capacity)) throw new Error('withdrawal index is outside the declared capacity')
    previous = index
  }
  return {
    schemaVersion: 1,
    deploymentDomain: hex(value.deploymentDomain, 32, 'deploymentDomain'),
    roomId: decimal(value.roomId, 'roomId', 64),
    outboxEpoch: decimal(value.outboxEpoch, 'outboxEpoch', 64),
    capacity,
    withdrawals,
  }
}

/** Exact Solidity/Rust leaf: keccak256(abi.encode(domain,room,epoch,index,approverEpoch,recipient,asset,amount)). */
export function withdrawalLeaf(
  deploymentDomain: Hex,
  roomId: string,
  outboxEpoch: string,
  value: WithdrawalValue,
): Hex {
  const withdrawal = normalizeWithdrawal(value)
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' },
      { type: 'uint64' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
    ],
    [
      hex(deploymentDomain, 32, 'deploymentDomain'), BigInt(decimal(roomId, 'roomId', 64)),
      BigInt(decimal(outboxEpoch, 'outboxEpoch', 64)), BigInt(withdrawal.index),
      BigInt(withdrawal.approverEpoch), withdrawal.recipient, withdrawal.asset,
      BigInt(withdrawal.amount),
    ],
  ))
}

function parent(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([left, right]))
}

export function verifyWithdrawalProof(root: Hex, leaf: Hex, index: string, proof: readonly Hex[]): boolean {
  if (proof.length > MAX_WITHDRAWAL_PROOF_DEPTH) return false
  let value = hex(leaf, 32, 'withdrawal leaf')
  let position = BigInt(decimal(index, 'withdrawal index', 64))
  for (const siblingValue of proof) {
    const sibling = hex(siblingValue, 32, 'withdrawal proof sibling')
    value = (position & 1n) === 0n ? parent(value, sibling) : parent(sibling, value)
    position >>= 1n
  }
  return value === hex(root, 32, 'withdrawal root')
}

/** Build every positional path from the complete proof witness and verify every produced path locally. */
export function buildWithdrawalEpoch(value: WithdrawalWitness): BuiltWithdrawalEpoch {
  const witness = normalizeWithdrawalWitness(value)
  if (witness.withdrawals.length === 0) return { witness, root: ZERO_BYTES32, records: [] }
  const leaves = Array.from({ length: witness.capacity }, () => ZERO_BYTES32)
  for (const withdrawal of witness.withdrawals) {
    leaves[Number(withdrawal.index)] = withdrawalLeaf(
      witness.deploymentDomain, witness.roomId, witness.outboxEpoch, withdrawal,
    )
  }
  const levels: Hex[][] = [leaves]
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!
    const next: Hex[] = []
    for (let index = 0; index < current.length; index += 2) {
      next.push(parent(current[index]!, current[index + 1]!))
    }
    levels.push(next)
  }
  const root = levels.at(-1)![0]!
  const records = witness.withdrawals.map((withdrawal): WithdrawalProofRecord => {
    const proof: Hex[] = []
    let position = Number(withdrawal.index)
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      proof.push(levels[depth]![position ^ 1]!)
      position = Math.floor(position / 2)
    }
    const leafHash = leaves[Number(withdrawal.index)]!
    if (!verifyWithdrawalProof(root, leafHash, withdrawal.index, proof)) {
      throw new Error('constructed withdrawal proof failed local verification')
    }
    return { ...withdrawal, leafHash, positionalProof: proof }
  })
  return { witness, root, records }
}

export function encodeWithdrawalClaim(input: {
  roomId: string
  outboxEpoch: string
  withdrawal: WithdrawalValue
  proof: readonly Hex[]
}): Hex {
  const withdrawal = normalizeWithdrawal(input.withdrawal)
  if (input.proof.length > MAX_WITHDRAWAL_PROOF_DEPTH) throw new Error('withdrawal proof is too deep')
  return encodeFunctionData({
    abi: WITHDRAWAL_CLAIM_ABI,
    functionName: 'claimWithdrawal',
    args: [
      BigInt(decimal(input.roomId, 'roomId', 64)),
      BigInt(decimal(input.outboxEpoch, 'outboxEpoch', 64)),
      {
        index: BigInt(withdrawal.index), approverEpoch: BigInt(withdrawal.approverEpoch),
        recipient: withdrawal.recipient, asset: withdrawal.asset, amount: BigInt(withdrawal.amount),
      },
      input.proof.map((item) => hex(item, 32, 'withdrawal proof sibling')),
    ],
  })
}
