import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlPool, SqlResult } from '../src/postgres-hosted-store.js'
import {
  CanonicalParentMissingError,
  HOSTED_SCHEMA_SQL,
  HOSTED_SCHEMA_VERSION,
  HostedPromotionError,
  PostgresHostedStore,
  outboxRetentionClass,
  planCanonicalIngestion,
  verifyReplicationPromotion,
} from '../src/postgres-hosted-store.js'

type QueryHandler = (sql: string, params: readonly unknown[]) => SqlResult | Promise<SqlResult>

class FakeClient implements SqlClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = []
  released = false

  constructor(private readonly handler: QueryHandler) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.calls.push({ sql, params })
    return await this.handler(sql, params) as SqlResult<Row>
  }

  release(): void {
    this.released = true
  }
}

class FakePool implements SqlPool {
  constructor(readonly client: FakeClient) {}
  query<Row = Record<string, unknown>>(): Promise<SqlResult<Row>> {
    throw new Error('unexpected pool query')
  }
  async connect(): Promise<SqlClient> {
    return this.client
  }
  async end(): Promise<void> {}
}

const fence = {
  leaseName: 'coordinator-writer',
  holderId: 'writer-a',
  token: 7n,
  expiresAt: '2030-01-01T00:00:00.000Z',
}

function block(number: number, hash: string, parentHash: string) {
  return {
    chainId: 1,
    number: String(number),
    hash: hash as `0x${string}`,
    parentHash: parentHash as `0x${string}`,
    observedAt: '2026-08-21T00:00:00.000Z',
  }
}

