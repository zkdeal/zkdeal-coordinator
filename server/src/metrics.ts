/**
 * Hand-rolled Prometheus text exposition (format version 0.0.4).
 *
 * Deliberately not prom-client: the whole surface this server needs is
 * `# TYPE` lines plus samples with a handful of labels, and one more
 * dependency is not worth that. `GET /metrics` stays open the way `/health`
 * and the queue's `GET /queue/v1/status` do - it is how an orchestrator or a
 * Prometheus scraper observes readiness, and it exposes counters and gauges
 * only, never request, witness or result bytes.
 */

import type { FastifyInstance } from 'fastify'
import type { SseBatchCounters } from './sse-batcher.js'
import type { HostedRuntime,HostedRuntimeStatus } from './hosted-runtime.js'
import type { HostedMetricsSnapshot } from './postgres-hosted-store.js'
import type { L1TransportHealth } from './shared-l1-transport.js'

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export type MetricType = 'gauge' | 'counter' | 'summary' | 'histogram'

export interface MetricSample {
  /** Appended to the family name (`_sum` / `_count` for a summary). */
  suffix?: string
  labels?: Record<string, string>
  value: number
}

export interface MetricFamily {
  name: string
  type: MetricType
  samples: MetricSample[]
}

/** Machine-readable, bounded-label contract consumed by deployment alerts. */
export const HOSTED_METRIC_CATALOG=Object.freeze([
  { name:'zkdeal_l1_quorum_healthy',labels:[] },
  { name:'zkdeal_l1_rpc_endpoints',labels:['health'] },
  { name:'zkdeal_l1_reorgs_total',labels:[] },
  { name:'zkdeal_l1_finality_lag_blocks',labels:[] },
  { name:'zkdeal_l1_deadline_risk_transactions',labels:[] },
  { name:'zkdeal_l1_post_finality_surprises_total',labels:[] },
  { name:'zkdeal_indexer_head_block',labels:[] },
  { name:'zkdeal_indexer_finalized_floor_block',labels:[] },
  { name:'zkdeal_indexer_lag_blocks',labels:[] },
  { name:'zkdeal_indexer_retractions_total',labels:['reason'] },
  { name:'zkdeal_indexer_reconciliation_rooms',labels:['status'] },
  { name:'zkdeal_admission_wal_records',labels:['status'] },
  { name:'zkdeal_admission_wal_oldest_reserved_seconds',labels:[] },
  { name:'zkdeal_admission_wal_recovered_total',labels:['outcome'] },
  { name:'zkdeal_room_lifecycle',labels:['state'] },
  { name:'zkdeal_room_lifecycle_events_total',labels:['event'] },
  { name:'zkdeal_room_deadline_slack_seconds',labels:['le'] },
  { name:'zkdeal_hosted_queue_jobs',labels:['status'] },
  { name:'zkdeal_hosted_queue_wait_seconds',labels:['statistic'] },
  { name:'zkdeal_hosted_queue_attempts_total',labels:[] },
  { name:'zkdeal_hosted_queue_bytes',labels:[] },
  { name:'zkdeal_hosted_queue_gpu_leases',labels:[] },
  { name:'zkdeal_hosted_queue_fairness_virtual_finish_spread',labels:[] },
  { name:'zkdeal_hosted_queue_slack_jobs',labels:['class'] },
  { name:'zkdeal_usage_reconciliation_lag_seconds',labels:[] },
  { name:'zkdeal_postgresql_database_bytes',labels:[] },
  { name:'zkdeal_hosted_outbox_backlog',labels:[] },
  { name:'zkdeal_hosted_object_backlog',labels:[] },
  { name:'zkdeal_hosted_sse_connections',labels:[] },
  { name:'zkdeal_sponsorship_quantity',labels:['state'] },
  { name:'zkdeal_sponsorship_denials_total',labels:['reason'] },
  { name:'zkdeal_sponsorship_refunds_total',labels:[] },
  { name:'zkdeal_blob_archive_requirements',labels:['status'] },
  { name:'zkdeal_blob_publish_operations',labels:['status'] },
  { name:'zkdeal_blob_finality_blocked',labels:[] },
  { name:'zkdeal_aggregate_member_outcomes_total',labels:['outcome'] },
  { name:'zkdeal_aggregate_member_charges_total',labels:['kind'] },
] as const)

