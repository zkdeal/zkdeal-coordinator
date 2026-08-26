import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { Web3SignerAdmissionSigner } from '../src/admission-signer.js'
import type { AdmissionTypedData } from '../src/admission.js'

const primary = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const wrong = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const data: AdmissionTypedData = {
  domain: {
    name: 'ZkdealRoom', version: '6', chainId: 31337,
    verifyingContract: `0x${'aa'.repeat(20)}`,
  },
  types: {
    AdmissionReceipt: [
      { name: 'roomId', type: 'uint64' },
      { name: 'admissionId', type: 'uint64' },
      { name: 'transactionHash', type: 'bytes32' },
      { name: 'depositInboxId', type: 'uint64' },
      { name: 'depositContentHash', type: 'bytes32' },
      { name: 'deadlineBlock', type: 'uint64' },
      { name: 'maximumBatchIndex', type: 'uint64' },
      { name: 'bondEpoch', type: 'uint64' },
      { name: 'admissionFee', type: 'uint256' },
    ],
  },
  primaryType: 'AdmissionReceipt',
  message: {
    roomId: 7n, admissionId: 1n, transactionHash: `0x${'01'.repeat(32)}`,
    depositInboxId: 0n, depositContentHash: `0x${'00'.repeat(32)}`,
    deadlineBlock: 100n, maximumBatchIndex: 3n, bondEpoch: 1n, admissionFee: 5n,
  },
}

describe('Web3SignerAdmissionSigner', () => {
  it('uses only scoped typed-data methods and supports bounded auth-token overlap', async () => {
    const methods: string[] = []
    const tokens: string[] = []
    const request: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string }
      methods.push(body.method)
      const token = String((init?.headers as Record<string, string>).authorization)
      tokens.push(token)
      if (token.endsWith('new-auth-token-00000001')) {
        return Response.json({ error: 'not active yet' }, { status: 401 })
      }
      if (body.method === 'eth_accounts') {
        return Response.json({ jsonrpc: '2.0', id: 1, result: [primary.address] })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: await primary.signTypedData(data) })
    }
    const signer = new Web3SignerAdmissionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'new-auth-token-00000001', previousAuthToken: 'old-auth-token-00000001', request,
    })
    await signer.assertReady()
    await expect(signer.signTypedData(data)).resolves.toMatch(/^0x[0-9a-f]{130}$/)
    expect(new Set(methods)).toEqual(new Set(['eth_accounts', 'eth_signTypedData_v4']))
    expect(tokens).toContain('Bearer new-auth-token-00000001')
    expect(tokens).toContain('Bearer old-auth-token-00000001')
  })

  it('rejects a valid signature made by the wrong remote key', async () => {
    const signer = new Web3SignerAdmissionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'scoped-auth-token-00000001',
      request: async () => Response.json({
        jsonrpc: '2.0', id: 1, result: await wrong.signTypedData(data),
      }),
    })
    await expect(signer.signTypedData(data)).rejects.toThrow('wrong key')
  })

  it('fails closed when the signer is unavailable', async () => {
    const signer = new Web3SignerAdmissionSigner({
      url: 'https://signer.example/rpc', expectedAddress: primary.address,
      authToken: 'scoped-auth-token-00000001',
      request: async () => new Response('unavailable', { status: 503 }),
    })
    await expect(signer.assertReady()).rejects.toThrow('HTTP 503')
  })
})