describe('PostgresHostedStore safety invariants', () => {
  it('keeps the first coordinator lease at fencing token one', async () => {
    const client = new FakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
      if (sql.includes('INSERT INTO coordinator_leases')) return { rows: [], rowCount: 1 }
      if (sql.includes('expires_at <= clock_timestamp() AS expired')) {
        return { rows: [{ holder_id: 'writer-a', fence_token: '1', expired: false }], rowCount: 1 }
      }
      if (sql.includes('UPDATE coordinator_leases')) {
        return { rows: [{ expires_at: '2030-01-01T00:00:00.000Z' }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))

    const acquired = await store.acquireLease('coordinator-writer', 'writer-a', 15_000)

    expect(acquired?.token).toBe(1n)
    expect(client.calls.some((call) => call.sql === 'ROLLBACK')).toBe(false)
  })

  it('fails promotion closed for missing, stale, or lagging standby replay evidence', () => {
    const baseline = {
      acceptingWrites: true,
      schemaVersion: HOSTED_SCHEMA_VERSION,
      expectedSchemaVersion: HOSTED_SCHEMA_VERSION,
      targetLsn: '16/B374D848',
      replayLsn: '16/B374D848',
      checkpointRecordedAt: '2026-08-21T12:00:00.000Z',
      checkedAt: '2026-08-21T12:00:05.000Z',
      maximumCheckpointAgeMs: 30_000,
      previousHolderId: 'primary-a',
      previousFenceToken: '7',
    }
    expect(verifyReplicationPromotion(baseline)).toMatchObject({
      targetLsn: '16/B374D848', replayLsn: '16/B374D848', checkpointAgeMs: 5_000,
    })
    for (const [drift, code] of [
      [{ replayLsn: null }, 'replay-position-missing'],
      [{ replayLsn: '16/B374D847' }, 'replay-behind'],
      [{ checkedAt: '2026-08-21T12:01:00.000Z' }, 'checkpoint-stale'],
      [{ acceptingWrites: false }, 'database-read-only'],
      [{ schemaVersion: HOSTED_SCHEMA_VERSION - 1 }, 'schema-mismatch'],
    ] as const) {
      try {
        verifyReplicationPromotion({ ...baseline, ...drift })
        throw new Error('promotion policy unexpectedly accepted adversarial evidence')
      } catch (error) {
        expect(error).toBeInstanceOf(HostedPromotionError)
        expect((error as HostedPromotionError).code).toBe(code)
      }
    }
  })

  it('checks replay and freshness in the same transaction as the fencing-token transfer', async () => {
    const client = new FakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('FROM coordinator_leases') && sql.includes('expired')) {
        return { rows: [{ holder_id: 'primary-a', fence_token: '7', expired: true }], rowCount: 1 }
      }
      if (sql.includes('FROM hosted_primary_wal_checkpoints') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          primary_holder_id: 'primary-a', primary_fence_token: '7',
          target_lsn: '16/B374D848', recorded_at: '2026-08-21T12:00:00.000Z',
        }], rowCount: 1 }
      }
      if (sql.includes('pg_last_wal_replay_lsn')) {
        return { rows: [{
          accepting_writes: true, schema_version: HOSTED_SCHEMA_VERSION,
          replay_lsn: '16/B374D900', checked_at: '2026-08-21T12:00:05.000Z',
        }], rowCount: 1 }
      }
      if (sql.includes('UPDATE coordinator_leases SET')) {
        return { rows: [{ expires_at: '2026-08-21T12:00:20.000Z' }], rowCount: 1 }
      }
      if (sql.includes('DELETE FROM hosted_worker_leases')) return { rows: [], rowCount: 2 }
      if (sql.includes('UPDATE hosted_primary_wal_checkpoints SET')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))

    const promoted = await store.acquireLeaseForPromotion(
      'coordinator-writer', 'standby-b', 15_000, 30_000,
    )

    expect(promoted).toMatchObject({
      fence: { holderId: 'standby-b', token: 8n },
      replication: { targetLsn: '16/B374D848', replayLsn: '16/B374D900' },
    })
    const replayGate = client.calls.findIndex((call) => call.sql.includes('pg_last_wal_replay_lsn'))
    const fenceTransfer = client.calls.findIndex((call) => call.sql.includes('UPDATE coordinator_leases SET'))
    expect(replayGate).toBeGreaterThan(-1)
    expect(fenceTransfer).toBeGreaterThan(replayGate)
    expect(client.calls.at(-1)?.sql).toBe('COMMIT')
  })

  it('rolls back promotion without touching the fence when replay is behind', async () => {
    const client = new FakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
      if (sql === 'COMMIT') throw new Error('unsafe promotion must not commit')
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('FROM coordinator_leases') && sql.includes('expired')) {
        return { rows: [{ holder_id: 'primary-a', fence_token: '7', expired: true }], rowCount: 1 }
      }
      if (sql.includes('FROM hosted_primary_wal_checkpoints')) {
        return { rows: [{
          primary_holder_id: 'primary-a', primary_fence_token: '7',
          target_lsn: '16/B374D900', recorded_at: '2026-08-21T12:00:00.000Z',
        }], rowCount: 1 }
      }
      if (sql.includes('pg_last_wal_replay_lsn')) {
        return { rows: [{
          accepting_writes: true, schema_version: HOSTED_SCHEMA_VERSION,
          replay_lsn: '16/B374D899', checked_at: '2026-08-21T12:00:05.000Z',
        }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))

    await expect(store.acquireLeaseForPromotion(
      'coordinator-writer', 'standby-b', 15_000, 30_000,
    )).rejects.toMatchObject({ code: 'replay-behind' })
    expect(client.calls.some((call) => call.sql.includes('UPDATE coordinator_leases SET'))).toBe(false)
    expect(client.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('rolls back principal rotation as one transaction when overlap update loses its race', async () => {
    const client = new FakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
      if (sql === 'COMMIT') throw new Error('rotation must not commit')
      if (sql.includes('FROM coordinator_leases')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('FROM hosted_principals') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            principal_id: 'key_11111111111111111111',
            tenant_id: 'tenant-a',
            kind: 'api-key',
            roles: ['job-submit'],
            limits: {},
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO hosted_principals')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO hosted_l1_service_bindings')) return { rows: [], rowCount: 0 }
      if (sql.includes('SET overlap_until')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))

    await expect(store.rotatePrincipal(fence, 'key_11111111111111111111', 60_000))
      .rejects.toThrow('principal changed while rotating')

    const statements = client.calls.map((call) => call.sql)
    expect(statements.findIndex((sql) => sql.includes('INSERT INTO hosted_principals')))
      .toBeLessThan(statements.findIndex((sql) => sql.includes('SET overlap_until')))
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('finds the actual common ancestor of a multi-block replacement branch', () => {
    const plan = planCanonicalIngestion(
      1,
      [
        { number: '10', hash: '0xa10', parentHash: '0xa09' },
        { number: '11', hash: '0xa11', parentHash: '0xa10' },
        { number: '12', hash: '0xa12', parentHash: '0xa11' },
        { number: '13', hash: '0xa13', parentHash: '0xa12' },
      ],
      [
        block(11, '0xb11', '0xa10'),
        block(12, '0xb12', '0xb11'),
        block(13, '0xb13', '0xb12'),
      ],
    )

    expect(plan).toEqual({
      rollbackFrom: '11',
      commonAncestorNumber: '10',
      commonAncestorHash: '0xa10',
    })
  })

  it('refuses to mutate when a remote head arrives without its fork ancestry', () => {
    expect(() => planCanonicalIngestion(
      1,
      [
        { number: '10', hash: '0xa10', parentHash: '0xa09' },
        { number: '11', hash: '0xa11', parentHash: '0xa10' },
      ],
      [block(12, '0xb12', '0xb11')],
    )).toThrow(CanonicalParentMissingError)
  })

  it('rejects a candidate batch with a broken internal parent link', () => {
    expect(() => planCanonicalIngestion(
      1,
      [{ number: '10', hash: '0xa10', parentHash: '0xa09' }],
      [block(11, '0xb11', '0xa10'), block(12, '0xb12', '0xwrong')],
    )).toThrow('broken parent link')
  })

  it('pins precise fractional usage units and tiered safety retention', () => {
    expect(HOSTED_SCHEMA_SQL).toContain('quantity numeric(78,18)')
    expect(outboxRetentionClass('queue.progress.proving')).toBe('transient')
    expect(outboxRetentionClass('usage.recorded')).toBe('audit')
    expect(outboxRetentionClass('indexer.rollback')).toBe('safety')
    expect(outboxRetentionClass('admission.committed')).toBe('safety')
  })

  it('will not reap unresolved safety events or referenced fork facts', async () => {
    const client = new FakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
      if (sql.includes('FROM coordinator_leases')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('DELETE FROM hosted_outbox')) return { rows: [], rowCount: 3 }
      if (sql.includes('DELETE FROM admission_wal')) return { rows: [], rowCount: 2 }
      if (sql.includes('DELETE FROM canonical_l1_blocks')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))

    expect(await store.reap(fence)).toEqual({ outbox: 3, admissions: 2, blocks: 1 })

    const outboxDelete = client.calls.find((call) => call.sql.includes('DELETE FROM hosted_outbox'))!
    const blockDelete = client.calls.find((call) => call.sql.includes('DELETE FROM canonical_l1_blocks'))!
    expect(outboxDelete.params).toEqual([30, 365, 30])
    expect(outboxDelete.sql).toContain("retention_class = 'safety'")
    expect(outboxDelete.sql).toContain('resolved_at IS NOT NULL')
    expect(blockDelete.sql).toContain('event.resolved_at IS NULL')
    expect(blockDelete.sql).toContain("event.topic = 'indexer.rollback'")
  })

  it('rejects retention settings below the 30-day and one-year floors', async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }))
    const store = new PostgresHostedStore(new FakePool(client), 'p'.repeat(32))
    await expect(store.reap(fence, { transientRetentionDays: 29 })).rejects.toThrow('30 days')
    await expect(store.reap(fence, { auditRetentionDays: 364 })).rejects.toThrow('365 days')
    await expect(store.reap(fence, { resolvedSafetyRetentionDays: 29 })).rejects.toThrow('30 days')
    expect(client.calls).toHaveLength(0)
  })
})