/** Escape a label VALUE per the exposition format: backslash, quote, newline. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function family(name: string, type: MetricType, value: number | MetricSample[]): MetricFamily {
  return {
    name,
    type,
    samples: typeof value === 'number' ? [{ value }] : value,
  }
}

export function gauge(name: string, value: number | MetricSample[]): MetricFamily {
  return family(name, 'gauge', value)
}

export function counter(name: string, value: number | MetricSample[]): MetricFamily {
  return family(name, 'counter', value)
}

/** The `_sum` / `_count` pair Prometheus knows as a summary (no quantiles). */
export function summary(name: string, sum: number, count: number): MetricFamily {
  return {
    name,
    type: 'summary',
    samples: [
      { suffix: '_sum', value: sum },
      { suffix: '_count', value: count },
    ],
  }
}

export function renderMetrics(families: MetricFamily[]): string {
  const lines: string[] = []
  for (const item of families) {
    lines.push(`# TYPE ${item.name} ${item.type}`)
    for (const sample of item.samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
            .join(',')}}`
        : ''
      lines.push(`${item.name}${sample.suffix ?? ''}${labels} ${sample.value}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/* ---------- the coordinator's /metrics route ---------- */

/**
 * What the demo controller publishes for `/metrics` - plain folded numbers,
 * never room, action or job payloads. `DemoController.metricsView()` is the
 * implementation.
 */
export interface DemoMetricsView {
  /** Rooms folded by their current phase. */
  roomPhases: Record<string, number>
  templates: number
  jobs: { running: number; finished: number; failed: number }
  provingSlot: { active: boolean; waiting: number }
  checkpoints: { accepted: number; failed: number }
  eventsEmitted: number
  sseSubscribers: number
  /** Wall-clock seconds spent holding the proving slot, and how often. */
  proofSeconds: { sum: number; count: number }
}

export interface MetricsRouteDeps {
  demo: { metricsView(): DemoMetricsView } | null
  /** The demo stream's shared batcher counters; absent without a demo. */
  sse?: SseBatchCounters | null
  /** PostgreSQL-backed production authority; absent in explicit standalone mode. */
  hosted?:HostedRuntime|null
}

const hostedProcessCounters={ admissionRecovered:0 }

export function recordAdmissionRecovered(count:number):void {
  if (Number.isSafeInteger(count) && count>0) hostedProcessCounters.admissionRecovered+=count
}

/** Bounded service classes for `zkdeal_deadline_risk_jobs`; matches the hosted queue taxonomy. */
export const DEADLINE_RISK_SERVICE_CLASSES=['standard','latency','batch'] as const
export type DeadlineRiskServiceClass=(typeof DEADLINE_RISK_SERVICE_CLASSES)[number]

const deadlineRiskJobs=new Map<DeadlineRiskServiceClass,number>()

/**
 * Track one in-flight job whose L1 inclusion margin dropped below the alert
 * threshold. Returns an idempotent release to invoke once the job settles,
 * retracts, or fails, so the gauge only ever counts currently-at-risk jobs.
 */
export function trackDeadlineRiskJob(serviceClass:DeadlineRiskServiceClass):() => void {
  deadlineRiskJobs.set(serviceClass,(deadlineRiskJobs.get(serviceClass) ?? 0)+1)
  let released=false
  return () => {
    if (released) return
    released=true
    deadlineRiskJobs.set(serviceClass,Math.max(0,(deadlineRiskJobs.get(serviceClass) ?? 1)-1))
  }
}

const labeled=(values:Array<{ status:string;count:number }>,status:string):number =>
  values.find((item) => item.status===status)?.count ?? 0

/** Stable, bounded-label catalog used by the coordinator and acceptance tests. */
export function hostedMetricFamilies(
  snapshot:HostedMetricsSnapshot,
  runtime:HostedRuntimeStatus,
  endpoints:L1TransportHealth[],
):MetricFamily[] {
  const healthy=endpoints.filter((endpoint) => endpoint.healthy).length
  const unhealthy=endpoints.length-healthy
  const admissionStates=['RESERVED','COMMITTED','LEASED','ACKED','CANCELLED']
  const queueStates=['QUEUED','LEASED','DONE','FAILED']
  const l1States=[
    'PREPARED','SIGNED','BROADCAST','INCLUDED','FINALIZED','FAILED','RECOVERY_REQUIRED','SUPERSEDED',
  ]
  const blobStates=['PENDING','VERIFIED','ERROR','RETRACTED']
  const aggregateKinds=['CHARGE','L1_ALLOCATION_CHARGE','REORG_CREDIT','REFUND','SLA_CREDIT']
  return [
    gauge('zkdeal_l1_quorum_healthy',runtime.l1QuorumHealthy ? 1 : 0),
    gauge('zkdeal_l1_rpc_endpoints',[
      { labels:{ health:'healthy' },value:healthy },{ labels:{ health:'unhealthy' },value:unhealthy },
    ]),
    counter('zkdeal_l1_reorgs_total',snapshot.reorgs),
    gauge('zkdeal_l1_finality_lag_blocks',snapshot.indexerLagBlocks),
    gauge('zkdeal_l1_deadline_risk_transactions',snapshot.deadlineRiskTransactions),
    counter('zkdeal_l1_post_finality_surprises_total',snapshot.postFinalitySurprises),
    gauge('zkdeal_indexer_head_block',snapshot.canonicalHeadBlock),
    gauge('zkdeal_indexer_finalized_floor_block',snapshot.canonicalFloorBlock),
    gauge('zkdeal_indexer_lag_blocks',snapshot.indexerLagBlocks),
    counter('zkdeal_indexer_retractions_total',[
      { labels:{ reason:'canonical_reorg' },value:snapshot.factRetractions },
    ]),
    gauge('zkdeal_indexer_reconciliation_rooms',[
      { labels:{ status:'reconciled' },value:labeled(snapshot.reconciliationStatuses,'reconciled') },
      { labels:{ status:'drifted' },value:labeled(snapshot.reconciliationStatuses,'drifted') },
    ]),
    gauge('zkdeal_admission_wal_records',admissionStates.map((status) => ({
      labels:{ status:status.toLowerCase() },value:labeled(snapshot.admissionStatuses,status),
    }))),
    gauge('zkdeal_admission_wal_oldest_reserved_seconds',snapshot.admissionOldestReservedSeconds),
    counter('zkdeal_admission_wal_recovered_total',[
      { labels:{ outcome:'succeeded' },value:hostedProcessCounters.admissionRecovered },
    ]),
    gauge('zkdeal_room_lifecycle',(['open','closed','unknown'] as const).map((state) => ({
      labels:{ state },value:snapshot.roomStates.find((item) => item.state===state)?.count ?? 0,
    }))),
    counter('zkdeal_room_lifecycle_events_total',snapshot.roomLifecycleEvents.map((item) => ({
      labels:{ event:item.event },value:item.count,
    }))),
    {
      name:'zkdeal_room_deadline_slack_seconds',type:'histogram',samples:[
        { suffix:'_bucket',labels:{ le:'0' },value:snapshot.trustedDeadlineBuckets.overdue },
        { suffix:'_bucket',labels:{ le:'300' },value:snapshot.trustedDeadlineBuckets.fiveMinutes },
        { suffix:'_bucket',labels:{ le:'1800' },value:snapshot.trustedDeadlineBuckets.thirtyMinutes },
        { suffix:'_bucket',labels:{ le:'+Inf' },value:snapshot.trustedDeadlineBuckets.infinite },
        { suffix:'_sum',value:snapshot.trustedDeadlineSlackSumSeconds },
        { suffix:'_count',value:snapshot.trustedDeadlineSlackCount },
      ],
    },
    gauge('zkdeal_hosted_queue_jobs',queueStates.map((status) => ({
      labels:{ status:status.toLowerCase() },value:labeled(snapshot.queueStatuses,status),
    }))),
    gauge('zkdeal_hosted_queue_wait_seconds',[
      { labels:{ statistic:'average' },value:snapshot.queueWaitAverageSeconds },
      { labels:{ statistic:'maximum' },value:snapshot.queueWaitMaximumSeconds },
    ]),
    counter('zkdeal_hosted_queue_attempts_total',snapshot.queueAttempts),
    gauge('zkdeal_hosted_queue_bytes',snapshot.queueBytes),
    gauge('zkdeal_hosted_queue_gpu_leases',snapshot.gpuLeases),
    gauge('zkdeal_hosted_queue_fairness_virtual_finish_spread',snapshot.queueFairnessSpread),
    gauge('zkdeal_hosted_queue_slack_jobs',[
      { labels:{ class:'overdue' },value:snapshot.trustedDeadlineBuckets.overdue },
      { labels:{ class:'within_5m' },value:snapshot.trustedDeadlineBuckets.fiveMinutes },
      { labels:{ class:'within_30m' },value:snapshot.trustedDeadlineBuckets.thirtyMinutes },
    ]),
    gauge('zkdeal_usage_reconciliation_lag_seconds',snapshot.usageReconciliationLagSeconds),
    gauge('zkdeal_postgresql_database_bytes',snapshot.databaseBytes),
    gauge('zkdeal_hosted_outbox_backlog',snapshot.outboxBacklog),
    gauge('zkdeal_hosted_object_backlog',snapshot.objectBacklog),
    gauge('zkdeal_hosted_sse_connections',snapshot.sseConnections),
    gauge('zkdeal_sponsorship_quantity',[
      { labels:{ state:'available' },value:snapshot.sponsorship.available },
      { labels:{ state:'reserved' },value:snapshot.sponsorship.reserved },
      { labels:{ state:'consumed' },value:snapshot.sponsorship.consumed },
    ]),
    counter('zkdeal_sponsorship_denials_total',[
      { labels:{ reason:'policy' },value:snapshot.sponsorship.denials },
    ]),
    counter('zkdeal_sponsorship_refunds_total',snapshot.sponsorship.refunds),
    gauge('zkdeal_blob_archive_requirements',blobStates.map((status) => ({
      labels:{ status:status.toLowerCase() },value:labeled(snapshot.blobRequirementStatuses,status),
    }))),
    gauge('zkdeal_blob_publish_operations',l1States.map((status) => ({
      labels:{ status:status.toLowerCase() },value:labeled(snapshot.blobPublishStatuses,status),
    }))),
    gauge('zkdeal_blob_finality_blocked',
      labeled(snapshot.blobRequirementStatuses,'PENDING')+labeled(snapshot.blobRequirementStatuses,'ERROR')),
    counter('zkdeal_aggregate_member_outcomes_total',(['applied','failed','retracted'] as const).map((outcome) => ({
      labels:{ outcome },value:snapshot.aggregateOutcomes.find((item) => item.outcome===outcome)?.count ?? 0,
    }))),
    counter('zkdeal_aggregate_member_charges_total',aggregateKinds.map((kind) => ({
      labels:{ kind:kind.toLowerCase() },value:snapshot.aggregateCharges.find((item) => item.kind===kind)?.count ?? 0,
    }))),
  ]
}

/**
 * `GET /metrics`, open like `/health`: process uptime always, the demo
 * control plane's gauges when a demo controller is mounted. Counters and
 * gauges only - never request or witness bytes.
 */
export function registerMetricsRoute(app: FastifyInstance, deps: MetricsRouteDeps): void {
  app.get('/metrics', async (_request, reply) => {
    const families: MetricFamily[] = [
      gauge('zkdeal_process_uptime_seconds', process.uptime()),
      // Always emitted so the deployment alert on this catalog family can
      // resolve; the value tracks jobs currently past their inclusion-margin
      // alert threshold (see trackDeadlineRiskJob).
      gauge('zkdeal_deadline_risk_jobs', DEADLINE_RISK_SERVICE_CLASSES.map((serviceClass) => ({
        labels: { service_class: serviceClass }, value: deadlineRiskJobs.get(serviceClass) ?? 0,
      }))),
    ]
    if (deps.demo) {
      const view = deps.demo.metricsView()
      families.push(
        gauge(
          'zkdeal_demo_rooms',
          Object.entries(view.roomPhases).map(([phase, value]) => ({
            labels: { phase },
            value,
          })),
        ),
        gauge('zkdeal_demo_templates', view.templates),
        gauge('zkdeal_demo_jobs', [
          { labels: { state: 'running' }, value: view.jobs.running },
          { labels: { state: 'finished' }, value: view.jobs.finished },
          { labels: { state: 'failed' }, value: view.jobs.failed },
        ]),
        gauge('zkdeal_proving_slot_active', view.provingSlot.active ? 1 : 0),
        gauge('zkdeal_proving_slot_waiting', view.provingSlot.waiting),
        counter('zkdeal_demo_checkpoints_total', [
          { labels: { outcome: 'accepted' }, value: view.checkpoints.accepted },
          { labels: { outcome: 'failed' }, value: view.checkpoints.failed },
        ]),
        counter('zkdeal_demo_events_emitted_total', view.eventsEmitted),
        gauge('zkdeal_sse_subscribers', view.sseSubscribers),
        summary('zkdeal_demo_proof_seconds', view.proofSeconds.sum, view.proofSeconds.count),
      )
    }
    if (deps.sse) {
      families.push(
        counter('zkdeal_sse_batches_flushed_total', deps.sse.batchesFlushed),
        counter('zkdeal_sse_events_batched_total', deps.sse.eventsBatched),
        counter('zkdeal_sse_events_dropped_total', deps.sse.eventsDropped),
      )
    }
    if (deps.hosted) {
      families.push(...hostedMetricFamilies(
        await deps.hosted.store.hostedMetricsSnapshot(),deps.hosted.status(),deps.hosted.l1.status(),
      ))
    }
    reply.header('content-type', METRICS_CONTENT_TYPE)
    return renderMetrics(families)
  })
}
