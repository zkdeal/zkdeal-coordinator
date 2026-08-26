import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { normalizedL1Endpoint, SharedL1Transport } from '../src/shared-l1-transport.js'

const block = {
  number: '0x64',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x1234',
}

interface RpcBehavior {
  chainId?: string
  block?: Partial<typeof block>
  sendError?: string
  sendHash?: string
  logs?: Array<Record<string, unknown>>
  transaction?: Record<string, unknown> | null
  receipt?: Record<string, unknown> | null
}

function rpcFetch(behavior: Record<string, RpcBehavior> = {}): typeof fetch {
  return async (input, init) => {
    const endpoint = new URL(String(input)).host
    const current = behavior[endpoint] ?? {}
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
    if (request.method === 'eth_chainId') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: current.chainId ?? '0x7a69' })
    }
    if (request.method === 'eth_sendRawTransaction') {
      return Response.json(current.sendError
        ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: current.sendError } }
        : { jsonrpc: '2.0', id: 1, result: current.sendHash })
    }
    if (request.method === 'eth_getLogs') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: current.logs ?? [] })
    }
    if (request.method === 'eth_getTransactionByHash') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: current.transaction ?? null })
    }
    if (request.method === 'eth_getTransactionReceipt') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: current.receipt ?? null })
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: { ...block, ...(current.block ?? {}) } })
  }
}

