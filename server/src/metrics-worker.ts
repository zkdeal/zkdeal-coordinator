/**
 * Metric families for the delegated hosted worker processes: the indexer/
 * reconciler pair, the L1 publisher, the withdrawal auto-claimer, and the
 * capacity controller. Each worker's `GET /metrics` renders these through the
 * shared hand-rolled exposition in metrics.ts so every family carries a
 * detectable `# TYPE` contract. The deployment-facing machine catalog
 * (cloud-deployer-infra/observability/metric-catalog.json) must match these
 * family names, types, and bounded labels exactly.
 */

import { counter, gauge, type MetricFamily } from './metrics.js'

/** Fold an ISO timestamp into unix seconds; 0 means "never succeeded yet". */
export function unixSeconds(timestamp: string | null): number {
  return timestamp ? Math.floor(Date.parse(timestamp) / 1_000) : 0
}

export interface HostedWorkerMetricsView {
  running: boolean
  completedRuns: number
  processedBlocks: number
  reconciledRooms: number
  lastSuccessAt: string | null
}

/** The indexer/reconciler worker families; Prometheus adds the `job` label. */
export function hostedWorkerMetricFamilies(view: HostedWorkerMetricsView): MetricFamily[] {
  return [
    gauge('zkdeal_hosted_worker_up', 1),
    gauge('zkdeal_hosted_worker_running', view.running ? 1 : 0),
    counter('zkdeal_hosted_worker_completed_runs_total', view.completedRuns),
    counter('zkdeal_hosted_worker_processed_blocks_total', view.processedBlocks),
    counter('zkdeal_hosted_worker_reconciled_rooms_total', view.reconciledRooms),
    gauge('zkdeal_hosted_worker_last_success_timestamp_seconds', unixSeconds(view.lastSuccessAt)),
  ]
}

export interface PublisherWorkerMetricsView {
  processedTransactions: number
  processingErrors: number
  recoveryRequired: number
  completedRuns: number
  lastSuccessAt: string | null
}

/** The fenced L1 publisher worker families (blob plus managed operations). */
export function publisherWorkerMetricFamilies(view: PublisherWorkerMetricsView): MetricFamily[] {
  return [
    gauge('zkdeal_blob_publisher_up', 1),
    counter('zkdeal_blob_publish_processed_total', view.processedTransactions),
    counter('zkdeal_blob_publish_errors_total', view.processingErrors),
    counter('zkdeal_l1_post_finality_surprise_total', view.recoveryRequired),
    counter('zkdeal_blob_publisher_completed_runs_total', view.completedRuns),
    gauge('zkdeal_blob_publisher_last_success_timestamp_seconds', unixSeconds(view.lastSuccessAt)),
  ]
}

/** Bounded claim outcome label values; alert rules reference these exactly. */
export const WITHDRAWAL_CLAIM_STATUSES = [
  'leased', 'submitted', 'confirmed', 'alreadyClaimed', 'errors', 'recoveryRequired',
] as const
export type WithdrawalClaimStatus = (typeof WITHDRAWAL_CLAIM_STATUSES)[number]

export interface WithdrawalWorkerMetricsView {
  totals: Readonly<Record<WithdrawalClaimStatus, number>>
  runs: number
  lastSuccessAt: string | null
}

/** The sole fenced withdrawal auto-claimer families. */
export function withdrawalWorkerMetricFamilies(view: WithdrawalWorkerMetricsView): MetricFamily[] {
  return [
    gauge('zkdeal_withdrawal_worker_up', 1),
    counter('zkdeal_withdrawal_claim_operations_total', WITHDRAWAL_CLAIM_STATUSES.map((status) => ({
      labels: { status }, value: view.totals[status] ?? 0,
    }))),
    counter('zkdeal_withdrawal_worker_runs_total', view.runs),
    gauge('zkdeal_withdrawal_worker_last_success_timestamp_seconds', unixSeconds(view.lastSuccessAt)),
  ]
}

/** Bounded capacity outcome label values; alert rules reference these exactly. */
export const CAPACITY_OPERATION_STATUSES = [
  'signalsSent', 'applied', 'pending', 'retrying', 'terminal', 'deadlineRisk', 'failures',
  'nodeLifecycleApplied', 'nodeLifecyclePending', 'nodeLifecycleRetrying',
  'nodeLifecycleTerminal', 'nodeLifecycleVerified', 'nodeLifecycleRecoveryRequired',
] as const
export type CapacityOperationStatus = (typeof CAPACITY_OPERATION_STATUSES)[number]

export interface CapacityWorkerMetricsView {
  running: boolean
  runs: number
  totals: Readonly<Record<CapacityOperationStatus, number>>
  lastSuccessAt: string | null
}

/** The sole fenced capacity controller families. */
export function capacityWorkerMetricFamilies(view: CapacityWorkerMetricsView): MetricFamily[] {
  return [
    gauge('zkdeal_capacity_worker_up', 1),
    gauge('zkdeal_capacity_worker_running', view.running ? 1 : 0),
    counter('zkdeal_capacity_worker_runs_total', view.runs),
    counter('zkdeal_capacity_operations_total', CAPACITY_OPERATION_STATUSES.map((status) => ({
      labels: { status }, value: view.totals[status] ?? 0,
    }))),
    gauge('zkdeal_capacity_worker_last_success_timestamp_seconds', unixSeconds(view.lastSuccessAt)),
  ]
}
