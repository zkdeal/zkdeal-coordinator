import { concatHex, keccak256, stringToHex, type Hex } from 'viem'

const ADDRESS=/^0x[0-9a-f]{40}$/
const BYTES32=/^0x[0-9a-f]{64}$/
const SELECTOR=/^0x[0-9a-f]{8}$/

function object(value: unknown,label: string): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string,unknown>
}

function exactKeys(value: Record<string,unknown>,keys: readonly string[],label: string): void {
  const actual=Object.keys(value).sort()
  const expected=[...keys].sort()
  if (actual.length!==expected.length || actual.some((key,index) => key!==expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`)
  }
}

function unsigned(value: unknown,bits: number,label: string): bigint {
  let next: bigint
  try {
    if (typeof value==='number' && Number.isSafeInteger(value)) next=BigInt(value)
    else if (typeof value==='string' && /^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)) next=BigInt(value)
    else throw new Error('shape')
  } catch { throw new Error(`${label} must be a canonical unsigned integer`) }
  if (next<0n || next>=(1n<<BigInt(bits))) throw new Error(`${label} exceeds uint${bits}`)
  return next
}

function safeNumber(value: unknown,bits: number,label: string): number {
  const next=unsigned(value,bits,label)
  if (next>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the JSON-safe integer range`)
  return Number(next)
}

function fixed(value: unknown,expression: RegExp,label: string): Hex {
  const next=String(value ?? '').toLowerCase()
  if (!expression.test(next)) throw new Error(`${label} is malformed`)
  return next as Hex
}

function bool(value: unknown,label: string): boolean {
  if (typeof value!=='boolean') throw new Error(`${label} must be boolean`)
  return value
}

function list(value: unknown,label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function hexUint(value: bigint,bytes: number): Hex {
  return `0x${value.toString(16).padStart(bytes*2,'0')}` as Hex
}

export interface CanonicalExecutionPolicyV5 extends Record<string,unknown> {
  state_commitment: number
  max_blocks_per_batch: number
  max_transactions_per_block: number
  max_gas_per_block: number
  max_memory_bytes: number
  allow_contract_creation: boolean
  allow_self_destruct: boolean
  code: Array<{ address: Hex; runtime_code_hash: Hex }>
  calls: Array<{ caller: Hex; target: Hex; selectors: Hex[]; kinds: number[] }>
  storage: Array<{ contract: Hex; slot_prefix: Hex; prefix_bits: number; writable: boolean }>
  imports: Array<{
    adapter_id: Hex; adapter_version: Hex; source: Hex; source_key: Hex;
    room_contract: Hex; room_slot: Hex
  }>
  participant_registry: null | {
    contract: Hex; root_slot: Hex; epoch_slot: Hex; count_slot: Hex; capacity_slot: Hex
  }
  /** Optional room-local exit-queue binding. Absent (or null) legacy policies
   *  canonicalize WITHOUT this key so their hashes are byte-identical. */
  exit?: {
    queue_contract: Hex; count_slot: Hex; records_base_slot: Hex;
    assets: Array<{ asset: Hex; kind: number; token: Hex; balance_slot: Hex }>;
    fallback_recipient: Hex
  }
}

/** Strict JSON normalization for the Rust `ExecutionPolicyV5` wire shape. */
export function canonicalExecutionPolicyV5(value: unknown): CanonicalExecutionPolicyV5 {
  const policy=object(value,'policy')
  const baseKeys=[
    'state_commitment','max_blocks_per_batch','max_transactions_per_block',
    'max_gas_per_block','max_memory_bytes','allow_contract_creation','allow_self_destruct',
    'code','calls','storage','imports','participant_registry',
  ] as const
  // `exit` is the one OPTIONAL policy key: absent and null both mean "no exit
  // binding" and normalize to an omitted key, preserving every legacy hash.
  exactKeys(policy,'exit' in policy ? [...baseKeys,'exit'] : baseKeys,'policy')
  const code=list(policy.code,'policy.code').map((item,index) => {
    const row=object(item,`policy.code[${index}]`)
    exactKeys(row,['address','runtime_code_hash'],`policy.code[${index}]`)
    return {
      address:fixed(row.address,ADDRESS,`policy.code[${index}].address`),
      runtime_code_hash:fixed(row.runtime_code_hash,BYTES32,`policy.code[${index}].runtime_code_hash`),
    }
  })
  const calls=list(policy.calls,'policy.calls').map((item,index) => {
    const row=object(item,`policy.calls[${index}]`)
    exactKeys(row,['caller','target','selectors','kinds'],`policy.calls[${index}]`)
    const selectors=list(row.selectors,`policy.calls[${index}].selectors`).map((selector,selectorIndex) =>
      fixed(selector,SELECTOR,`policy.calls[${index}].selectors[${selectorIndex}]`))
    const kinds=list(row.kinds,`policy.calls[${index}].kinds`).map((kind,kindIndex) => {
      const next=safeNumber(kind,8,`policy.calls[${index}].kinds[${kindIndex}]`)
      if (next>2) throw new Error(`policy.calls[${index}].kinds[${kindIndex}] is unsupported`)
      return next
    })
    return {
      caller:fixed(row.caller,ADDRESS,`policy.calls[${index}].caller`),
      target:fixed(row.target,ADDRESS,`policy.calls[${index}].target`),selectors,kinds,
    }
  })
  const storage=list(policy.storage,'policy.storage').map((item,index) => {
    const row=object(item,`policy.storage[${index}]`)
    exactKeys(row,['contract','slot_prefix','prefix_bits','writable'],`policy.storage[${index}]`)
    const prefixBits=safeNumber(row.prefix_bits,16,`policy.storage[${index}].prefix_bits`)
    if (prefixBits>256) throw new Error(`policy.storage[${index}].prefix_bits exceeds 256`)
    return {
      contract:fixed(row.contract,ADDRESS,`policy.storage[${index}].contract`),
      slot_prefix:hexUint(unsigned(row.slot_prefix,256,`policy.storage[${index}].slot_prefix`),32),
      prefix_bits:prefixBits,writable:bool(row.writable,`policy.storage[${index}].writable`),
    }
  })
  const imports=list(policy.imports,'policy.imports').map((item,index) => {
    const row=object(item,`policy.imports[${index}]`)
    exactKeys(row,[
      'adapter_id','adapter_version','source','source_key','room_contract','room_slot',
    ],`policy.imports[${index}]`)
    return {
      adapter_id:fixed(row.adapter_id,BYTES32,`policy.imports[${index}].adapter_id`),
      adapter_version:fixed(row.adapter_version,BYTES32,`policy.imports[${index}].adapter_version`),
      source:fixed(row.source,ADDRESS,`policy.imports[${index}].source`),
      source_key:hexUint(unsigned(row.source_key,256,`policy.imports[${index}].source_key`),32),
      room_contract:fixed(row.room_contract,ADDRESS,`policy.imports[${index}].room_contract`),
      room_slot:hexUint(unsigned(row.room_slot,256,`policy.imports[${index}].room_slot`),32),
    }
  })
  let participantRegistry: CanonicalExecutionPolicyV5['participant_registry']=null
  if (policy.participant_registry!==null) {
    const row=object(policy.participant_registry,'policy.participant_registry')
    exactKeys(row,['contract','root_slot','epoch_slot','count_slot','capacity_slot'],'policy.participant_registry')
    participantRegistry={
      contract:fixed(row.contract,ADDRESS,'policy.participant_registry.contract'),
      root_slot:hexUint(unsigned(row.root_slot,256,'policy.participant_registry.root_slot'),32),
      epoch_slot:hexUint(unsigned(row.epoch_slot,256,'policy.participant_registry.epoch_slot'),32),
      count_slot:hexUint(unsigned(row.count_slot,256,'policy.participant_registry.count_slot'),32),
      capacity_slot:hexUint(unsigned(row.capacity_slot,256,'policy.participant_registry.capacity_slot'),32),
    }
  }
  let exit: CanonicalExecutionPolicyV5['exit']
  if (policy.exit!==undefined && policy.exit!==null) {
    const row=object(policy.exit,'policy.exit')
    exactKeys(row,[
      'queue_contract','count_slot','records_base_slot','assets','fallback_recipient',
    ],'policy.exit')
    const assets=list(row.assets,'policy.exit.assets').map((item,index) => {
      const asset=object(item,`policy.exit.assets[${index}]`)
      exactKeys(asset,['asset','kind','token','balance_slot'],`policy.exit.assets[${index}]`)
      return {
        asset:fixed(asset.asset,ADDRESS,`policy.exit.assets[${index}].asset`),
        kind:safeNumber(asset.kind,8,`policy.exit.assets[${index}].kind`),
        token:fixed(asset.token,ADDRESS,`policy.exit.assets[${index}].token`),
        balance_slot:hexUint(unsigned(asset.balance_slot,256,`policy.exit.assets[${index}].balance_slot`),32),
      }
    })
    exit={
      queue_contract:fixed(row.queue_contract,ADDRESS,'policy.exit.queue_contract'),
      count_slot:hexUint(unsigned(row.count_slot,256,'policy.exit.count_slot'),32),
      records_base_slot:hexUint(unsigned(row.records_base_slot,256,'policy.exit.records_base_slot'),32),
      assets,
      fallback_recipient:fixed(row.fallback_recipient,ADDRESS,'policy.exit.fallback_recipient'),
    }
  }
  return {
    state_commitment:safeNumber(policy.state_commitment,8,'policy.state_commitment'),
    max_blocks_per_batch:safeNumber(policy.max_blocks_per_batch,64,'policy.max_blocks_per_batch'),
    max_transactions_per_block:safeNumber(policy.max_transactions_per_block,64,'policy.max_transactions_per_block'),
    max_gas_per_block:safeNumber(policy.max_gas_per_block,64,'policy.max_gas_per_block'),
    max_memory_bytes:safeNumber(policy.max_memory_bytes,64,'policy.max_memory_bytes'),
    allow_contract_creation:bool(policy.allow_contract_creation,'policy.allow_contract_creation'),
    allow_self_destruct:bool(policy.allow_self_destruct,'policy.allow_self_destruct'),
    code,calls,storage,imports,participant_registry:participantRegistry,
    ...(exit ? { exit } : {}),
  }
}

/** Byte-for-byte counterpart of Rust `execution_policy_hash_v5`. */
export function executionPolicyHashV5(policy: CanonicalExecutionPolicyV5): Hex {
  const chunks: Hex[]=[
    stringToHex('zkdeal/execution-policy/v5'),hexUint(BigInt(policy.state_commitment),1),
    hexUint(BigInt(policy.max_blocks_per_batch),8),
    hexUint(BigInt(policy.max_transactions_per_block),8),
    hexUint(BigInt(policy.max_gas_per_block),8),hexUint(BigInt(policy.max_memory_bytes),8),
    hexUint(policy.allow_contract_creation ? 1n : 0n,1),
    hexUint(policy.allow_self_destruct ? 1n : 0n,1),hexUint(BigInt(policy.code.length),8),
  ]
  for (const item of policy.code) chunks.push(item.address,item.runtime_code_hash)
  chunks.push(hexUint(BigInt(policy.calls.length),8))
  for (const item of policy.calls) {
    chunks.push(item.caller,item.target,hexUint(BigInt(item.selectors.length),8),...item.selectors)
    chunks.push(hexUint(BigInt(item.kinds.length),8),...item.kinds.map((kind) => hexUint(BigInt(kind),1)))
  }
  chunks.push(hexUint(BigInt(policy.storage.length),8))
  for (const item of policy.storage) {
    chunks.push(item.contract,item.slot_prefix,hexUint(BigInt(item.prefix_bits),2),hexUint(item.writable ? 1n : 0n,1))
  }
  chunks.push(hexUint(BigInt(policy.imports.length),8))
  for (const item of policy.imports) {
    chunks.push(item.adapter_id,item.adapter_version,item.source,item.source_key,item.room_contract,item.room_slot)
  }
  if (policy.participant_registry) {
    chunks.push(hexUint(1n,1),policy.participant_registry.contract,policy.participant_registry.root_slot,
      policy.participant_registry.epoch_slot,policy.participant_registry.count_slot,
      policy.participant_registry.capacity_slot)
  } else chunks.push(hexUint(0n,1))
  // Optional exit tail. A missing binding appends NOTHING (not a zero byte):
  // every pre-exit policy hash is preserved byte-for-byte, and a present
  // binding starts with 0x01 so the two encodings stay injective.
  if (policy.exit) {
    chunks.push(hexUint(1n,1),policy.exit.queue_contract,policy.exit.count_slot,
      policy.exit.records_base_slot,hexUint(BigInt(policy.exit.assets.length),8))
    for (const item of policy.exit.assets) {
      chunks.push(item.asset,hexUint(BigInt(item.kind),1),item.token,item.balance_slot)
    }
    chunks.push(policy.exit.fallback_recipient)
  }
  return keccak256(concatHex(chunks))
}

export function liabilitiesHashV5(values: readonly Record<string,unknown>[]): Hex {
  const words: Hex[]=[hexUint(32n,32),hexUint(BigInt(values.length),32)]
  for (const [index,value] of values.entries()) {
    words.push(
      hexUint(unsigned(value.asset,160,`liabilities[${index}].asset`),32),
      hexUint(unsigned(value.pending,256,`liabilities[${index}].pending`),32),
      hexUint(unsigned(value.controlled,256,`liabilities[${index}].controlled`),32),
      hexUint(unsigned(value.claimable,256,`liabilities[${index}].claimable`),32),
      hexUint(unsigned(value.paid,256,`liabilities[${index}].paid`),32),
    )
  }
  return keccak256(concatHex(words))
}