describe('SharedL1Transport', () => {
  it('preserves case-sensitive paths/query while canonicalizing scheme and host', () => {
    expect(normalizedL1Endpoint('HTTPS://RPC.EXAMPLE:443/Case/Path?Token=AbC'))
      .toBe('https://rpc.example/Case/Path?Token=AbC')
  })

  it('derives immutable evidence from two expected-chain providers', async () => {
    const transport = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337, rpcFetch(),
    )
    const agreed = await transport.agreedBlock('finalized')
    expect(agreed).toMatchObject({ chainId: 31337, number: '100', hash: block.hash })
    expect(agreed.verifiedSources).toHaveLength(2)
    expect(agreed.verifiedSources.every((source) => /^rpc-[0-9a-f]{16}$/.test(source))).toBe(true)
  })

  it('never combines the chain-id majority with facts from another chain', async () => {
    const four = new SharedL1Transport(
      [
        { url: 'http://rpc-a.example', providerId: 'a' },
        { url: 'http://rpc-b.example', providerId: 'b' },
        { url: 'http://rpc-c.example', providerId: 'c' },
        { url: 'http://rpc-d.example', providerId: 'd' },
      ],
      31337,
      rpcFetch({
        'rpc-c.example': { chainId: '0x1', block: { hash: `0x${'33'.repeat(32)}` } },
        'rpc-d.example': { chainId: '0x1', block: { hash: `0x${'33'.repeat(32)}` } },
      }),
    )
    expect((await four.agreedBlock('latest')).hash).toBe(block.hash)

    const split = new SharedL1Transport(
      [
        { url: 'http://rpc-a.example', providerId: 'a' },
        { url: 'http://rpc-c.example', providerId: 'c' },
        { url: 'http://rpc-d.example', providerId: 'd' },
      ],
      31337,
      rpcFetch({
        'rpc-c.example': { chainId: '0x1' },
        'rpc-d.example': { chainId: '0x1' },
      }),
    )
    await expect(split.agreedBlock('latest')).rejects.toThrow('two-provider agreement')
  })

  it('rejects conflicting provider quorums, including 2/2 and 3/2 splits', async () => {
    const endpoints = ['a', 'b', 'c', 'd', 'e'].map((providerId) => ({
      url: `http://rpc-${providerId}.example`, providerId,
    }))
    const otherHash = `0x${'33'.repeat(32)}` as const
    const twoTwo = new SharedL1Transport(
      endpoints.slice(0, 4), 31337,
      rpcFetch({
        'rpc-c.example': { block: { hash: otherHash } },
        'rpc-d.example': { block: { hash: otherHash } },
      }),
    )
    await expect(twoTwo.agreedBlock('latest')).rejects.toThrow('conflicting two-provider agreements')

    const threeTwo = new SharedL1Transport(
      endpoints, 31337,
      rpcFetch({
        'rpc-d.example': { block: { hash: otherHash } },
        'rpc-e.example': { block: { hash: otherHash } },
      }),
    )
    await expect(threeTwo.agreedBlock('latest')).rejects.toThrow('conflicting two-provider agreements')
  })

  it('sorts canonical logs before comparing providers', async () => {
    const first = {
      address: `0x${'aa'.repeat(20)}`,
      topics: [`0x${'01'.repeat(32)}`], data: '0x', blockNumber: '0x2',
      blockHash: `0x${'02'.repeat(32)}`, transactionHash: `0x${'03'.repeat(32)}`,
      transactionIndex: '0x0', logIndex: '0x1', removed: false,
    }
    const second = { ...first, logIndex: '0x0', transactionHash: `0x${'04'.repeat(32)}` }
    const transport = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({
        'rpc-a.example': { logs: [first, second] },
        'rpc-b.example': { logs: [second, first] },
      }),
    )
    const agreement = await transport.agreedLogs({ fromBlock: '0x2', toBlock: '0x2' })
    expect(agreement.logs.map((log) => log.logIndex)).toEqual(['0x0', '0x1'])
    expect(agreement.verifiedSources).toHaveLength(2)
  })

  it('requires EIP-1898 canonical hash binding for critical state calls', async () => {
    const observedTags: unknown[] = []
    const canonicalHash = block.hash as `0x${string}`
    const request: typeof fetch = async (input, init) => {
      const endpoint = new URL(String(input)).host
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
      if (body.method === 'eth_chainId') {
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x7a69' })
      }
      if (body.method === 'eth_call') {
        observedTags.push(body.params[1])
        if (endpoint === 'rpc-c.example') {
          return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'block is not canonical' } })
        }
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x01' })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: block })
    }
    const transport = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example', 'http://rpc-c.example'], 31337, request,
    )
    await expect(transport.agreedCall({
      to: `0x${'aa'.repeat(20)}`, data: '0x1234',
      blockTag: { blockHash: canonicalHash, requireCanonical: true },
    })).resolves.toMatchObject({ data: '0x01' })
    expect(observedTags).toEqual(Array(3).fill({ blockHash: canonicalHash, requireCanonical: true }))
    await expect(transport.agreedCall({
      to: `0x${'aa'.repeat(20)}`, data: '0x1234', blockTag: '0x64',
    } as never)).rejects.toThrow('EIP-1898')
  })

  it('computes the signed transaction hash locally and accepts already-known failover', async () => {
    const raw = '0x0102' as const
    const expected = keccak256(raw)
    const transport = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({
        'rpc-a.example': { sendHash: expected },
        'rpc-b.example': { sendError: 'already known' },
      }),
    )
    await expect(transport.broadcastRawTransaction(raw)).resolves.toBe(expected)
  })

  it('does not accept nonce-too-low without confirming the exact local transaction', async () => {
    const raw = '0x0102' as const
    const localHash = keccak256(raw)
    const transaction = {
      hash: `0x${'55'.repeat(32)}`, from: `0x${'aa'.repeat(20)}`, to: `0x${'bb'.repeat(20)}`,
      nonce: '0x1', input: '0x', value: '0x0', type: '0x2', chainId: '0x7a69',
      blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x0',
    }
    const rejected = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({
        'rpc-a.example': { sendError: 'nonce too low', transaction },
        'rpc-b.example': { sendError: 'replacement transaction underpriced' },
      }),
    )
    await expect(rejected.broadcastRawTransaction(raw)).rejects.toThrow('every L1 RPC rejected')

    const confirmed = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({
        'rpc-a.example': { sendError: 'nonce too low', transaction: { ...transaction, hash: localHash } },
        'rpc-b.example': { sendError: 'replacement transaction underpriced' },
      }),
    )
    await expect(confirmed.broadcastRawTransaction(raw)).resolves.toBe(localHash)
  })

  it('includes canonical block verification sources in transaction and receipt evidence', async () => {
    const hash = `0x${'44'.repeat(32)}` as const
    const transaction = {
      hash, from: `0x${'aa'.repeat(20)}`, to: `0x${'bb'.repeat(20)}`,
      nonce: '0x1', input: '0x1234', value: '0x0', type: '0x2', chainId: '0x7a69',
      blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x0',
    }
    const receipt = {
      transactionHash: hash, blockHash: block.hash, blockNumber: block.number,
      transactionIndex: '0x0', status: '0x1', type: '0x2',
    }
    const transport = new SharedL1Transport(
      [
        { url: 'http://rpc-a.example', providerId: 'a' },
        { url: 'http://rpc-b.example', providerId: 'b' },
        { url: 'http://rpc-c.example', providerId: 'c' },
      ],
      31337,
      rpcFetch({
        'rpc-a.example': { transaction, receipt, block: { hash: `0x${'33'.repeat(32)}` } },
        'rpc-b.example': { transaction, receipt },
        'rpc-c.example': {
          transaction: { ...transaction, value: '0x2' },
          receipt: { ...receipt, status: '0x0' },
        },
      }),
    )
    expect((await transport.agreedTransaction(hash)).verifiedSources).toHaveLength(3)
    expect((await transport.agreedReceipt(hash)).verifiedSources).toHaveLength(3)
  })

  it('distinguishes agreed receipt absence from provider split or outage', async () => {
    const hash = `0x${'66'.repeat(32)}` as const
    const absent = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337, rpcFetch(),
    )
    await expect(absent.agreedReceiptOptional(hash)).resolves.toMatchObject({
      transaction: null,
      verifiedSources: expect.any(Array),
    })

    const receipt = {
      transactionHash: hash, blockHash: block.hash, blockNumber: block.number,
      transactionIndex: '0x0', status: '0x1', type: '0x3',
    }
    const split = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({ 'rpc-a.example': { receipt } }),
    )
    await expect(split.agreedReceiptOptional(hash)).rejects.toThrow('two-provider agreement')
  })

  it('rejects disagreement and duplicate provider identities', async () => {
    const disagree = new SharedL1Transport(
      ['http://rpc-a.example', 'http://rpc-b.example'], 31337,
      rpcFetch({ 'rpc-b.example': { block: { hash: `0x${'33'.repeat(32)}` } } }),
    )
    await expect(disagree.agreedBlock('finalized')).rejects.toThrow('two-provider agreement')
    expect(() => new SharedL1Transport(
      [
        { url: 'http://rpc-a.example/One', providerId: 'same-provider' },
        { url: 'http://rpc-a.example/Two', providerId: 'same-provider' },
      ],
      31337,
      rpcFetch(),
    )).toThrow('independent provider identities')
  })
})
