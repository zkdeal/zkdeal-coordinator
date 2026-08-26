/**
 * The delegated worker Prometheus contracts: every family the hosted
 * indexer/reconciler, publisher, withdrawal auto-claimer, and capacity
 * controller expose must carry a `# TYPE` declaration with the exact name,
 * type, and bounded labels the deployment metric catalog
 * (cloud-deployer-infra/observability/metric-catalog.json) records. These are
 * pure rendering tests - no PostgreSQL, signer, or container is involved.
 */

import { describe, expect, it } from 'vitest'
import { renderMetrics, type MetricFamily } from '../src/metrics.js'
import {
  CAPACITY_OPERATION_STATUSES,
  WITHDRAWAL_CLAIM_STATUSES,
  capacityWorkerMetricFamilies,
  hostedWorkerMetricFamilies,
  publisherWorkerMetricFamilies,
  unixSeconds,
  withdrawalWorkerMetricFamilies,
} from '../src/metrics-worker.js'

/** name -> { type, labels } exactly as a scraper and the catalog see them. */
function contract(families: MetricFamily[]): Record<string, { type: string; labels: string[] }> {
  const seen: Record<string, { type: string; labels: string[] }> = {}
  for (const family of families) {
    expect(seen[family.name], `duplicate family ${family.name}`).toBeUndefined()
    const labels = [...new Set(family.samples.flatMap((sample) => Object.keys(sample.labels ?? {})))]
    seen[family.name] = { type: family.type, labels }
  }
  return seen
}

describe('the shared timestamp fold', () => {
  it('renders unix seconds and reports 0 before any success', () => {
    expect(unixSeconds(null)).toBe(0)
    expect(unixSeconds('2026-08-21T00:00:10.500Z')).toBe(Date.UTC(2026, 7, 21, 0, 0, 10) / 1_000)
  })
})

describe('the hosted indexer/reconciler worker families', () => {
  it('matches the catalog names, types, and label sets exactly', () => {
    const families = hostedWorkerMetricFamilies({
      running: true, completedRuns: 3, processedBlocks: 64, reconciledRooms: 5,
      lastSuccessAt: '2026-08-21T00:00:00Z',
    })
    expect(contract(families)).toEqual({
      zkdeal_hosted_worker_up: { type: 'gauge', labels: [] },
      zkdeal_hosted_worker_running: { type: 'gauge', labels: [] },
      zkdeal_hosted_worker_completed_runs_total: { type: 'counter', labels: [] },
      zkdeal_hosted_worker_processed_blocks_total: { type: 'counter', labels: [] },
      zkdeal_hosted_worker_reconciled_rooms_total: { type: 'counter', labels: [] },
      zkdeal_hosted_worker_last_success_timestamp_seconds: { type: 'gauge', labels: [] },
    })
    const body = renderMetrics(families)
    expect(body).toContain('# TYPE zkdeal_hosted_worker_up gauge')
    expect(body).toContain('# TYPE zkdeal_hosted_worker_completed_runs_total counter')
    expect(body).toContain('zkdeal_hosted_worker_running 1')
    expect(body).toContain('zkdeal_hosted_worker_processed_blocks_total 64')
    expect(body).toContain('zkdeal_hosted_worker_reconciled_rooms_total 5')
  })
})

describe('the publisher worker families', () => {
  it('matches the catalog names, types, and label sets exactly', () => {
    const families = publisherWorkerMetricFamilies({
      processedTransactions: 7, processingErrors: 2, recoveryRequired: 1,
      completedRuns: 4, lastSuccessAt: null,
    })
    expect(contract(families)).toEqual({
      zkdeal_blob_publisher_up: { type: 'gauge', labels: [] },
      zkdeal_blob_publish_processed_total: { type: 'counter', labels: [] },
      zkdeal_blob_publish_errors_total: { type: 'counter', labels: [] },
      zkdeal_l1_post_finality_surprise_total: { type: 'counter', labels: [] },
      zkdeal_blob_publisher_completed_runs_total: { type: 'counter', labels: [] },
      zkdeal_blob_publisher_last_success_timestamp_seconds: { type: 'gauge', labels: [] },
    })
    const body = renderMetrics(families)
    expect(body).toContain('# TYPE zkdeal_blob_publisher_completed_runs_total counter')
    expect(body).toContain('# TYPE zkdeal_blob_publisher_last_success_timestamp_seconds gauge')
    expect(body).toContain('zkdeal_l1_post_finality_surprise_total 1')
    expect(body).toContain('zkdeal_blob_publisher_last_success_timestamp_seconds 0')
  })
})

