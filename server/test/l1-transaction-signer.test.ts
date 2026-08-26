import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  Web3SignerL1TransactionSigner,
  type BlobTransactionToSign,
} from '../src/l1-transaction-signer.js'

const primary = privateKeyToAccount(`0x${'31'.repeat(32)}`)
const wrong = privateKeyToAccount(`0x${'32'.repeat(32)}`)
const transaction: BlobTransactionToSign = {
  chainId: 31_337,
  nonce: 4n,
  to: `0x${'ab'.repeat(20)}`,
  data: '0x1234',
  value: 5n,
  gas: 200_000n,
  maxPriorityFeePerGas: 2n,
  maxFeePerGas: 20n,
  maxFeePerBlobGas: 3n,
  blobVersionedHashes: [`0x01${'44'.repeat(31)}`],
}

async function signed(account = primary): Promise<`0x${string}`> {
  return account.signTransaction({
    type: 'eip4844',
    ...transaction,
    nonce: Number(transaction.nonce),
    accessList: [],
  } as never)
}

describe('Web3SignerL1TransactionSigner', () => {
  it('uses only transaction signing and supports bounded auth-token overlap', async () => {
    const methods: string[] = []
    const tokens: string[] = []
    const request: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string }
      methods.push(body.method)
      const token = String((init?.headers as Record<string, string>).authorization)
      tokens.push(token)
      if (token.endsWith('new-l1-auth-token-00000001')) {
        return Response.json({ error: 'not active yet' }, { status: 401 })
      }
      return Response.json({
        jsonrpc: '2.0', id: 1,
        result: body.method === 'eth_accounts' ? [primary.address] : await signed(),
      })
    }
    const signer = new Web3SignerL1TransactionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'new-l1-auth-token-00000001',
      previousAuthToken: 'old-l1-auth-token-00000001', request,
    })
    await signer.assertReady()
    await expect(signer.signEip4844(transaction)).resolves.toMatchObject({
      signedBody: expect.stringMatching(/^0x03/),
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    })
    expect(new Set(methods)).toEqual(new Set(['eth_accounts', 'eth_signTransaction']))
    expect(tokens).toContain('Bearer new-l1-auth-token-00000001')
    expect(tokens).toContain('Bearer old-l1-auth-token-00000001')
  })

  it('rejects a signed transaction made by the wrong remote key', async () => {
    const signer = new Web3SignerL1TransactionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'scoped-l1-auth-token-00000001',
      request: async () => Response.json({ jsonrpc: '2.0', id: 1, result: await signed(wrong) }),
    })
    await expect(signer.signEip4844(transaction)).rejects.toThrow('wrong key')
  })

  it('rejects a remote signer that mutates an immutable transaction field', async () => {
    const changed = await primary.signTransaction({
      type: 'eip4844', ...transaction, nonce: Number(transaction.nonce + 1n), accessList: [],
    } as never)
    const signer = new Web3SignerL1TransactionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'scoped-l1-auth-token-00000001',
      request: async () => Response.json({ jsonrpc: '2.0', id: 1, result: changed }),
    })
    await expect(signer.signEip4844(transaction)).rejects.toThrow('changed transaction nonce')
  })

  it('fails closed when the signer is unavailable', async () => {
    const signer = new Web3SignerL1TransactionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'scoped-l1-auth-token-00000001',
      request: async () => new Response('unavailable', { status: 503 }),
    })
    await expect(signer.assertReady()).rejects.toThrow('HTTP 503')
  })
})
