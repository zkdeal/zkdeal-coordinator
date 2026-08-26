import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const key = `0x${'11'.repeat(32)}` as const

describe('critical L1 RPC configuration', () => {
  it('requires two independent endpoints when admission signing is enabled', () => {
    expect(() =>
      loadConfig({
        admissionKey: key,
        allowDevAdmissionKey: true,
        admissionToken: 'operator-token-abcdefghij',
        l1RpcUrls: ['http://rpc-a.example'],
      }),
    ).toThrow(/two independent RPC endpoints/)

    expect(
      loadConfig({
        admissionKey: key,
        allowDevAdmissionKey: true,
        admissionToken: 'operator-token-abcdefghij',
        l1RpcUrls: ['http://rpc-a.example', 'http://rpc-b.example'],
      }).l1RpcUrls,
    ).toHaveLength(2)
  })

  it('requires two independent endpoints for every PostgreSQL hosted process', () => {
    const hosted = {
      databaseUrl: 'postgresql://zkdeal:test@postgres:5432/zkdeal',
      apiKeyPepper: 'p'.repeat(32),
      hostingAdminToken: 'a'.repeat(32),
      allowDevStaticAdmin: true,
      objectStoreEndpoint: 'http://minio:9000',
      objectStoreBucket: 'zkdeal-hosted',
      objectStoreRegion: 'us-east-1',
      objectStoreAccessKeyId: 'zkdeal-test',
      objectStoreSecretAccessKey: 'test-secret',
    } as const

    expect(() =>
      loadConfig({
        ...hosted,
        coordinatorRole: 'standalone',
        l1RpcUrls: ['http://rpc-a.example'],
      }),
    ).toThrow(/two independent RPC endpoints/)

    expect(
      loadConfig({
        ...hosted,
        coordinatorRole: 'active',
        l1RpcUrls: ['http://rpc-a.example', 'http://rpc-b.example'],
      }).l1RpcUrls,
    ).toHaveLength(2)
  })

  it('does not count spelling variants of one endpoint as independent', () => {
    expect(() =>
      loadConfig({
        admissionKey: key,
        allowDevAdmissionKey: true,
        admissionToken: 'operator-token-abcdefghij',
        l1RpcUrls: ['HTTP://RPC-A.EXAMPLE/', 'http://rpc-a.example'],
      }),
    ).toThrow(/two independent RPC endpoints/)
  })

  it('fails closed when the capacity controller lacks its scoped provider boundary', () => {
    expect(() => loadConfig({ capacityControllerEnabled: true }))
      .toThrow(/scoped capacity provider/)

    expect(() => loadConfig({
      capacityControllerEnabled: true,
      capacityProviderUrl: 'http://capacity-provider:8080',
      capacityProviderAuthToken: 'capacity-provider-token',
    })).toThrow(/PostgreSQL hosted mode/)

    expect(() => loadConfig({
      capacityProviderPreviousAuthToken: 'previous-provider-token',
    })).toThrow(/previous capacity provider token/)
  })

  it('forbids the file-authoritative demo inside PostgreSQL hosted mode', () => {
    const prior = process.env.DEMO_ENABLED
    process.env.DEMO_ENABLED = '1'
    try {
      expect(() => loadConfig({
        databaseUrl: 'postgresql://zkdeal:test@postgres:5432/zkdeal',
        apiKeyPepper: 'p'.repeat(32),
        objectStoreEndpoint: 'http://minio:9000',
        objectStoreBucket: 'zkdeal-hosted',
        objectStoreRegion: 'us-east-1',
        objectStoreAccessKeyId: 'zkdeal-test',
        objectStoreSecretAccessKey: 'test-secret',
        l1RpcUrls: ['http://rpc-a.example', 'http://rpc-b.example'],
      })).toThrow(/DEMO_ENABLED cannot run inside PostgreSQL hosted mode/)
    } finally {
      if (prior === undefined) delete process.env.DEMO_ENABLED
      else process.env.DEMO_ENABLED = prior
    }
  })
})