describe('the withdrawal auto-claimer families', () => {
  it('folds every bounded claim status the alert rules reference', () => {
    // Alert exprs use status="errors" and status="recoveryRequired" exactly.
    expect(WITHDRAWAL_CLAIM_STATUSES).toContain('errors')
    expect(WITHDRAWAL_CLAIM_STATUSES).toContain('recoveryRequired')
    const families = withdrawalWorkerMetricFamilies({
      totals: { leased: 6, submitted: 5, confirmed: 4, alreadyClaimed: 1, errors: 2, recoveryRequired: 0 },
      runs: 9, lastSuccessAt: '2026-08-21T00:00:00Z',
    })
    expect(contract(families)).toEqual({
      zkdeal_withdrawal_worker_up: { type: 'gauge', labels: [] },
      zkdeal_withdrawal_claim_operations_total: { type: 'counter', labels: ['status'] },
      zkdeal_withdrawal_worker_runs_total: { type: 'counter', labels: [] },
      zkdeal_withdrawal_worker_last_success_timestamp_seconds: { type: 'gauge', labels: [] },
    })
    const body = renderMetrics(families)
    expect(body).toContain('# TYPE zkdeal_withdrawal_claim_operations_total counter')
    expect(body).toContain('zkdeal_withdrawal_claim_operations_total{status="errors"} 2')
    expect(body).toContain('zkdeal_withdrawal_claim_operations_total{status="recoveryRequired"} 0')
    expect(body).toContain('zkdeal_withdrawal_worker_runs_total 9')
  })
})

describe('the capacity controller families', () => {
  it('folds every bounded operation status the alert rules reference', () => {
    // Alert exprs use status=~"failures|terminal" and status="deadlineRisk".
    expect(CAPACITY_OPERATION_STATUSES).toContain('failures')
    expect(CAPACITY_OPERATION_STATUSES).toContain('terminal')
    expect(CAPACITY_OPERATION_STATUSES).toContain('deadlineRisk')
    const totals = Object.fromEntries(CAPACITY_OPERATION_STATUSES.map((status) => [status, 0])) as
      Record<(typeof CAPACITY_OPERATION_STATUSES)[number], number>
    totals.deadlineRisk = 3
    const families = capacityWorkerMetricFamilies({
      running: false, runs: 11, totals, lastSuccessAt: null,
    })
    expect(contract(families)).toEqual({
      zkdeal_capacity_worker_up: { type: 'gauge', labels: [] },
      zkdeal_capacity_worker_running: { type: 'gauge', labels: [] },
      zkdeal_capacity_worker_runs_total: { type: 'counter', labels: [] },
      zkdeal_capacity_operations_total: { type: 'counter', labels: ['status'] },
      zkdeal_capacity_worker_last_success_timestamp_seconds: { type: 'gauge', labels: [] },
    })
    const body = renderMetrics(families)
    expect(body).toContain('# TYPE zkdeal_capacity_operations_total counter')
    expect(body).toContain('zkdeal_capacity_worker_running 0')
    expect(body).toContain('zkdeal_capacity_operations_total{status="deadlineRisk"} 3')
    // Bounded label values stay under the catalog's 64-value ceiling.
    expect(CAPACITY_OPERATION_STATUSES.length).toBeLessThanOrEqual(64)
  })
})
