import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { S3ObjectStore } from '../src/object-store.js'

const digest = (body: string) => createHash('sha256').update(body).digest('hex')

function storeWith(response: () => Response): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: 'http://minio.example:9000',
    bucket: 'zkdeal-test',
    region: 'us-east-1',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    fetch: async () => response(),
  })
}

describe('S3 content-addressed integrity', () => {
  it('rejects corrupt bytes even when metadata claims the key digest', async () => {
    const expected = digest('expected body')
    const store = storeWith(() => new Response('corrupt body', {
      status: 200,
      headers: { 'x-amz-meta-sha256': expected, 'content-type': 'application/json' },
    }))
    await expect(store.get(`zkdeal/sha256/${expected.slice(0, 2)}/${expected}`))
      .rejects.toThrow('digest mismatch')
  })

  it('rejects a retrievable object with missing immutable metadata', async () => {
    const body = 'correct body'
    const expected = digest(body)
    const store = storeWith(() => new Response(body, { status: 200 }))
    await expect(store.get(`zkdeal/sha256/${expected.slice(0, 2)}/${expected}`))
      .rejects.toThrow('missing immutable content metadata')
  })

  it('binds metadata and bytes to the terminal digest in the object key', async () => {
    const body = 'correct body'
    const actual = digest(body)
    const wrongKey = 'f'.repeat(64)
    const store = storeWith(() => new Response(body, {
      status: 200,
      headers: { 'x-amz-meta-sha256': actual },
    }))
    await expect(store.get(`zkdeal/sha256/ff/${wrongKey}`)).rejects.toThrow('digest mismatch')
  })
})
