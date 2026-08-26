import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { decodeFunctionData, type Abi } from 'viem'
import type {
  AdmissionWalRecord,
  CanonicalBlockInput,
  CapacityIntent,
  CapacityExecutionLease,
  CapacityDemandSignal,
  CoordinatorFence,
  HostedOutboxEvent,
  HostedOutboxAudience,
  HostedPrincipal,
  HostedPrincipalKind,
  HostedProofProfile,
  HostedProviderNodeAssignment,
  HostedProveJob,
  HostedRole,
  TenantLimits,
  UsageEntry,
  AggregateBillingMember,
  BillingInvoice,
  BillingLedgerEntry,
  NodeLifecycleExecutionLease,
  NodeLifecycleOperation,
  NodeLifecycleDesiredState,
} from './hosted-types.js'
import { DEFAULT_TENANT_LIMITS, validatePrincipalRoles } from './hosted-types.js'
import type { IndexedBlobRequirement } from './blob-archive.js'

export interface SqlResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<SqlResult<Row>>
  release(): void
}

export interface SqlPool {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<SqlResult<Row>>
  connect(): Promise<SqlClient>
  end(): Promise<void>
}

export interface ReplicationPromotionEvidence {
  targetLsn: string
  replayLsn: string
  checkpointRecordedAt: string
  checkedAt: string
  checkpointAgeMs: number
  previousHolderId: string
  previousFenceToken: string
}

export interface ReplicationPromotionResult {
  fence: CoordinatorFence
  replication: ReplicationPromotionEvidence
}

export interface CapacityProviderResult {
  state: 'APPLIED' | 'PENDING'
  providerOperationId: string
  providerNodeId: string | null
  retryAfterMs: number | null
  evidence: Record<string, unknown>
}

export interface NodeLifecycleProviderResult {
  state: 'APPLIED' | 'PENDING'
  providerOperationId: string
  retryAfterMs: number | null
  evidence: Record<string, unknown>
}

export interface AggregateBillingRequestBindingMember extends AggregateBillingMember {
  resultObjectKey: string
  resultDigest: string
}

export interface AggregateBillingRequestBinding {
  chainId: number
  aggregateHash: `0x${string}`
  destinationAddress: `0x${string}`
  calldata: `0x${string}`
  members: AggregateBillingRequestBindingMember[]
}

/**
 * Load node-postgres only when hosted mode is enabled. Keeping the import
 * behind this boundary lets unit tests and standalone demos run without a
 * database while production fails startup if the driver is absent.
 */
export async function createPostgresPool(databaseUrl: string): Promise<SqlPool> {
  let driver: {
    Pool?: new (options: Record<string, unknown>) => SqlPool
    default?: { Pool?: new (options: Record<string, unknown>) => SqlPool }
  }
  try {
    // `pg` is a pinned hosted-runtime dependency. createRequire keeps the
    // optional standalone boundary without relying on Function(import), which
    // is disabled by Node VM/module policies used by production test runners.
    driver = createRequire(import.meta.url)('pg') as typeof driver
  } catch (error) {
    throw new Error(`hosted mode requires the pg package: ${(error as Error).message}`)
  }
  const Pool = driver.Pool ?? driver.default?.Pool
  if (!Pool) throw new Error('hosted mode could not load pg.Pool')
  return new Pool({ connectionString: databaseUrl, max: 20, application_name: 'zkdeal-web2-api' })
}

export const HOSTED_SCHEMA_VERSION = 28

/**
 * PostgreSQL is the canonical authority for hosted mode. Every table that can
 * cause an external effect is either fencing-token protected or read-only.
 */
export const HOSTED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hosted_schema_meta (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_tenants (
  tenant_id text PRIMARY KEY,
  display_name text NOT NULL,
  tier text NOT NULL,
  limits jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_principals (
  principal_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  kind text NOT NULL CHECK (kind IN ('api-key', 'node', 'service')),
  key_hash bytea NOT NULL UNIQUE,
  roles text[] NOT NULL,
  limits jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  overlap_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS hosted_principals_tenant_idx
  ON hosted_principals(tenant_id, kind, active);

CREATE TABLE IF NOT EXISTS hosted_wallet_challenges (
  challenge_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  allocation_id text NOT NULL CHECK (allocation_id ~ '^0x[0-9a-f]{64}$'),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  domain text NOT NULL,
  uri text NOT NULL,
  nonce_hash bytea NOT NULL UNIQUE,
  message text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL,
  session_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,idempotency_key),
  CHECK (session_expires_at > expires_at)
);
CREATE INDEX IF NOT EXISTS hosted_wallet_challenges_expiry_idx
  ON hosted_wallet_challenges(expires_at,used_at);

CREATE TABLE IF NOT EXISTS coordinator_leases (
  lease_name text PRIMARY KEY,
  holder_id text NOT NULL,
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_primary_wal_checkpoints (
  checkpoint_name text PRIMARY KEY,
  primary_holder_id text NOT NULL,
  primary_fence_token bigint NOT NULL CHECK (primary_fence_token > 0),
  target_lsn pg_lsn NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (checkpoint_name = 'coordinator-writer')
);

CREATE TABLE IF NOT EXISTS hosted_worker_leases (
  component text PRIMARY KEY,
  worker_id text NOT NULL,
  worker_fence_token bigint NOT NULL CHECK (worker_fence_token > 0),
  coordinator_holder_id text NOT NULL,
  coordinator_fence_token bigint NOT NULL CHECK (coordinator_fence_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_worker_leases_epoch_idx
  ON hosted_worker_leases(coordinator_holder_id, coordinator_fence_token, expires_at);

CREATE TABLE IF NOT EXISTS hosted_outbox (
  event_id bigserial PRIMARY KEY,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  audience text NOT NULL DEFAULT 'admin-internal'
    CHECK (audience IN ('tenant','public-chain','admin-internal')),
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  retention_class text NOT NULL DEFAULT 'audit'
    CHECK (retention_class IN ('transient','audit','safety')),
  resolved_at timestamptz
);
ALTER TABLE hosted_outbox
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'audit';
ALTER TABLE hosted_outbox
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE hosted_outbox
  ADD COLUMN IF NOT EXISTS delivery_owner text;
ALTER TABLE hosted_outbox
  ADD COLUMN IF NOT EXISTS delivery_lease_expires_at timestamptz;
ALTER TABLE hosted_outbox
  ADD COLUMN IF NOT EXISTS audience text;
UPDATE hosted_outbox SET audience = CASE
  WHEN tenant_id IS NULL THEN 'admin-internal' ELSE 'tenant' END
WHERE audience IS NULL;
ALTER TABLE hosted_outbox ALTER COLUMN audience SET DEFAULT 'admin-internal';
ALTER TABLE hosted_outbox ALTER COLUMN audience SET NOT NULL;
ALTER TABLE hosted_outbox DROP CONSTRAINT IF EXISTS hosted_outbox_audience_check;
ALTER TABLE hosted_outbox ADD CONSTRAINT hosted_outbox_audience_check
  CHECK (audience IN ('tenant','public-chain','admin-internal'));
CREATE INDEX IF NOT EXISTS hosted_outbox_tenant_event_idx
  ON hosted_outbox(tenant_id, event_id);
CREATE INDEX IF NOT EXISTS hosted_outbox_audience_event_idx
  ON hosted_outbox(audience, event_id);
CREATE INDEX IF NOT EXISTS hosted_outbox_retention_idx
  ON hosted_outbox(retention_class, resolved_at, created_at);

CREATE TABLE IF NOT EXISTS hosted_sse_connections (
  connection_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  replica_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_sse_connections_tenant_idx
  ON hosted_sse_connections(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS hosted_rate_limit_windows (
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY(principal_id, window_start)
);

CREATE TABLE IF NOT EXISTS admission_wal (
  room_id numeric(20,0) NOT NULL,
  admission_id numeric(20,0) NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  transaction_hash text NOT NULL UNIQUE,
  raw_signed_transaction text NOT NULL,
  sender text NOT NULL,
  request jsonb NOT NULL,
  receipt jsonb,
  status text NOT NULL CHECK (status IN ('RESERVED','COMMITTED','LEASED','ACKED','CANCELLED')),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(room_id, admission_id)
);
CREATE INDEX IF NOT EXISTS admission_wal_drain_idx
  ON admission_wal(room_id, status, lease_expires_at, admission_id);

CREATE TABLE IF NOT EXISTS hosted_usage_ledger (
  usage_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  allocation_id text,
  job_id text,
  room_id numeric(20,0),
  unit text NOT NULL,
  quantity numeric(78,18) NOT NULL CHECK (quantity >= 0),
  observed_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_usage_tenant_time_idx
  ON hosted_usage_ledger(tenant_id, observed_at, usage_id);

CREATE OR REPLACE FUNCTION hosted_immutable_ledger_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hosted ledger rows are immutable; append a correction instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS hosted_usage_immutable ON hosted_usage_ledger;
CREATE TRIGGER hosted_usage_immutable BEFORE UPDATE OR DELETE ON hosted_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();

CREATE TABLE IF NOT EXISTS canonical_l1_blocks (
  chain_id bigint NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(chain_id, block_number, block_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_l1_one_hash_idx
  ON canonical_l1_blocks(chain_id, block_number) WHERE canonical;

CREATE TABLE IF NOT EXISTS hosted_canonical_anchors (
  chain_id bigint PRIMARY KEY,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  verified_sources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_canonical_floors (
  chain_id bigint PRIMARY KEY REFERENCES hosted_canonical_anchors(chain_id),
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  verified_sources jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_indexer_cursors (
  chain_id bigint NOT NULL,
  source text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  schema_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, source)
);

CREATE TABLE IF NOT EXISTS hosted_indexer_logs (
  chain_id bigint NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  log_index integer NOT NULL,
  transaction_hash text NOT NULL,
  address text NOT NULL,
  event_name text NOT NULL,
  decoded jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, block_hash, log_index)
);
CREATE INDEX IF NOT EXISTS hosted_indexer_logs_canonical_idx
  ON hosted_indexer_logs(chain_id, block_number, canonical);

CREATE TABLE IF NOT EXISTS hosted_indexer_facts (
  fact_id bigserial PRIMARY KEY,
  fact_key text NOT NULL,
  chain_id bigint NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  fact_kind text NOT NULL,
  room_id numeric(20,0),
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  payload jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE hosted_indexer_facts ADD COLUMN IF NOT EXISTS fact_key text;
UPDATE hosted_indexer_facts SET fact_key = 'legacy:' || fact_id::text WHERE fact_key IS NULL;
ALTER TABLE hosted_indexer_facts ALTER COLUMN fact_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS hosted_indexer_facts_canonical_idx
  ON hosted_indexer_facts(chain_id, block_number, canonical, fact_kind);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_indexer_facts_source_key_idx
  ON hosted_indexer_facts(chain_id, block_hash, fact_key);

CREATE TABLE IF NOT EXISTS hosted_wallet_sessions (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  challenge_id text NOT NULL UNIQUE REFERENCES hosted_wallet_challenges(challenge_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  allocation_id text NOT NULL CHECK (allocation_id ~ '^0x[0-9a-f]{64}$'),
  room_id numeric(20,0) NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  authority_fact_id bigint NOT NULL REFERENCES hosted_indexer_facts(fact_id),
  authority_fact_block_hash text NOT NULL CHECK (authority_fact_block_hash ~ '^0x[0-9a-f]{64}$'),
  authority_head_block numeric(78,0) NOT NULL,
  authority_head_hash text NOT NULL CHECK (authority_head_hash ~ '^0x[0-9a-f]{64}$'),
  verification_request_hash text NOT NULL CHECK (verification_request_hash ~ '^[0-9a-f]{64}$'),
  verification_idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,verification_idempotency_key)
);
CREATE INDEX IF NOT EXISTS hosted_wallet_sessions_scope_idx
  ON hosted_wallet_sessions(tenant_id,chain_id,allocation_id,expires_at);

CREATE TABLE IF NOT EXISTS hosted_blob_archives (
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  versioned_hashes text[] NOT NULL,
  commitments text[] NOT NULL,
  proofs text[] NOT NULL,
  bundle_object_key text NOT NULL,
  bundle_sha256 text NOT NULL,
  signed_transaction_object_key text,
  archive_source text NOT NULL CHECK (archive_source IN ('hosted-prepublish','beacon-fallback')),
  verified_sources jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, transaction_hash),
  CHECK (cardinality(versioned_hashes) > 0),
  CHECK (cardinality(versioned_hashes) = cardinality(commitments)),
  CHECK (cardinality(versioned_hashes) = cardinality(proofs)),
  CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$')
);
DROP TRIGGER IF EXISTS hosted_blob_archives_immutable ON hosted_blob_archives;
CREATE TRIGGER hosted_blob_archives_immutable BEFORE UPDATE OR DELETE ON hosted_blob_archives
FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();

CREATE TABLE IF NOT EXISTS hosted_blob_requirements (
  requirement_id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  room_id numeric(20,0) NOT NULL,
  batch_index numeric(20,0) NOT NULL,
  blob_start_index integer NOT NULL CHECK (blob_start_index BETWEEN 0 AND 5),
  versioned_hashes text[] NOT NULL,
  commitments text[] NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VERIFIED','ERROR','RETRACTED')),
  canonical boolean NOT NULL DEFAULT true,
  last_error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at timestamptz,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id, block_hash, transaction_hash, room_id, batch_index),
  CHECK (cardinality(versioned_hashes) > 0),
  CHECK (cardinality(versioned_hashes) = cardinality(commitments))
);
CREATE INDEX IF NOT EXISTS hosted_blob_requirements_pending_idx
  ON hosted_blob_requirements(chain_id, status, block_number) WHERE canonical;

CREATE TABLE IF NOT EXISTS hosted_l1_nonce_state (
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,sender)
);

CREATE TABLE IF NOT EXISTS hosted_l1_transactions (
  operation_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  nonce numeric(78,0) NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  request_object_key text NOT NULL,
  transport_request_hash text,
  transport_request_object_key text,
  destination_address text CHECK (
    destination_address IS NULL OR destination_address ~ '^0x[0-9a-f]{40}$'
  ),
  calldata text NOT NULL,
  inclusion_deadline numeric(78,0) NOT NULL,
  transaction_hash text UNIQUE,
  raw_transaction_object_key text,
  bundle_object_key text,
  status text NOT NULL CHECK (status IN (
    'PREPARED','SIGNED','BROADCAST','INCLUDED','FINALIZED','FAILED','RECOVERY_REQUIRED','SUPERSEDED'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_risk boolean NOT NULL DEFAULT false,
  block_number numeric(78,0),
  block_hash text,
  gas_used numeric(78,0) CHECK (gas_used IS NULL OR gas_used >= 0),
  effective_gas_price numeric(78,0) CHECK (effective_gas_price IS NULL OR effective_gas_price >= 0),
  blob_gas_used numeric(78,0) CHECK (blob_gas_used IS NULL OR blob_gas_used >= 0),
  blob_gas_price numeric(78,0) CHECK (blob_gas_price IS NULL OR blob_gas_price >= 0),
  receipt_provider_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  receipt_observed_at timestamptz,
  receipt_canonical boolean NOT NULL DEFAULT false,
  finalized_block numeric(78,0),
  finalized_hash text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id,sender,nonce),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (
    (transport_request_hash IS NULL AND transport_request_object_key IS NULL)
    OR (transport_request_hash ~ '^[0-9a-f]{64}$' AND transport_request_object_key IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS hosted_l1_transactions_pending_idx
  ON hosted_l1_transactions(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS hosted_l1_service_bindings (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  binding_kind text NOT NULL CHECK (binding_kind IN (
    'node-liveness','room-submit','room-aggregate','pool-sponsor','pool-finality-oracle','pool-beneficiary'
  )),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  expected_sender text NOT NULL CHECK (expected_sender ~ '^0x[0-9a-f]{40}$'),
  node_id text CHECK (node_id IS NULL OR node_id ~ '^0x[0-9a-f]{64}$'),
  room_id numeric(20,0),
  sponsorship_id text,
  allocation_id text CHECK (allocation_id IS NULL OR allocation_id ~ '^0x[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (binding_kind='node-liveness' AND node_id IS NOT NULL AND room_id IS NULL)
    OR (binding_kind='room-submit' AND node_id IS NULL AND room_id IS NOT NULL
        AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='room-aggregate' AND node_id IS NULL AND room_id IS NULL
        AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-sponsor' AND node_id IS NULL AND room_id IS NULL
        AND sponsorship_id IS NOT NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-finality-oracle' AND node_id IS NULL AND room_id IS NOT NULL
        AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-beneficiary' AND node_id IS NULL AND room_id IS NULL
        AND sponsorship_id IS NULL AND allocation_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS hosted_l1_operation_access (
  operation_id text PRIMARY KEY REFERENCES hosted_l1_transactions(operation_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  correlation_id text NOT NULL,
  minimum_confirmations integer NOT NULL CHECK (minimum_confirmations BETWEEN 1 AND 4096),
  require_finalized boolean NOT NULL,
  binding_kind text NOT NULL CHECK (binding_kind IN (
    'node-liveness','room-submit','room-aggregate','pool-sponsor','pool-finality-oracle','pool-beneficiary'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_post_finality_recoveries (
  recovery_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES hosted_l1_transactions(operation_id),
  prior_floor_number numeric(78,0) NOT NULL,
  prior_floor_hash text NOT NULL,
  branch_start_number numeric(78,0) NOT NULL,
  branch_blocks jsonb NOT NULL,
  required_indexer_sources text[] NOT NULL CHECK (cardinality(required_indexer_sources) > 0),
  verified_sources jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('BRANCH_INSTALLED','RESOLVED')),
  replacement_floor_number numeric(78,0),
  replacement_floor_hash text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK (
    (status='BRANCH_INSTALLED' AND replacement_floor_number IS NULL
      AND replacement_floor_hash IS NULL AND resolved_at IS NULL)
    OR
    (status='RESOLVED' AND replacement_floor_number IS NOT NULL
      AND replacement_floor_hash IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION hosted_l1_transaction_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_id <> OLD.operation_id OR NEW.chain_id <> OLD.chain_id
     OR NEW.sender <> OLD.sender OR NEW.nonce <> OLD.nonce
     OR NEW.operation <> OLD.operation OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.request_object_key <> OLD.request_object_key
     OR NEW.transport_request_hash IS DISTINCT FROM OLD.transport_request_hash
     OR NEW.transport_request_object_key IS DISTINCT FROM OLD.transport_request_object_key
     OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
     OR NEW.calldata <> OLD.calldata OR NEW.inclusion_deadline <> OLD.inclusion_deadline
     OR (OLD.gas_used IS NOT NULL AND NEW.gas_used IS DISTINCT FROM OLD.gas_used)
     OR (OLD.effective_gas_price IS NOT NULL AND NEW.effective_gas_price IS DISTINCT FROM OLD.effective_gas_price)
     OR (OLD.blob_gas_used IS NOT NULL AND NEW.blob_gas_used IS DISTINCT FROM OLD.blob_gas_used)
     OR (OLD.blob_gas_price IS NOT NULL AND NEW.blob_gas_price IS DISTINCT FROM OLD.blob_gas_price) THEN
    RAISE EXCEPTION 'hosted L1 transaction immutable fields cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hosted_l1_transactions_immutable ON hosted_l1_transactions;
CREATE TRIGGER hosted_l1_transactions_immutable BEFORE UPDATE ON hosted_l1_transactions
FOR EACH ROW EXECUTE FUNCTION hosted_l1_transaction_immutable_guard();

CREATE TABLE IF NOT EXISTS hosted_l1_finality_audit_cursors (
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  last_operation_id text,
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,sender)
);

CREATE TABLE IF NOT EXISTS hosted_room_observations (
  room_id numeric(20,0) NOT NULL,
  chain_id bigint NOT NULL,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  schema_version integer NOT NULL,
  head_block numeric(78,0) NOT NULL,
  head_hash text NOT NULL,
  document jsonb NOT NULL,
  reconciled boolean NOT NULL DEFAULT false,
  reconciliation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id)
);
ALTER TABLE hosted_room_observations
  ADD COLUMN IF NOT EXISTS chain_id bigint;
CREATE INDEX IF NOT EXISTS hosted_observation_head_idx
  ON hosted_room_observations(chain_id, head_block);

CREATE TABLE IF NOT EXISTS hosted_room_proving_policies (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  policy jsonb NOT NULL,
  object_key text NOT NULL,
  object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
  bound_block numeric(78,0) NOT NULL,
  bound_hash text NOT NULL CHECK (bound_hash ~ '^0x[0-9a-f]{64}$'),
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,room_id),
  UNIQUE(chain_id,room_id,policy_hash)
);

CREATE TABLE IF NOT EXISTS hosted_room_reconciliation_queue (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  dirty boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_success_block numeric(78,0),
  last_success_hash text,
  last_error text,
  next_retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id)
);
CREATE INDEX IF NOT EXISTS hosted_room_reconciliation_order_idx
  ON hosted_room_reconciliation_queue(chain_id, dirty DESC, priority DESC, last_success_at, room_id);
INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
SELECT chain_id,room_id,true,10 FROM hosted_room_observations
ON CONFLICT (chain_id,room_id) DO NOTHING;
INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
SELECT DISTINCT chain_id,room_id,true,10 FROM hosted_indexer_facts WHERE room_id IS NOT NULL
ON CONFLICT (chain_id,room_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hosted_withdrawal_epochs (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  epoch numeric(20,0) NOT NULL,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  deployment_domain text NOT NULL,
  capacity integer NOT NULL CHECK (
    capacity BETWEEN 1 AND 32768 AND (capacity & (capacity - 1)) = 0
  ),
  withdrawal_root text NOT NULL,
  source_object_key text NOT NULL,
  source_transaction_hash text NOT NULL,
  finalized_block numeric(78,0) NOT NULL,
  finalized_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('FINALIZED','RECOVERY_REQUIRED')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id, epoch)
);
CREATE INDEX IF NOT EXISTS hosted_withdrawal_epochs_finalized_idx
  ON hosted_withdrawal_epochs(chain_id, finalized_block, status);

CREATE TABLE IF NOT EXISTS hosted_withdrawals (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  epoch numeric(20,0) NOT NULL,
  withdrawal_index numeric(78,0) NOT NULL,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  approver_epoch numeric(20,0) NOT NULL,
  recipient text NOT NULL,
  asset text NOT NULL,
  amount numeric(78,0) NOT NULL,
  withdrawal_root text NOT NULL,
  leaf_hash text NOT NULL,
  positional_proof jsonb NOT NULL,
  finalized_block numeric(78,0) NOT NULL,
  finalized_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('FINALIZED','CLAIM_PENDING','CLAIMED','RETRACTED')),
  previous_status text,
  retraction_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id, epoch, withdrawal_index)
);
CREATE INDEX IF NOT EXISTS hosted_withdrawals_provenance_idx
  ON hosted_withdrawals(chain_id, finalized_block, finalized_hash, status);

CREATE TABLE IF NOT EXISTS hosted_withdrawal_claims (
  claim_id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  epoch numeric(20,0) NOT NULL,
  withdrawal_index numeric(78,0) NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  idempotency_key text NOT NULL UNIQUE,
  operation_id text UNIQUE REFERENCES hosted_l1_transactions(operation_id),
  transaction_hash text,
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED','RETRACTED')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id, room_id, epoch, withdrawal_index, tenant_id)
);

CREATE TABLE IF NOT EXISTS hosted_entitlements (
  entitlement_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  allocation_id text,
  unit text NOT NULL,
  quantity numeric(78,18) NOT NULL CHECK (quantity >= 0),
  consumed numeric(78,18) NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (consumed <= quantity)
);

CREATE TABLE IF NOT EXISTS hosted_sponsorships (
  sponsorship_id text PRIMARY KEY,
  sponsor_tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  beneficiary_tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  allocation_id text,
  maximum_quantity numeric(78,18) NOT NULL CHECK (maximum_quantity >= 0),
  consumed_quantity numeric(78,18) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  reserved_quantity numeric(78,18) NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  unit text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  metadata jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (consumed_quantity + reserved_quantity <= maximum_quantity)
);

CREATE TABLE IF NOT EXISTS hosted_sponsorship_reservations (
  job_id text PRIMARY KEY,
  sponsorship_id text NOT NULL REFERENCES hosted_sponsorships(sponsorship_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  allocation_id text,
  unit text NOT NULL,
  quantity numeric(78,18) NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('RESERVED','CONSUMED','RELEASED','TRANSFERRED')),
  transferred_to_job_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_sponsorship_charges (
  charge_id bigserial PRIMARY KEY,
  sponsorship_id text NOT NULL REFERENCES hosted_sponsorships(sponsorship_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  job_id text,
  quantity numeric(78,18) NOT NULL CHECK (quantity >= 0),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'SUCCEEDED' CHECK (status = 'SUCCEEDED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_refunds (
  refund_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  sponsorship_id text REFERENCES hosted_sponsorships(sponsorship_id),
  usage_id bigint REFERENCES hosted_usage_ledger(usage_id),
  quantity numeric(78,18) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'SUCCEEDED' CHECK (status = 'SUCCEEDED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A publisher registers this immutable join before broadcasting an aggregate.
-- The untrusted prover result cannot choose who is billed. Each member is
-- bound to an already durable proof job and is later matched byte-for-byte to
-- the finalized AggregateMemberOutcome event.
CREATE TABLE IF NOT EXISTS hosted_aggregate_billing_manifests (
  chain_id bigint NOT NULL,
  aggregate_hash text NOT NULL CHECK (aggregate_hash ~ '^0x[0-9a-f]{64}$'),
  operation_id text NOT NULL UNIQUE REFERENCES hosted_l1_transactions(operation_id),
  transaction_hash text NOT NULL UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  destination_address text NOT NULL CHECK (destination_address ~ '^0x[0-9a-f]{40}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  calldata_hash text NOT NULL CHECK (calldata_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL UNIQUE,
  member_count integer NOT NULL CHECK (member_count BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,aggregate_hash)
);
CREATE TABLE IF NOT EXISTS hosted_aggregate_billing_members (
  chain_id bigint NOT NULL,
  aggregate_hash text NOT NULL,
  member_index integer NOT NULL CHECK (member_index BETWEEN 0 AND 7),
  job_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  room_id numeric(20,0) NOT NULL,
  batch_index numeric(20,0) NOT NULL,
  allocation_id text,
  allocation_fact_id bigint REFERENCES hosted_indexer_facts(fact_id),
  allocation_fact_block_hash text,
  sponsorship_id text REFERENCES hosted_sponsorships(sponsorship_id),
  result_object_key text NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  billable_unit text NOT NULL,
  billable_quantity numeric(78,18) NOT NULL CHECK (billable_quantity > 0),
  payer_tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  price_id bigint NOT NULL,
  unit_price numeric(78,18) NOT NULL CHECK (unit_price >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_effective_from timestamptz NOT NULL,
  quote_accepted_at timestamptz NOT NULL,
  maximum_charge_amount numeric(78,18) NOT NULL CHECK (maximum_charge_amount >= 0),
  maximum_charge_currency text NOT NULL CHECK (maximum_charge_currency ~ '^[A-Z]{3}$'),
  sla_policy_id bigint,
  sla_effective_from timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,aggregate_hash,member_index),
  UNIQUE(job_id),
  CHECK (
    (allocation_id IS NULL AND allocation_fact_id IS NULL AND allocation_fact_block_hash IS NULL)
    OR (allocation_id IS NOT NULL AND allocation_fact_id IS NOT NULL AND allocation_fact_block_hash IS NOT NULL)
  ),
  FOREIGN KEY(chain_id,aggregate_hash)
    REFERENCES hosted_aggregate_billing_manifests(chain_id,aggregate_hash)
);
CREATE INDEX IF NOT EXISTS hosted_aggregate_billing_job_idx
  ON hosted_aggregate_billing_members(job_id);

-- Policies are append-only and effective-dated so old invoices never change
-- when an operator publishes a new commercial rate or SLA.
CREATE TABLE IF NOT EXISTS hosted_billing_prices (
  price_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  unit text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_price numeric(78,18) NOT NULL CHECK (unit_price >= 0),
  effective_from timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,unit,effective_from)
);
CREATE TABLE IF NOT EXISTS hosted_sla_policies (
  policy_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  service_class text NOT NULL CHECK (service_class IN ('standard','latency','batch')),
  maximum_queue_ms bigint NOT NULL CHECK (maximum_queue_ms >= 0),
  maximum_proof_ms bigint NOT NULL CHECK (maximum_proof_ms >= 0),
  credit_basis_points integer NOT NULL CHECK (credit_basis_points BETWEEN 0 AND 9999),
  effective_from timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,service_class,effective_from)
);

CREATE TABLE IF NOT EXISTS hosted_aggregate_outcome_receipts (
  receipt_id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  aggregate_hash text NOT NULL,
  member_index integer NOT NULL,
  source_fact_id bigint NOT NULL UNIQUE REFERENCES hosted_indexer_facts(fact_id),
  applied boolean NOT NULL,
  failure_selector text NOT NULL,
  sponsorship_effect text NOT NULL CHECK (sponsorship_effect IN ('NONE','CONSUMED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(chain_id,aggregate_hash,member_index)
    REFERENCES hosted_aggregate_billing_members(chain_id,aggregate_hash,member_index)
);

-- Retractions are append-only versions. They make both a prior successful
-- charge and a prior failed/released reservation reversible without mutating
-- the original canonical-outcome receipt.
CREATE TABLE IF NOT EXISTS hosted_aggregate_outcome_retractions (
  retraction_id bigserial PRIMARY KEY,
  receipt_id bigint NOT NULL UNIQUE REFERENCES hosted_aggregate_outcome_receipts(receipt_id),
  source_fact_id bigint NOT NULL UNIQUE REFERENCES hosted_indexer_facts(fact_id),
  correction_entry_id bigint,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Signed append-only entries are the invoice authority. Positive CHARGE rows
-- are created only for finalized applied members; every reorg/refund/SLA
-- correction is a separate negative row that names the original entry.
CREATE TABLE IF NOT EXISTS hosted_billing_ledger (
  entry_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  beneficiary_tenant_id text REFERENCES hosted_tenants(tenant_id),
  sponsorship_id text REFERENCES hosted_sponsorships(sponsorship_id),
  allocation_id text,
  job_id text,
  room_id numeric(20,0),
  aggregate_hash text,
  member_index integer,
  entry_kind text NOT NULL CHECK (entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE','REORG_CREDIT','REFUND','SLA_CREDIT')),
  unit text NOT NULL,
  quantity numeric(78,18) NOT NULL CHECK (quantity <> 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount numeric(78,18),
  price_id bigint REFERENCES hosted_billing_prices(price_id),
  price_effective_from timestamptz,
  sla_policy_id bigint REFERENCES hosted_sla_policies(policy_id),
  sla_effective_from timestamptz,
  source_fact_id bigint REFERENCES hosted_indexer_facts(fact_id),
  reverses_entry_id bigint REFERENCES hosted_billing_ledger(entry_id),
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE') AND quantity > 0 AND (amount IS NULL OR amount >= 0))
    OR (entry_kind NOT IN ('CHARGE','L1_ALLOCATION_CHARGE') AND quantity < 0 AND (amount IS NULL OR amount <= 0))
  ),
  CHECK ((reverses_entry_id IS NULL) = (entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE')))
);
CREATE INDEX IF NOT EXISTS hosted_billing_tenant_time_idx
  ON hosted_billing_ledger(tenant_id,created_at,entry_id);
CREATE INDEX IF NOT EXISTS hosted_billing_source_fact_idx
  ON hosted_billing_ledger(source_fact_id,entry_kind);

CREATE TABLE IF NOT EXISTS hosted_invoice_exports (
  invoice_id text PRIMARY KEY,
  supersedes_invoice_id text UNIQUE REFERENCES hosted_invoice_exports(invoice_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ledger_high_water bigint NOT NULL CHECK (ledger_high_water >= 0),
  net_amount numeric(78,18) NOT NULL,
  line_items jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_end > period_start)
);
DROP INDEX IF EXISTS hosted_invoice_exports_period_idx;
CREATE UNIQUE INDEX hosted_invoice_exports_period_idx
  ON hosted_invoice_exports(tenant_id,period_start,period_end,currency)
  WHERE supersedes_invoice_id IS NULL;

-- Idempotent column convergence for databases created by an earlier owner
-- schema. Unsafe, already-registered aggregate manifests are rejected by the
-- v19 migration instead of being guessed/backfilled into a financial trust root.
ALTER TABLE hosted_l1_transactions ADD COLUMN IF NOT EXISTS destination_address text;
ALTER TABLE hosted_sponsorship_reservations
  ADD COLUMN IF NOT EXISTS allocation_id text,
  ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE hosted_aggregate_billing_manifests
  ADD COLUMN IF NOT EXISTS operation_id text,
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD COLUMN IF NOT EXISTS destination_address text,
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS calldata_hash text;
ALTER TABLE hosted_aggregate_billing_members
  ADD COLUMN IF NOT EXISTS result_object_key text,
  ADD COLUMN IF NOT EXISTS result_digest text,
  ADD COLUMN IF NOT EXISTS payer_tenant_id text,
  ADD COLUMN IF NOT EXISTS price_id bigint,
  ADD COLUMN IF NOT EXISTS unit_price numeric(78,18),
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS price_effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS maximum_charge_amount numeric(78,18),
  ADD COLUMN IF NOT EXISTS maximum_charge_currency text,
  ADD COLUMN IF NOT EXISTS sla_policy_id bigint,
  ADD COLUMN IF NOT EXISTS sla_effective_from timestamptz;
ALTER TABLE hosted_billing_ledger
  ADD COLUMN IF NOT EXISTS beneficiary_tenant_id text,
  ADD COLUMN IF NOT EXISTS sponsorship_id text,
  ADD COLUMN IF NOT EXISTS price_id bigint,
  ADD COLUMN IF NOT EXISTS price_effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS sla_policy_id bigint,
  ADD COLUMN IF NOT EXISTS sla_effective_from timestamptz;
ALTER TABLE hosted_invoice_exports ADD COLUMN IF NOT EXISTS supersedes_invoice_id text;

ALTER TABLE hosted_refunds ADD COLUMN IF NOT EXISTS billing_entry_id bigint;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_refunds'::regclass
      AND conname='hosted_refunds_billing_entry_fk'
  ) THEN
    ALTER TABLE hosted_refunds ADD CONSTRAINT hosted_refunds_billing_entry_fk
      FOREIGN KEY(billing_entry_id) REFERENCES hosted_billing_ledger(entry_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_members_price_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members ADD CONSTRAINT hosted_aggregate_members_price_fk
      FOREIGN KEY(price_id) REFERENCES hosted_billing_prices(price_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_members_sla_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members ADD CONSTRAINT hosted_aggregate_members_sla_fk
      FOREIGN KEY(sla_policy_id) REFERENCES hosted_sla_policies(policy_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_outcome_retractions'::regclass
      AND conname='hosted_aggregate_retractions_correction_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_outcome_retractions ADD CONSTRAINT hosted_aggregate_retractions_correction_fk
      FOREIGN KEY(correction_entry_id) REFERENCES hosted_billing_ledger(entry_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS hosted_aggregate_billing_manifests_immutable ON hosted_aggregate_billing_manifests;
CREATE TRIGGER hosted_aggregate_billing_manifests_immutable BEFORE UPDATE OR DELETE ON hosted_aggregate_billing_manifests
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_aggregate_billing_members_immutable ON hosted_aggregate_billing_members;
CREATE TRIGGER hosted_aggregate_billing_members_immutable BEFORE UPDATE OR DELETE ON hosted_aggregate_billing_members
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_aggregate_outcomes_immutable ON hosted_aggregate_outcome_receipts;
CREATE TRIGGER hosted_aggregate_outcomes_immutable BEFORE UPDATE OR DELETE ON hosted_aggregate_outcome_receipts
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_aggregate_retractions_immutable ON hosted_aggregate_outcome_retractions;
CREATE TRIGGER hosted_aggregate_retractions_immutable BEFORE UPDATE OR DELETE ON hosted_aggregate_outcome_retractions
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_billing_immutable ON hosted_billing_ledger;
CREATE TRIGGER hosted_billing_immutable BEFORE UPDATE OR DELETE ON hosted_billing_ledger
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_billing_prices_immutable ON hosted_billing_prices;
CREATE TRIGGER hosted_billing_prices_immutable BEFORE UPDATE OR DELETE ON hosted_billing_prices
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_sla_policies_immutable ON hosted_sla_policies;
CREATE TRIGGER hosted_sla_policies_immutable BEFORE UPDATE OR DELETE ON hosted_sla_policies
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_invoice_exports_immutable ON hosted_invoice_exports;
CREATE TRIGGER hosted_invoice_exports_immutable BEFORE UPDATE OR DELETE ON hosted_invoice_exports
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_sponsorship_charges_immutable ON hosted_sponsorship_charges;
CREATE TRIGGER hosted_sponsorship_charges_immutable BEFORE UPDATE OR DELETE ON hosted_sponsorship_charges
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
DROP TRIGGER IF EXISTS hosted_refunds_immutable ON hosted_refunds;
CREATE TRIGGER hosted_refunds_immutable BEFORE UPDATE OR DELETE ON hosted_refunds
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();

CREATE TABLE IF NOT EXISTS hosted_audit_records (
  audit_id bigserial PRIMARY KEY,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  principal_id text,
  action text NOT NULL,
  target text NOT NULL,
  idempotency_key text,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_audit_records_tenant_idx
  ON hosted_audit_records(tenant_id, audit_id);
DROP TRIGGER IF EXISTS hosted_audit_immutable ON hosted_audit_records;
CREATE TRIGGER hosted_audit_immutable BEFORE UPDATE OR DELETE ON hosted_audit_records
  FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();

CREATE TABLE IF NOT EXISTS hosted_idempotency_records (
  scope text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS hosted_prove_jobs (
  job_id text PRIMARY KEY,
  retry_of_job_id text REFERENCES hosted_prove_jobs(job_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  room_id numeric(20,0),
  allocation_id text,
  sponsorship_id text REFERENCES hosted_sponsorships(sponsorship_id),
  service_class text NOT NULL,
  correlation_id text,
  partition text NOT NULL CHECK (partition IN ('shared','reserved','dedicated')),
  proof_class text NOT NULL,
  endpoint text NOT NULL,
  needs_gpu boolean NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request_object_key text NOT NULL,
  request_bytes bigint NOT NULL CHECK (request_bytes >= 0),
  estimated_work numeric(78,18) NOT NULL CHECK (estimated_work > 0),
  estimated_proof_time_ms bigint NOT NULL CHECK (estimated_proof_time_ms >= 1000),
  payer_tenant_id text REFERENCES hosted_tenants(tenant_id),
  quote_price_id bigint REFERENCES hosted_billing_prices(price_id),
  quote_unit_price numeric(78,18),
  quote_currency text CHECK (quote_currency IS NULL OR quote_currency ~ '^[A-Z]{3}$'),
  quote_effective_from timestamptz,
  quote_accepted_at timestamptz,
  maximum_charge_amount numeric(78,18),
  maximum_charge_currency text CHECK (
    maximum_charge_currency IS NULL OR maximum_charge_currency ~ '^[A-Z]{3}$'
  ),
  quote_sla_policy_id bigint REFERENCES hosted_sla_policies(policy_id),
  quote_sla_effective_from timestamptz,
  deadline_at timestamptz,
  latest_start_at timestamptz,
  deadline_trusted boolean NOT NULL DEFAULT false,
  deadline_chain_id bigint,
  deadline_block numeric(78,0),
  latest_start_block numeric(78,0),
  deadline_fact_key text,
  deadline_fact_block_hash text,
  settlement_margin_ms bigint NOT NULL DEFAULT 0,
  priority integer NOT NULL DEFAULT 0,
  tenant_weight numeric(78,18) NOT NULL CHECK (tenant_weight > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_at timestamptz,
  finished_at timestamptz,
  actual_queue_ms bigint,
  actual_proof_ms bigint,
  aging_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  virtual_finish numeric(78,18) NOT NULL DEFAULT 0,
  status text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  fence_token bigint,
  result_object_key text,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hosted_prove_jobs_trusted_deadline_source CHECK (
    NOT deadline_trusted OR (
      deadline_chain_id IS NOT NULL AND deadline_block IS NOT NULL
      AND latest_start_block IS NOT NULL AND deadline_fact_key IS NOT NULL
      AND deadline_fact_block_hash IS NOT NULL AND deadline_at IS NOT NULL
      AND latest_start_at IS NOT NULL
    )
  ),
  CONSTRAINT hosted_prove_jobs_quote_complete CHECK (
    (maximum_charge_amount IS NULL AND maximum_charge_currency IS NULL
      AND payer_tenant_id IS NULL AND quote_price_id IS NULL
      AND quote_unit_price IS NULL AND quote_currency IS NULL
      AND quote_effective_from IS NULL AND quote_accepted_at IS NULL)
    OR
    (maximum_charge_amount IS NOT NULL AND maximum_charge_currency IS NOT NULL
      AND payer_tenant_id IS NOT NULL AND quote_price_id IS NOT NULL
      AND quote_unit_price IS NOT NULL AND quote_currency IS NOT NULL
      AND quote_effective_from IS NOT NULL AND quote_accepted_at IS NOT NULL
      AND maximum_charge_currency = quote_currency)
  )
);
ALTER TABLE hosted_prove_jobs
  ADD COLUMN IF NOT EXISTS payer_tenant_id text,
  ADD COLUMN IF NOT EXISTS quote_price_id bigint,
  ADD COLUMN IF NOT EXISTS quote_unit_price numeric(78,18),
  ADD COLUMN IF NOT EXISTS quote_currency text,
  ADD COLUMN IF NOT EXISTS quote_effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS quote_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS maximum_charge_amount numeric(78,18),
  ADD COLUMN IF NOT EXISTS maximum_charge_currency text,
  ADD COLUMN IF NOT EXISTS quote_sla_policy_id bigint,
  ADD COLUMN IF NOT EXISTS quote_sla_effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS result_digest text;
UPDATE hosted_sponsorship_reservations AS reservation SET
  allocation_id=job.allocation_id,
  unit=sponsorship.unit
FROM hosted_prove_jobs AS job,hosted_sponsorships AS sponsorship
WHERE reservation.job_id=job.job_id
  AND reservation.sponsorship_id=sponsorship.sponsorship_id
  AND (reservation.unit IS NULL OR reservation.allocation_id IS DISTINCT FROM job.allocation_id);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_prove_jobs_tenant_idempotency_idx
  ON hosted_prove_jobs(tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_prove_jobs_one_retry_per_job_idx
  ON hosted_prove_jobs(retry_of_job_id) WHERE retry_of_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hosted_prove_jobs_schedule_idx
  ON hosted_prove_jobs(partition, status, deadline_at, virtual_finish, enqueued_at);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_prove_jobs_one_gpu_per_node_idx
  ON hosted_prove_jobs(lease_owner)
  WHERE status = 'LEASED' AND needs_gpu AND lease_owner IS NOT NULL;

-- Provider-node eligibility is operator-owned. A worker may report transient
-- health, but it cannot grant itself a tenant, allocation, or partition.
CREATE TABLE IF NOT EXISTS hosted_provider_nodes (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  provider_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  gpu boolean NOT NULL DEFAULT false,
  gpu_resource_id text,
  partitions text[] NOT NULL DEFAULT ARRAY['shared']::text[],
  tenant_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  allocation_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  proof_classes text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_concurrent_jobs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_jobs BETWEEN 1 AND 64),
  lease_ttl_ms bigint NOT NULL DEFAULT 60000 CHECK (lease_ttl_ms BETWEEN 5000 AND 3600000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (partitions <@ ARRAY['shared','reserved','dedicated']::text[])
);

CREATE TABLE IF NOT EXISTS hosted_node_lifecycle_operations (
  operation_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES hosted_provider_nodes(principal_id),
  onchain_node_id text NOT NULL CHECK (onchain_node_id ~ '^0x[0-9a-f]{64}$'),
  desired_state text NOT NULL CHECK (desired_state IN ('DRAINING','RETIRED')),
  idempotency_key text NOT NULL UNIQUE,
  prior_operation_id text REFERENCES hosted_node_lifecycle_operations(operation_id),
  status text NOT NULL CHECK (
    status IN ('PENDING','LEASED','RETRY','VERIFYING','APPLIED','FAILED','RECOVERY_REQUIRED')
  ),
  provider_operation_id text,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_fact_id bigint REFERENCES hosted_indexer_facts(fact_id),
  canonical_fact_block_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token bigint,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='LEASED') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((canonical_fact_id IS NULL) = (canonical_fact_block_hash IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_node_lifecycle_active_idx
  ON hosted_node_lifecycle_operations(principal_id)
  WHERE status IN ('PENDING','LEASED','RETRY','VERIFYING','RECOVERY_REQUIRED');
CREATE INDEX IF NOT EXISTS hosted_node_lifecycle_schedule_idx
  ON hosted_node_lifecycle_operations(status,next_attempt_at,created_at);
CREATE OR REPLACE FUNCTION hosted_node_lifecycle_request_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'node lifecycle operations are append-only'; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.principal_id<>OLD.principal_id
    OR NEW.onchain_node_id<>OLD.onchain_node_id OR NEW.desired_state<>OLD.desired_state
    OR NEW.idempotency_key<>OLD.idempotency_key
    OR NEW.prior_operation_id IS DISTINCT FROM OLD.prior_operation_id
    OR NEW.max_attempts<>OLD.max_attempts THEN
    RAISE EXCEPTION 'node lifecycle request identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hosted_node_lifecycle_request_immutable ON hosted_node_lifecycle_operations;
CREATE TRIGGER hosted_node_lifecycle_request_immutable
BEFORE UPDATE OR DELETE ON hosted_node_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION hosted_node_lifecycle_request_guard();

CREATE TABLE IF NOT EXISTS hosted_gpu_resource_leases (
  resource_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES hosted_provider_nodes(principal_id),
  job_id text NOT NULL UNIQUE REFERENCES hosted_prove_jobs(job_id),
  expires_at timestamptz NOT NULL,
  fence_token bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Scheduling estimates are accepted only from an audited operator profile;
-- request bodies and worker claims never set urgency or weighted-work cost.
CREATE TABLE IF NOT EXISTS hosted_proof_profiles (
  proof_class text PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  needs_gpu boolean NOT NULL,
  estimated_work numeric(78,18) NOT NULL CHECK (estimated_work > 0),
  estimated_proof_time_ms bigint NOT NULL CHECK (estimated_proof_time_ms >= 1000),
  settlement_margin_ms bigint NOT NULL CHECK (settlement_margin_ms >= 0),
  evidence jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_tenant_scheduler_state (
  tenant_id text PRIMARY KEY REFERENCES hosted_tenants(tenant_id),
  virtual_service numeric(78,18) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hosted_scheduler_global_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  virtual_time numeric(78,18) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hosted_scheduler_global_state(singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS hosted_capacity_intents (
  allocation_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  room_id numeric(20,0) NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('RESERVED','ACTIVE','RENEW','HANDOFF','RELEASED')),
  provider_node_id text,
  deadline_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL,
  execution_status text NOT NULL DEFAULT 'PENDING'
    CHECK (execution_status IN ('PENDING','LEASED','RETRY','APPLIED','FAILED')),
  applied_state text,
  provider_operation_id text,
  provider_response jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at timestamptz,
  last_error text,
  last_success_at timestamptz,
  alerted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_capacity_reconcile_idx
  ON hosted_capacity_intents(execution_status,next_attempt_at,lease_expires_at,deadline_at);
CREATE TABLE IF NOT EXISTS hosted_capacity_operations (
  operation_id bigserial PRIMARY KEY,
  allocation_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  room_id numeric(20,0) NOT NULL,
  desired_state text NOT NULL,
  provider_node_id text,
  deadline_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  prior_operation_id bigint REFERENCES hosted_capacity_operations(operation_id),
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS hosted_capacity_operations_immutable ON hosted_capacity_operations;
CREATE TRIGGER hosted_capacity_operations_immutable BEFORE UPDATE OR DELETE ON hosted_capacity_operations
FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();

CREATE TABLE IF NOT EXISTS hosted_capacity_signals (
  signal_id bigserial PRIMARY KEY,
  window_started_at timestamptz NOT NULL UNIQUE,
  queued_jobs integer NOT NULL CHECK (queued_jobs >= 0),
  queued_bytes numeric(78,0) NOT NULL CHECK (queued_bytes >= 0),
  estimated_proof_time_ms numeric(78,0) NOT NULL CHECK (estimated_proof_time_ms >= 0),
  urgent_jobs integer NOT NULL CHECK (urgent_jobs >= 0),
  reserved_jobs integer NOT NULL CHECK (reserved_jobs >= 0),
  active_gpu_resources integer NOT NULL CHECK (active_gpu_resources >= 0),
  desired_gpu_resources integer NOT NULL CHECK (desired_gpu_resources >= 0),
  stale_proof_profiles integer NOT NULL CHECK (stale_proof_profiles >= 0),
  earliest_latest_start_at timestamptz,
  scale_down_safe boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','LEASED','RETRY','SENT','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at timestamptz,
  last_error text,
  provider_response jsonb,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_capacity_signals_delivery_idx
  ON hosted_capacity_signals(status,next_attempt_at,lease_expires_at,signal_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_billing_members_job_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members
      ADD CONSTRAINT hosted_aggregate_billing_members_job_fk
      FOREIGN KEY(job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_billing_ledger'::regclass
      AND conname='hosted_billing_ledger_job_fk'
  ) THEN
    ALTER TABLE hosted_billing_ledger
      ADD CONSTRAINT hosted_billing_ledger_job_fk
      FOREIGN KEY(job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
END $$;
`

export const HOSTED_SCHEMA_V2_MIGRATION_SQL = `
DO $$
DECLARE
  current_primary_key text;
BEGIN
  UPDATE hosted_room_observations AS observation
  SET chain_id = (
    SELECT min(block.chain_id)
    FROM canonical_l1_blocks AS block
    WHERE block.canonical
      AND block.block_number = observation.head_block
      AND lower(block.block_hash) = lower(observation.head_hash)
  )
  WHERE observation.chain_id IS NULL
    AND 1 = (
      SELECT count(DISTINCT block.chain_id)
      FROM canonical_l1_blocks AS block
      WHERE block.canonical
        AND block.block_number = observation.head_block
        AND lower(block.block_hash) = lower(observation.head_hash)
    );

  IF EXISTS (SELECT 1 FROM hosted_room_observations WHERE chain_id IS NULL) THEN
    RAISE EXCEPTION 'cannot migrate room observations with an ambiguous chain';
  END IF;

  ALTER TABLE hosted_room_observations ALTER COLUMN chain_id SET NOT NULL;
  SELECT conname INTO current_primary_key
  FROM pg_constraint
  WHERE conrelid = 'hosted_room_observations'::regclass AND contype = 'p';
  IF current_primary_key IS NOT NULL THEN
    EXECUTE format('ALTER TABLE hosted_room_observations DROP CONSTRAINT %I', current_primary_key);
  END IF;
  ALTER TABLE hosted_room_observations
    ADD CONSTRAINT hosted_room_observations_pkey PRIMARY KEY(chain_id, room_id);
END $$;
`

export const HOSTED_SCHEMA_V3_MIGRATION_SQL = `
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS proof_class text;
UPDATE hosted_prove_jobs SET proof_class = endpoint WHERE proof_class IS NULL;
ALTER TABLE hosted_prove_jobs ALTER COLUMN proof_class SET NOT NULL;
CREATE TABLE IF NOT EXISTS hosted_provider_nodes (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  provider_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  gpu boolean NOT NULL DEFAULT false,
  partitions text[] NOT NULL DEFAULT ARRAY['shared']::text[],
  tenant_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  allocation_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  proof_classes text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_concurrent_jobs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_jobs BETWEEN 1 AND 64),
  lease_ttl_ms bigint NOT NULL DEFAULT 60000 CHECK (lease_ttl_ms BETWEEN 5000 AND 3600000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (partitions <@ ARRAY['shared','reserved','dedicated']::text[])
);
CREATE TABLE IF NOT EXISTS hosted_proof_profiles (
  proof_class text PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  needs_gpu boolean NOT NULL,
  estimated_work numeric(78,18) NOT NULL CHECK (estimated_work > 0),
  estimated_proof_time_ms bigint NOT NULL CHECK (estimated_proof_time_ms >= 1000),
  settlement_margin_ms bigint NOT NULL CHECK (settlement_margin_ms >= 0),
  evidence jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`

export const HOSTED_SCHEMA_V4_MIGRATION_SQL = `
ALTER TABLE hosted_sponsorships
  ADD COLUMN IF NOT EXISTS reserved_quantity numeric(78,18) NOT NULL DEFAULT 0;
ALTER TABLE hosted_sponsorships DROP CONSTRAINT IF EXISTS hosted_sponsorships_check;
ALTER TABLE hosted_sponsorships DROP CONSTRAINT IF EXISTS hosted_sponsorships_quantity_check;
ALTER TABLE hosted_sponsorships ADD CONSTRAINT hosted_sponsorships_quantity_check
  CHECK (consumed_quantity + reserved_quantity <= maximum_quantity);
CREATE TABLE IF NOT EXISTS hosted_sponsorship_reservations (
  job_id text PRIMARY KEY,
  sponsorship_id text NOT NULL REFERENCES hosted_sponsorships(sponsorship_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  quantity numeric(78,18) NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS leased_at timestamptz;
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS actual_queue_ms bigint;
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS actual_proof_ms bigint;
ALTER TABLE hosted_provider_nodes ADD COLUMN IF NOT EXISTS gpu_resource_id text;
CREATE TABLE IF NOT EXISTS hosted_gpu_resource_leases (
  resource_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES hosted_provider_nodes(principal_id),
  job_id text NOT NULL UNIQUE REFERENCES hosted_prove_jobs(job_id),
  expires_at timestamptz NOT NULL,
  fence_token bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hosted_scheduler_global_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  virtual_time numeric(78,18) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hosted_scheduler_global_state(singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;
`

export const HOSTED_SCHEMA_V5_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_rate_limit_windows (
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY(principal_id, window_start)
);
ALTER TABLE hosted_indexer_facts ADD COLUMN IF NOT EXISTS fact_key text;
UPDATE hosted_indexer_facts SET fact_key = 'legacy:' || fact_id::text WHERE fact_key IS NULL;
ALTER TABLE hosted_indexer_facts ALTER COLUMN fact_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hosted_indexer_facts_source_key_idx
  ON hosted_indexer_facts(chain_id, block_hash, fact_key);
`

export const HOSTED_SCHEMA_V6_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_room_reconciliation_queue (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  dirty boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_success_block numeric(78,0),
  last_success_hash text,
  last_error text,
  next_retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id)
);
CREATE INDEX IF NOT EXISTS hosted_room_reconciliation_order_idx
  ON hosted_room_reconciliation_queue(chain_id, dirty DESC, priority DESC, last_success_at, room_id);
INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
SELECT chain_id,room_id,true,10 FROM hosted_room_observations
ON CONFLICT (chain_id,room_id) DO NOTHING;
INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
SELECT DISTINCT chain_id,room_id,true,10 FROM hosted_indexer_facts WHERE room_id IS NOT NULL
ON CONFLICT (chain_id,room_id) DO NOTHING;
`

export const HOSTED_SCHEMA_V7_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_capacity_operations (
  operation_id bigserial PRIMARY KEY,
  allocation_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  room_id numeric(20,0) NOT NULL,
  desired_state text NOT NULL,
  provider_node_id text,
  deadline_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  prior_operation_id bigint REFERENCES hosted_capacity_operations(operation_id),
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS hosted_capacity_operations_immutable ON hosted_capacity_operations;
CREATE TRIGGER hosted_capacity_operations_immutable BEFORE UPDATE OR DELETE ON hosted_capacity_operations
FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
INSERT INTO hosted_capacity_operations(
  allocation_id,tenant_id,room_id,desired_state,provider_node_id,deadline_at,
  idempotency_key,metadata
)
SELECT allocation_id,tenant_id,room_id,desired_state,provider_node_id,deadline_at,
       idempotency_key,metadata
FROM hosted_capacity_intents
ON CONFLICT (idempotency_key) DO NOTHING;
`

export const HOSTED_SCHEMA_V8_MIGRATION_SQL = `
ALTER TABLE hosted_principals DROP CONSTRAINT IF EXISTS hosted_principals_kind_check;
ALTER TABLE hosted_principals ADD CONSTRAINT hosted_principals_kind_check
  CHECK (kind IN ('api-key', 'node', 'service'));
ALTER TABLE hosted_outbox ADD COLUMN IF NOT EXISTS audience text;
UPDATE hosted_outbox SET audience = CASE
  WHEN tenant_id IS NULL THEN 'admin-internal' ELSE 'tenant' END
WHERE audience IS NULL;
ALTER TABLE hosted_outbox ALTER COLUMN audience SET DEFAULT 'admin-internal';
ALTER TABLE hosted_outbox ALTER COLUMN audience SET NOT NULL;
ALTER TABLE hosted_outbox DROP CONSTRAINT IF EXISTS hosted_outbox_audience_check;
ALTER TABLE hosted_outbox ADD CONSTRAINT hosted_outbox_audience_check
  CHECK (audience IN ('tenant','public-chain','admin-internal'));
CREATE INDEX IF NOT EXISTS hosted_outbox_audience_event_idx
  ON hosted_outbox(audience, event_id);
`

export const HOSTED_SCHEMA_V9_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_worker_leases (
  component text PRIMARY KEY,
  worker_id text NOT NULL,
  worker_fence_token bigint NOT NULL CHECK (worker_fence_token > 0),
  coordinator_holder_id text NOT NULL,
  coordinator_fence_token bigint NOT NULL CHECK (coordinator_fence_token > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hosted_worker_leases_epoch_idx
  ON hosted_worker_leases(coordinator_holder_id, coordinator_fence_token, expires_at);
`

export const HOSTED_SCHEMA_V10_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_blob_archives (
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  versioned_hashes text[] NOT NULL,
  commitments text[] NOT NULL,
  proofs text[] NOT NULL,
  bundle_object_key text NOT NULL,
  bundle_sha256 text NOT NULL,
  signed_transaction_object_key text,
  archive_source text NOT NULL CHECK (archive_source IN ('hosted-prepublish','beacon-fallback')),
  verified_sources jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, transaction_hash),
  CHECK (cardinality(versioned_hashes) > 0),
  CHECK (cardinality(versioned_hashes) = cardinality(commitments)),
  CHECK (cardinality(versioned_hashes) = cardinality(proofs)),
  CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$')
);
DROP TRIGGER IF EXISTS hosted_blob_archives_immutable ON hosted_blob_archives;
CREATE TRIGGER hosted_blob_archives_immutable BEFORE UPDATE OR DELETE ON hosted_blob_archives
FOR EACH ROW EXECUTE FUNCTION hosted_immutable_ledger_row();
CREATE TABLE IF NOT EXISTS hosted_blob_requirements (
  requirement_id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  room_id numeric(20,0) NOT NULL,
  batch_index numeric(20,0) NOT NULL,
  blob_start_index integer NOT NULL CHECK (blob_start_index BETWEEN 0 AND 5),
  versioned_hashes text[] NOT NULL,
  commitments text[] NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VERIFIED','ERROR','RETRACTED')),
  canonical boolean NOT NULL DEFAULT true,
  last_error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at timestamptz,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id, block_hash, transaction_hash, room_id, batch_index),
  CHECK (cardinality(versioned_hashes) > 0),
  CHECK (cardinality(versioned_hashes) = cardinality(commitments))
);
CREATE INDEX IF NOT EXISTS hosted_blob_requirements_pending_idx
  ON hosted_blob_requirements(chain_id, status, block_number) WHERE canonical;
`

export const HOSTED_SCHEMA_V11_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_l1_nonce_state (
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,sender)
);
CREATE TABLE IF NOT EXISTS hosted_l1_transactions (
  operation_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  nonce numeric(78,0) NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  request_object_key text NOT NULL,
  calldata text NOT NULL,
  inclusion_deadline numeric(78,0) NOT NULL,
  transaction_hash text UNIQUE,
  raw_transaction_object_key text,
  bundle_object_key text,
  status text NOT NULL CHECK (status IN (
    'PREPARED','SIGNED','BROADCAST','INCLUDED','FINALIZED','FAILED','RECOVERY_REQUIRED'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_risk boolean NOT NULL DEFAULT false,
  block_number numeric(78,0),
  block_hash text,
  finalized_block numeric(78,0),
  finalized_hash text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id,sender,nonce),
  CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS hosted_l1_transactions_pending_idx
  ON hosted_l1_transactions(status,next_attempt_at);
CREATE OR REPLACE FUNCTION hosted_l1_transaction_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_id <> OLD.operation_id OR NEW.chain_id <> OLD.chain_id
     OR NEW.sender <> OLD.sender OR NEW.nonce <> OLD.nonce
     OR NEW.operation <> OLD.operation OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.request_object_key <> OLD.request_object_key
     OR NEW.calldata <> OLD.calldata OR NEW.inclusion_deadline <> OLD.inclusion_deadline THEN
    RAISE EXCEPTION 'hosted L1 transaction immutable fields cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hosted_l1_transactions_immutable ON hosted_l1_transactions;
CREATE TRIGGER hosted_l1_transactions_immutable BEFORE UPDATE ON hosted_l1_transactions
FOR EACH ROW EXECUTE FUNCTION hosted_l1_transaction_immutable_guard();
`

export const HOSTED_SCHEMA_V12_MIGRATION_SQL = `
ALTER TABLE hosted_l1_transactions
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS deadline_risk boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS hosted_l1_transactions_pending_idx;
CREATE INDEX hosted_l1_transactions_pending_idx
  ON hosted_l1_transactions(status,next_attempt_at);
`

export const HOSTED_SCHEMA_V13_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_l1_finality_audit_cursors (
  chain_id bigint NOT NULL,
  sender text NOT NULL,
  last_operation_id text,
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,sender)
);
`

export const HOSTED_SCHEMA_V14_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_withdrawal_epochs (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  epoch numeric(20,0) NOT NULL,
  tenant_id text REFERENCES hosted_tenants(tenant_id),
  deployment_domain text NOT NULL,
  capacity integer NOT NULL CHECK (
    capacity BETWEEN 1 AND 32768 AND (capacity & (capacity - 1)) = 0
  ),
  withdrawal_root text NOT NULL,
  source_object_key text NOT NULL,
  source_transaction_hash text NOT NULL,
  finalized_block numeric(78,0) NOT NULL,
  finalized_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('FINALIZED','RECOVERY_REQUIRED')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id, room_id, epoch)
);
CREATE INDEX IF NOT EXISTS hosted_withdrawal_epochs_finalized_idx
  ON hosted_withdrawal_epochs(chain_id, finalized_block, status);
ALTER TABLE hosted_withdrawal_claims
  ADD COLUMN IF NOT EXISTS operation_id text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS hosted_withdrawal_claims_operation_idx
  ON hosted_withdrawal_claims(operation_id) WHERE operation_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
        'hosted_withdrawal_claims_operation_fk',
        'hosted_withdrawal_claims_operation_id_fkey'
      )
      AND conrelid = 'hosted_withdrawal_claims'::regclass
  ) THEN
    ALTER TABLE hosted_withdrawal_claims
      ADD CONSTRAINT hosted_withdrawal_claims_operation_fk
      FOREIGN KEY(operation_id) REFERENCES hosted_l1_transactions(operation_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS hosted_withdrawal_claims_worker_idx
  ON hosted_withdrawal_claims(status,next_attempt_at,lease_expires_at,claim_id);
`

export const HOSTED_SCHEMA_V15_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_primary_wal_checkpoints (
  checkpoint_name text PRIMARY KEY,
  primary_holder_id text NOT NULL,
  primary_fence_token bigint NOT NULL CHECK (primary_fence_token > 0),
  target_lsn pg_lsn NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (checkpoint_name = 'coordinator-writer')
);
ALTER TABLE hosted_withdrawal_claims
  ADD COLUMN IF NOT EXISTS operation_id text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS hosted_withdrawal_claims_operation_idx
  ON hosted_withdrawal_claims(operation_id) WHERE operation_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
        'hosted_withdrawal_claims_operation_fk',
        'hosted_withdrawal_claims_operation_id_fkey'
      )
      AND conrelid = 'hosted_withdrawal_claims'::regclass
  ) THEN
    ALTER TABLE hosted_withdrawal_claims
      ADD CONSTRAINT hosted_withdrawal_claims_operation_fk
      FOREIGN KEY(operation_id) REFERENCES hosted_l1_transactions(operation_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS hosted_withdrawal_claims_worker_idx
  ON hosted_withdrawal_claims(status,next_attempt_at,lease_expires_at,claim_id);
`

export const HOSTED_SCHEMA_V16_MIGRATION_SQL = `
ALTER TABLE hosted_prove_jobs
  ADD COLUMN IF NOT EXISTS deadline_chain_id bigint,
  ADD COLUMN IF NOT EXISTS deadline_block numeric(78,0),
  ADD COLUMN IF NOT EXISTS latest_start_block numeric(78,0),
  ADD COLUMN IF NOT EXISTS deadline_fact_key text,
  ADD COLUMN IF NOT EXISTS deadline_fact_block_hash text;
-- Earlier schemas allowed a caller-scoped boolean to create global urgency.
-- Reject that trust root during migration; only canonical indexer provenance
-- populated by the v16 insertion path may set the flag again.
UPDATE hosted_prove_jobs SET deadline_trusted=false,
  deadline_chain_id=NULL,deadline_block=NULL,latest_start_block=NULL,
  deadline_fact_key=NULL,deadline_fact_block_hash=NULL
WHERE deadline_trusted OR deadline_chain_id IS NOT NULL OR deadline_block IS NOT NULL
  OR latest_start_block IS NOT NULL OR deadline_fact_key IS NOT NULL
  OR deadline_fact_block_hash IS NOT NULL;
ALTER TABLE hosted_prove_jobs DROP CONSTRAINT IF EXISTS hosted_prove_jobs_trusted_deadline_source;
ALTER TABLE hosted_prove_jobs ADD CONSTRAINT hosted_prove_jobs_trusted_deadline_source CHECK (
  NOT deadline_trusted OR (
    deadline_chain_id IS NOT NULL AND deadline_block IS NOT NULL
    AND latest_start_block IS NOT NULL AND deadline_fact_key IS NOT NULL
    AND deadline_fact_block_hash IS NOT NULL AND deadline_at IS NOT NULL
    AND latest_start_at IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS hosted_prove_jobs_deadline_source_idx
  ON hosted_prove_jobs(deadline_chain_id,deadline_fact_block_hash,deadline_fact_key)
  WHERE deadline_trusted;
`

export const HOSTED_SCHEMA_V17_MIGRATION_SQL = `
ALTER TABLE hosted_capacity_intents
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS applied_state text,
  ADD COLUMN IF NOT EXISTS provider_operation_id text,
  ADD COLUMN IF NOT EXISTS provider_response jsonb,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
-- A process-local executor from an older build cannot own a durable lease.
-- Return any ambiguous in-flight row to the retry queue during the upgrade.
UPDATE hosted_capacity_intents SET execution_status='RETRY',lease_owner=NULL,
  lease_expires_at=NULL,next_attempt_at=clock_timestamp(),
  last_error=COALESCE(last_error,'capacity executor upgraded before acknowledgement')
WHERE execution_status='LEASED';
ALTER TABLE hosted_capacity_intents
  DROP CONSTRAINT IF EXISTS hosted_capacity_execution_status_check,
  DROP CONSTRAINT IF EXISTS hosted_capacity_applied_state_check,
  DROP CONSTRAINT IF EXISTS hosted_capacity_max_attempts_check,
  DROP CONSTRAINT IF EXISTS hosted_capacity_lease_token_check;
ALTER TABLE hosted_capacity_intents
  ADD CONSTRAINT hosted_capacity_execution_status_check CHECK (
    execution_status IN ('PENDING','LEASED','RETRY','APPLIED','FAILED')
  ),
  ADD CONSTRAINT hosted_capacity_applied_state_check CHECK (
    applied_state IS NULL OR applied_state IN ('RESERVED','ACTIVE','RENEW','HANDOFF','RELEASED')
  ),
  ADD CONSTRAINT hosted_capacity_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 100),
  ADD CONSTRAINT hosted_capacity_lease_token_check CHECK (lease_token >= 0);
DROP INDEX IF EXISTS hosted_capacity_reconcile_idx;
CREATE INDEX hosted_capacity_reconcile_idx
  ON hosted_capacity_intents(execution_status,next_attempt_at,lease_expires_at,deadline_at);
`

export const HOSTED_SCHEMA_V18_MIGRATION_SQL = `
-- v18 separates resource telemetry from finality-gated commercial billing.
-- HOSTED_SCHEMA_SQL creates the append-only tables before this migration;
-- these statements make upgrades from a partially applied candidate converge.
ALTER TABLE hosted_refunds ADD COLUMN IF NOT EXISTS billing_entry_id bigint;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_refunds'::regclass
      AND conname='hosted_refunds_billing_entry_fk'
  ) THEN
    ALTER TABLE hosted_refunds ADD CONSTRAINT hosted_refunds_billing_entry_fk
      FOREIGN KEY(billing_entry_id) REFERENCES hosted_billing_ledger(entry_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_billing_members_job_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members
      ADD CONSTRAINT hosted_aggregate_billing_members_job_fk
      FOREIGN KEY(job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_billing_ledger'::regclass
      AND conname='hosted_billing_ledger_job_fk'
  ) THEN
    ALTER TABLE hosted_billing_ledger
      ADD CONSTRAINT hosted_billing_ledger_job_fk
      FOREIGN KEY(job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
END $$;
`

export const HOSTED_SCHEMA_V19_MIGRATION_SQL = `
-- v19 binds commercial effects to an accepted quote, exact proof result and
-- pre-broadcast durable L1 operation. Existing unbound manifests cannot be
-- assigned trustworthy provenance after the fact, so upgrades fail closed.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM hosted_aggregate_billing_manifests
    WHERE operation_id IS NULL OR transaction_hash IS NULL OR destination_address IS NULL
       OR request_hash IS NULL OR calldata_hash IS NULL
  ) OR EXISTS (
    SELECT 1 FROM hosted_aggregate_billing_members
    WHERE result_object_key IS NULL OR result_digest IS NULL OR payer_tenant_id IS NULL
       OR price_id IS NULL OR unit_price IS NULL OR currency IS NULL
       OR price_effective_from IS NULL OR quote_accepted_at IS NULL
       OR maximum_charge_amount IS NULL OR maximum_charge_currency IS NULL
  ) THEN
    RAISE EXCEPTION 'schema 19 refuses to invent provenance or quotes for legacy aggregate manifests';
  END IF;
END $$;

ALTER TABLE hosted_sponsorship_reservations ALTER COLUMN unit SET NOT NULL;
ALTER TABLE hosted_aggregate_billing_manifests
  ALTER COLUMN operation_id SET NOT NULL,
  ALTER COLUMN transaction_hash SET NOT NULL,
  ALTER COLUMN destination_address SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ALTER COLUMN calldata_hash SET NOT NULL;
ALTER TABLE hosted_aggregate_billing_members
  ALTER COLUMN result_object_key SET NOT NULL,
  ALTER COLUMN result_digest SET NOT NULL,
  ALTER COLUMN payer_tenant_id SET NOT NULL,
  ALTER COLUMN price_id SET NOT NULL,
  ALTER COLUMN unit_price SET NOT NULL,
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN price_effective_from SET NOT NULL,
  ALTER COLUMN quote_accepted_at SET NOT NULL,
  ALTER COLUMN maximum_charge_amount SET NOT NULL,
  ALTER COLUMN maximum_charge_currency SET NOT NULL;

ALTER TABLE hosted_prove_jobs DROP CONSTRAINT IF EXISTS hosted_prove_jobs_quote_complete;
ALTER TABLE hosted_prove_jobs ADD CONSTRAINT hosted_prove_jobs_quote_complete CHECK (
  (maximum_charge_amount IS NULL AND maximum_charge_currency IS NULL
    AND payer_tenant_id IS NULL AND quote_price_id IS NULL
    AND quote_unit_price IS NULL AND quote_currency IS NULL
    AND quote_effective_from IS NULL AND quote_accepted_at IS NULL)
  OR
  (maximum_charge_amount IS NOT NULL AND maximum_charge_currency IS NOT NULL
    AND payer_tenant_id IS NOT NULL AND quote_price_id IS NOT NULL
    AND quote_unit_price IS NOT NULL AND quote_currency IS NOT NULL
    AND quote_effective_from IS NOT NULL AND quote_accepted_at IS NOT NULL
    AND maximum_charge_currency = quote_currency)
);
ALTER TABLE hosted_aggregate_billing_members
  DROP CONSTRAINT IF EXISTS hosted_aggregate_billing_members_chain_id_aggregate_hash_job_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS hosted_aggregate_billing_job_unique_idx
  ON hosted_aggregate_billing_members(job_id);
DROP INDEX IF EXISTS hosted_invoice_exports_period_idx;
CREATE UNIQUE INDEX hosted_invoice_exports_period_idx
  ON hosted_invoice_exports(tenant_id,period_start,period_end,currency)
  WHERE supersedes_invoice_id IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_manifests'::regclass
      AND conname='hosted_aggregate_manifests_operation_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_manifests ADD CONSTRAINT hosted_aggregate_manifests_operation_fk
      FOREIGN KEY(operation_id) REFERENCES hosted_l1_transactions(operation_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_members_price_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members ADD CONSTRAINT hosted_aggregate_members_price_fk
      FOREIGN KEY(price_id) REFERENCES hosted_billing_prices(price_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_members_sla_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members ADD CONSTRAINT hosted_aggregate_members_sla_fk
      FOREIGN KEY(sla_policy_id) REFERENCES hosted_sla_policies(policy_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_outcome_retractions'::regclass
      AND conname='hosted_aggregate_retractions_correction_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_outcome_retractions ADD CONSTRAINT hosted_aggregate_retractions_correction_fk
      FOREIGN KEY(correction_entry_id) REFERENCES hosted_billing_ledger(entry_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_invoice_exports'::regclass
      AND conname IN ('hosted_invoice_exports_supersedes_fk','hosted_invoice_exports_supersedes_invoice_id_fkey')
  ) THEN
    ALTER TABLE hosted_invoice_exports ADD CONSTRAINT hosted_invoice_exports_supersedes_fk
      FOREIGN KEY(supersedes_invoice_id) REFERENCES hosted_invoice_exports(invoice_id);
  END IF;
END $$;
`

export const HOSTED_SCHEMA_V20_MIGRATION_SQL = `
-- v20 makes a post-finality surprise recoverable only through an explicit,
-- independently corroborated replacement branch and a second archive gate.
ALTER TABLE hosted_l1_transactions
  DROP CONSTRAINT IF EXISTS hosted_l1_transactions_status_check;
ALTER TABLE hosted_l1_transactions
  ADD CONSTRAINT hosted_l1_transactions_status_check CHECK (status IN (
    'PREPARED','SIGNED','BROADCAST','INCLUDED','FINALIZED','FAILED',
    'RECOVERY_REQUIRED','SUPERSEDED'
  ));
CREATE TABLE IF NOT EXISTS hosted_post_finality_recoveries (
  recovery_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES hosted_l1_transactions(operation_id),
  prior_floor_number numeric(78,0) NOT NULL,
  prior_floor_hash text NOT NULL,
  branch_start_number numeric(78,0) NOT NULL,
  branch_blocks jsonb NOT NULL,
  required_indexer_sources text[] NOT NULL CHECK (cardinality(required_indexer_sources) > 0),
  verified_sources jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('BRANCH_INSTALLED','RESOLVED')),
  replacement_floor_number numeric(78,0),
  replacement_floor_hash text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK (
    (status='BRANCH_INSTALLED' AND replacement_floor_number IS NULL
      AND replacement_floor_hash IS NULL AND resolved_at IS NULL)
    OR
    (status='RESOLVED' AND replacement_floor_number IS NOT NULL
      AND replacement_floor_hash IS NOT NULL AND resolved_at IS NOT NULL)
  )
);
`

export const HOSTED_SCHEMA_V21_MIGRATION_SQL = `
-- v21 pins allocation attribution to one immutable canonical source fact and
-- records agreed receipt cost units separately from quoted proof-work.
ALTER TABLE hosted_l1_transactions
  ADD COLUMN IF NOT EXISTS gas_used numeric(78,0),
  ADD COLUMN IF NOT EXISTS effective_gas_price numeric(78,0),
  ADD COLUMN IF NOT EXISTS blob_gas_used numeric(78,0),
  ADD COLUMN IF NOT EXISTS blob_gas_price numeric(78,0);
ALTER TABLE hosted_l1_transactions
  DROP CONSTRAINT IF EXISTS hosted_l1_transactions_gas_used_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_transactions_effective_gas_price_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_transactions_blob_gas_used_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_transactions_blob_gas_price_check;
ALTER TABLE hosted_l1_transactions
  ADD CONSTRAINT hosted_l1_transactions_gas_used_check CHECK (gas_used IS NULL OR gas_used >= 0),
  ADD CONSTRAINT hosted_l1_transactions_effective_gas_price_check CHECK (effective_gas_price IS NULL OR effective_gas_price >= 0),
  ADD CONSTRAINT hosted_l1_transactions_blob_gas_used_check CHECK (blob_gas_used IS NULL OR blob_gas_used >= 0),
  ADD CONSTRAINT hosted_l1_transactions_blob_gas_price_check CHECK (blob_gas_price IS NULL OR blob_gas_price >= 0);

CREATE OR REPLACE FUNCTION hosted_l1_transaction_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_id <> OLD.operation_id OR NEW.chain_id <> OLD.chain_id
     OR NEW.sender <> OLD.sender OR NEW.nonce <> OLD.nonce
     OR NEW.operation <> OLD.operation OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.request_object_key <> OLD.request_object_key
     OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
     OR NEW.calldata <> OLD.calldata OR NEW.inclusion_deadline <> OLD.inclusion_deadline
     OR (OLD.gas_used IS NOT NULL AND NEW.gas_used IS DISTINCT FROM OLD.gas_used)
     OR (OLD.effective_gas_price IS NOT NULL AND NEW.effective_gas_price IS DISTINCT FROM OLD.effective_gas_price)
     OR (OLD.blob_gas_used IS NOT NULL AND NEW.blob_gas_used IS DISTINCT FROM OLD.blob_gas_used)
     OR (OLD.blob_gas_price IS NOT NULL AND NEW.blob_gas_price IS DISTINCT FROM OLD.blob_gas_price) THEN
    RAISE EXCEPTION 'hosted L1 transaction immutable fields cannot be changed';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE hosted_aggregate_billing_members
  ADD COLUMN IF NOT EXISTS allocation_fact_id bigint,
  ADD COLUMN IF NOT EXISTS allocation_fact_block_hash text;
UPDATE hosted_aggregate_billing_members AS member SET
  (allocation_fact_id,allocation_fact_block_hash) = (
    SELECT fact.fact_id,fact.block_hash
    FROM hosted_indexer_facts AS fact
    WHERE fact.chain_id=member.chain_id AND fact.canonical
      AND fact.payload #>> '{provenance,eventName}' IN ('AllocationUsed','AllocationRenewed')
      AND fact.payload #>> '{args,roomId}'=member.room_id::text
      AND lower(COALESCE(fact.payload #>> '{args,allocationId}',fact.payload #>> '{args,newAllocationId}'))
          =lower(member.allocation_id)
    ORDER BY fact.block_number DESC,fact.fact_id DESC LIMIT 1
  )
WHERE member.allocation_id IS NOT NULL AND member.allocation_fact_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='hosted_aggregate_billing_members'::regclass
      AND conname='hosted_aggregate_members_allocation_fact_fk'
  ) THEN
    ALTER TABLE hosted_aggregate_billing_members
      ADD CONSTRAINT hosted_aggregate_members_allocation_fact_fk
      FOREIGN KEY(allocation_fact_id) REFERENCES hosted_indexer_facts(fact_id);
  END IF;
END $$;
ALTER TABLE hosted_aggregate_billing_members
  DROP CONSTRAINT IF EXISTS hosted_aggregate_members_allocation_binding_check;
ALTER TABLE hosted_aggregate_billing_members
  ADD CONSTRAINT hosted_aggregate_members_allocation_binding_check CHECK (
    (allocation_id IS NULL AND allocation_fact_id IS NULL AND allocation_fact_block_hash IS NULL)
    OR (allocation_id IS NOT NULL AND allocation_fact_id IS NOT NULL AND allocation_fact_block_hash IS NOT NULL)
  );

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='hosted_billing_ledger'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%entry_kind%'
  LOOP
    EXECUTE format('ALTER TABLE hosted_billing_ledger DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;
ALTER TABLE hosted_billing_ledger
  ADD CONSTRAINT hosted_billing_entry_kind_check CHECK (
    entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE','REORG_CREDIT','REFUND','SLA_CREDIT')
  ),
  ADD CONSTRAINT hosted_billing_sign_check CHECK (
    (entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE') AND quantity > 0 AND (amount IS NULL OR amount >= 0))
    OR (entry_kind NOT IN ('CHARGE','L1_ALLOCATION_CHARGE') AND quantity < 0 AND (amount IS NULL OR amount <= 0))
  ),
  ADD CONSTRAINT hosted_billing_reversal_check CHECK (
    (reverses_entry_id IS NULL) = (entry_kind IN ('CHARGE','L1_ALLOCATION_CHARGE'))
  );
`

export const HOSTED_SCHEMA_V22_MIGRATION_SQL = `
ALTER TABLE hosted_prove_jobs ADD COLUMN IF NOT EXISTS retry_of_job_id text;
CREATE UNIQUE INDEX IF NOT EXISTS hosted_prove_jobs_one_retry_per_job_idx
  ON hosted_prove_jobs(retry_of_job_id) WHERE retry_of_job_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_prove_jobs'::regclass
      AND conname='hosted_prove_jobs_retry_of_fk'
  ) THEN
    ALTER TABLE hosted_prove_jobs
      ADD CONSTRAINT hosted_prove_jobs_retry_of_fk
      FOREIGN KEY (retry_of_job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
END $$;

ALTER TABLE hosted_sponsorship_reservations
  ADD COLUMN IF NOT EXISTS transferred_to_job_id text;
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='hosted_sponsorship_reservations'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format(
      'ALTER TABLE hosted_sponsorship_reservations DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;
ALTER TABLE hosted_sponsorship_reservations
  ADD CONSTRAINT hosted_sponsorship_reservation_status_check CHECK (
    status IN ('RESERVED','CONSUMED','RELEASED','TRANSFERRED')
  ),
  ADD CONSTRAINT hosted_sponsorship_reservation_transfer_check CHECK (
    (status='TRANSFERRED') = (transferred_to_job_id IS NOT NULL)
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hosted_sponsorship_reservations'::regclass
      AND conname='hosted_sponsorship_reservation_transfer_fk'
  ) THEN
    ALTER TABLE hosted_sponsorship_reservations
      ADD CONSTRAINT hosted_sponsorship_reservation_transfer_fk
      FOREIGN KEY (transferred_to_job_id) REFERENCES hosted_prove_jobs(job_id);
  END IF;
END $$;
`

export const HOSTED_SCHEMA_V23_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_node_lifecycle_operations (
  operation_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES hosted_provider_nodes(principal_id),
  onchain_node_id text NOT NULL CHECK (onchain_node_id ~ '^0x[0-9a-f]{64}$'),
  desired_state text NOT NULL CHECK (desired_state IN ('DRAINING','RETIRED')),
  idempotency_key text NOT NULL UNIQUE,
  prior_operation_id text REFERENCES hosted_node_lifecycle_operations(operation_id),
  status text NOT NULL CHECK (
    status IN ('PENDING','LEASED','RETRY','VERIFYING','APPLIED','FAILED','RECOVERY_REQUIRED')
  ),
  provider_operation_id text,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_fact_id bigint REFERENCES hosted_indexer_facts(fact_id),
  canonical_fact_block_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token bigint,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='LEASED') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((canonical_fact_id IS NULL) = (canonical_fact_block_hash IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_node_lifecycle_active_idx
  ON hosted_node_lifecycle_operations(principal_id)
  WHERE status IN ('PENDING','LEASED','RETRY','VERIFYING','RECOVERY_REQUIRED');
CREATE INDEX IF NOT EXISTS hosted_node_lifecycle_schedule_idx
  ON hosted_node_lifecycle_operations(status,next_attempt_at,created_at);
CREATE OR REPLACE FUNCTION hosted_node_lifecycle_request_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'node lifecycle operations are append-only'; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.principal_id<>OLD.principal_id
    OR NEW.onchain_node_id<>OLD.onchain_node_id OR NEW.desired_state<>OLD.desired_state
    OR NEW.idempotency_key<>OLD.idempotency_key
    OR NEW.prior_operation_id IS DISTINCT FROM OLD.prior_operation_id
    OR NEW.max_attempts<>OLD.max_attempts THEN
    RAISE EXCEPTION 'node lifecycle request identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hosted_node_lifecycle_request_immutable ON hosted_node_lifecycle_operations;
CREATE TRIGGER hosted_node_lifecycle_request_immutable
BEFORE UPDATE OR DELETE ON hosted_node_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION hosted_node_lifecycle_request_guard();
`

export const HOSTED_SCHEMA_V24_MIGRATION_SQL = `
ALTER TABLE hosted_l1_transactions
  ADD COLUMN IF NOT EXISTS receipt_provider_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS receipt_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_canonical boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS hosted_l1_service_bindings (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  binding_kind text NOT NULL CHECK (binding_kind IN ('node-liveness','room-submit')),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  expected_sender text NOT NULL CHECK (expected_sender ~ '^0x[0-9a-f]{40}$'),
  node_id text CHECK (node_id IS NULL OR node_id ~ '^0x[0-9a-f]{64}$'),
  room_id numeric(20,0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (binding_kind='node-liveness' AND node_id IS NOT NULL AND room_id IS NULL)
    OR (binding_kind='room-submit' AND node_id IS NULL AND room_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS hosted_l1_operation_access (
  operation_id text PRIMARY KEY REFERENCES hosted_l1_transactions(operation_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  correlation_id text NOT NULL,
  minimum_confirmations integer NOT NULL CHECK (minimum_confirmations BETWEEN 1 AND 4096),
  require_finalized boolean NOT NULL,
  binding_kind text NOT NULL CHECK (binding_kind IN ('node-liveness','room-submit')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`

export const HOSTED_SCHEMA_V25_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_room_proving_policies (
  chain_id bigint NOT NULL,
  room_id numeric(20,0) NOT NULL,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  policy jsonb NOT NULL,
  object_key text NOT NULL,
  object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
  bound_block numeric(78,0) NOT NULL,
  bound_hash text NOT NULL CHECK (bound_hash ~ '^0x[0-9a-f]{64}$'),
  principal_id text NOT NULL REFERENCES hosted_principals(principal_id),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(chain_id,room_id),
  UNIQUE(chain_id,room_id,policy_hash)
);
`

export const HOSTED_SCHEMA_V26_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS hosted_wallet_challenges (
  challenge_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  allocation_id text NOT NULL CHECK (allocation_id ~ '^0x[0-9a-f]{64}$'),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  domain text NOT NULL,
  uri text NOT NULL,
  nonce_hash bytea NOT NULL UNIQUE,
  message text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL,
  session_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,idempotency_key),
  CHECK (session_expires_at > expires_at)
);
CREATE INDEX IF NOT EXISTS hosted_wallet_challenges_expiry_idx
  ON hosted_wallet_challenges(expires_at,used_at);

CREATE TABLE IF NOT EXISTS hosted_wallet_sessions (
  principal_id text PRIMARY KEY REFERENCES hosted_principals(principal_id),
  challenge_id text NOT NULL UNIQUE REFERENCES hosted_wallet_challenges(challenge_id),
  tenant_id text NOT NULL REFERENCES hosted_tenants(tenant_id),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  allocation_id text NOT NULL CHECK (allocation_id ~ '^0x[0-9a-f]{64}$'),
  room_id numeric(20,0) NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  authority_fact_id bigint NOT NULL REFERENCES hosted_indexer_facts(fact_id),
  authority_fact_block_hash text NOT NULL CHECK (authority_fact_block_hash ~ '^0x[0-9a-f]{64}$'),
  authority_head_block numeric(78,0) NOT NULL,
  authority_head_hash text NOT NULL CHECK (authority_head_hash ~ '^0x[0-9a-f]{64}$'),
  verification_request_hash text NOT NULL CHECK (verification_request_hash ~ '^[0-9a-f]{64}$'),
  verification_idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,verification_idempotency_key)
);
CREATE INDEX IF NOT EXISTS hosted_wallet_sessions_scope_idx
  ON hosted_wallet_sessions(tenant_id,chain_id,allocation_id,expires_at);
`

export const HOSTED_SCHEMA_V27_MIGRATION_SQL = `
ALTER TABLE hosted_l1_service_bindings
  ADD COLUMN IF NOT EXISTS sponsorship_id text,
  ADD COLUMN IF NOT EXISTS allocation_id text;
ALTER TABLE hosted_l1_service_bindings
  DROP CONSTRAINT IF EXISTS hosted_l1_service_bindings_binding_kind_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_service_bindings_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_service_bindings_allocation_id_check,
  DROP CONSTRAINT IF EXISTS hosted_l1_service_bindings_scope_check;
ALTER TABLE hosted_l1_service_bindings
  ADD CONSTRAINT hosted_l1_service_bindings_binding_kind_check CHECK (binding_kind IN (
    'node-liveness','room-submit','room-aggregate','pool-sponsor','pool-finality-oracle','pool-beneficiary'
  )),
  ADD CONSTRAINT hosted_l1_service_bindings_allocation_id_check
    CHECK (allocation_id IS NULL OR allocation_id ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT hosted_l1_service_bindings_scope_check CHECK (
    (binding_kind='node-liveness' AND node_id IS NOT NULL AND room_id IS NULL
      AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='room-submit' AND node_id IS NULL AND room_id IS NOT NULL
      AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='room-aggregate' AND node_id IS NULL AND room_id IS NULL
      AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-sponsor' AND node_id IS NULL AND room_id IS NULL
      AND sponsorship_id IS NOT NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-finality-oracle' AND node_id IS NULL AND room_id IS NOT NULL
      AND sponsorship_id IS NULL AND allocation_id IS NULL)
    OR (binding_kind='pool-beneficiary' AND node_id IS NULL AND room_id IS NULL
      AND sponsorship_id IS NULL AND allocation_id IS NOT NULL)
  );
ALTER TABLE hosted_l1_operation_access
  DROP CONSTRAINT IF EXISTS hosted_l1_operation_access_binding_kind_check;
ALTER TABLE hosted_l1_operation_access
  ADD CONSTRAINT hosted_l1_operation_access_binding_kind_check CHECK (binding_kind IN (
    'node-liveness','room-submit','room-aggregate','pool-sponsor','pool-finality-oracle','pool-beneficiary'
  ));
`

export const HOSTED_SCHEMA_V28_MIGRATION_SQL = `
ALTER TABLE hosted_l1_transactions
  ADD COLUMN IF NOT EXISTS transport_request_hash text,
  ADD COLUMN IF NOT EXISTS transport_request_object_key text;
ALTER TABLE hosted_l1_transactions DROP CONSTRAINT IF EXISTS hosted_l1_transactions_transport_request_check;
ALTER TABLE hosted_l1_transactions ADD CONSTRAINT hosted_l1_transactions_transport_request_check CHECK (
  (transport_request_hash IS NULL AND transport_request_object_key IS NULL)
  OR (transport_request_hash ~ '^[0-9a-f]{64}$' AND transport_request_object_key IS NOT NULL)
);
CREATE OR REPLACE FUNCTION hosted_l1_transaction_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_id <> OLD.operation_id OR NEW.chain_id <> OLD.chain_id
     OR NEW.sender <> OLD.sender OR NEW.nonce <> OLD.nonce
     OR NEW.operation <> OLD.operation OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.request_object_key <> OLD.request_object_key
     OR NEW.transport_request_hash IS DISTINCT FROM OLD.transport_request_hash
     OR NEW.transport_request_object_key IS DISTINCT FROM OLD.transport_request_object_key
     OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
     OR NEW.calldata <> OLD.calldata OR NEW.inclusion_deadline <> OLD.inclusion_deadline
     OR (OLD.gas_used IS NOT NULL AND NEW.gas_used IS DISTINCT FROM OLD.gas_used)
     OR (OLD.effective_gas_price IS NOT NULL AND NEW.effective_gas_price IS DISTINCT FROM OLD.effective_gas_price)
     OR (OLD.blob_gas_used IS NOT NULL AND NEW.blob_gas_used IS DISTINCT FROM OLD.blob_gas_used)
     OR (OLD.blob_gas_price IS NOT NULL AND NEW.blob_gas_price IS DISTINCT FROM OLD.blob_gas_price) THEN
    RAISE EXCEPTION 'hosted L1 transaction immutable fields cannot be changed';
  END IF;
  RETURN NEW;
END $$;
`

export class HostedFenceError extends Error {
  constructor(message = 'coordinator lease is absent, expired, or fenced') {
    super(message)
    this.name = 'HostedFenceError'
  }
}

export class HostedPromotionError extends Error {
  constructor(
    readonly code:
      | 'database-read-only'
      | 'schema-mismatch'
      | 'checkpoint-missing'
      | 'checkpoint-stale'
      | 'checkpoint-lease-mismatch'
      | 'replay-position-missing'
      | 'replay-behind',
    message: string,
  ) {
    super(message)
    this.name = 'HostedPromotionError'
  }
}

function walLsnValue(value: string): bigint {
  const match = /^([0-9a-f]+)\/([0-9a-f]+)$/i.exec(value)
  if (!match) throw new HostedPromotionError('replay-position-missing', 'PostgreSQL returned a malformed WAL LSN')
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`)
}

/**
 * Pure promotion policy used by the transactional store and adversarial tests.
 * The target is never supplied by an HTTP caller: it comes from the durable
 * heartbeat row written by the previously fenced primary.
 */
export function verifyReplicationPromotion(input: {
  acceptingWrites: boolean
  schemaVersion: number
  expectedSchemaVersion: number
  targetLsn: string | null
  replayLsn: string | null
  checkpointRecordedAt: string | null
  checkedAt: string
  maximumCheckpointAgeMs: number
  previousHolderId: string
  previousFenceToken: string
}): ReplicationPromotionEvidence {
  if (!input.acceptingWrites) {
    throw new HostedPromotionError('database-read-only', 'database is still in recovery and cannot be promoted')
  }
  if (input.schemaVersion !== input.expectedSchemaVersion) {
    throw new HostedPromotionError('schema-mismatch', 'database schema is not ready for promotion')
  }
  if (!input.targetLsn || !input.checkpointRecordedAt) {
    throw new HostedPromotionError('checkpoint-missing', 'primary WAL target checkpoint is missing')
  }
  if (!input.replayLsn) {
    throw new HostedPromotionError(
      'replay-position-missing',
      'database has no standby replay LSN; promotion cannot prove replication catch-up',
    )
  }
  const checkedAt = Date.parse(input.checkedAt)
  const recordedAt = Date.parse(input.checkpointRecordedAt)
  if (!Number.isFinite(checkedAt) || !Number.isFinite(recordedAt)) {
    throw new HostedPromotionError('checkpoint-missing', 'primary WAL checkpoint timestamp is malformed')
  }
  const checkpointAgeMs = checkedAt - recordedAt
  if (checkpointAgeMs < 0 || checkpointAgeMs > input.maximumCheckpointAgeMs) {
    throw new HostedPromotionError(
      'checkpoint-stale',
      `primary WAL checkpoint age ${checkpointAgeMs}ms exceeds the promotion freshness gate`,
    )
  }
  if (walLsnValue(input.replayLsn) < walLsnValue(input.targetLsn)) {
    throw new HostedPromotionError(
      'replay-behind',
      `standby replay LSN ${input.replayLsn} is behind primary target ${input.targetLsn}`,
    )
  }
  return {
    targetLsn: input.targetLsn,
    replayLsn: input.replayLsn,
    checkpointRecordedAt: new Date(recordedAt).toISOString(),
    checkedAt: new Date(checkedAt).toISOString(),
    checkpointAgeMs,
    previousHolderId: input.previousHolderId,
    previousFenceToken: input.previousFenceToken,
  }
}

export class HostedAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostedAuthError'
  }
}

export type HostedL1TransactionStatus =
  | 'PREPARED'
  | 'SIGNED'
  | 'BROADCAST'
  | 'INCLUDED'
  | 'FINALIZED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'
  | 'SUPERSEDED'

export interface HostedL1Transaction {
  operationId: string
  chainId: number
  sender: `0x${string}`
  nonce: string
  operation: string
  idempotencyKey: string
  requestHash: string
  requestObjectKey: string
  transportRequestHash: string | null
  transportRequestObjectKey: string | null
  destinationAddress: `0x${string}` | null
  calldata: `0x${string}`
  inclusionDeadline: string
  transactionHash: `0x${string}` | null
  rawTransactionObjectKey: string | null
  bundleObjectKey: string | null
  status: HostedL1TransactionStatus
  attempts: number
  lastAttemptAt: string | null
  nextAttemptAt: string
  deadlineRisk: boolean
  blockNumber: string | null
  blockHash: `0x${string}` | null
  gasUsed: string | null
  effectiveGasPrice: string | null
  blobGasUsed: string | null
  blobGasPrice: string | null
  receiptProviderIds: string[]
  receiptObservedAt: string | null
  receiptCanonical: boolean
  finalizedBlock: string | null
  finalizedHash: `0x${string}` | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type HostedL1BindingKind =
  | 'node-liveness'
  | 'room-submit'
  | 'room-aggregate'
  | 'pool-sponsor'
  | 'pool-finality-oracle'
  | 'pool-beneficiary'

export const HOSTED_L1_BINDING_ROLE:Readonly<Record<HostedL1BindingKind,HostedRole>>={
  'node-liveness':'l1-liveness',
  'room-submit':'l1-room-submit',
  'room-aggregate':'l1-aggregate-submit',
  'pool-sponsor':'l1-pool-sponsor',
  'pool-finality-oracle':'l1-pool-finality-oracle',
  'pool-beneficiary':'l1-pool-beneficiary',
}

export interface HostedL1ServiceBinding {
  principalId: string
  bindingKind: HostedL1BindingKind
  chainId: number
  contractAddress: `0x${string}`
  expectedSender: `0x${string}`
  nodeId: `0x${string}` | null
  roomId: string | null
  sponsorshipId: string | null
  allocationId: `0x${string}` | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface HostedL1OperationAccess {
  operationId: string
  tenantId: string
  principalId: string
  correlationId: string
  minimumConfirmations: number
  requireFinalized: boolean
  bindingKind: HostedL1BindingKind
  createdAt: string
}

export interface HostedWithdrawalClaim {
  claimId: string
  chainId: number
  roomId: string
  epoch: string
  withdrawalIndex: string
  tenantId: string
  idempotencyKey: string
  operationId: string | null
  transactionHash: `0x${string}` | null
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'RETRACTED'
  leaseOwner: string | null
  leaseExpiresAt: string | null
  attempts: number
  nextAttemptAt: string
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface FinalizedWithdrawalEpochInput {
  chainId: number
  roomId: string
  epoch: string
  deploymentDomain: `0x${string}`
  capacity: number
  withdrawalRoot: `0x${string}`
  sourceObjectKey: string
  records: Array<{
    index: string
    approverEpoch: string
    recipient: `0x${string}`
    asset: `0x${string}`
    amount: string
    leafHash: `0x${string}`
    positionalProof: `0x${string}`[]
  }>
}

export class CanonicalParentMissingError extends Error {
  constructor(
    readonly chainId: number,
    readonly blockNumber: string,
    readonly parentHash: string,
  ) {
    super(`canonical parent ${parentHash} for chain ${chainId} block ${blockNumber} is missing`)
    this.name = 'CanonicalParentMissingError'
  }
}

export type OutboxRetentionClass = 'transient' | 'audit' | 'safety'

/**
 * Safety events point at state needed to recover from a fork, crash, or
 * external side effect. They stay until an operator/reconciler explicitly
 * resolves them. Audit and billing events receive the longer one-year tier;
 * progress/heartbeat traffic is transient.
 */
export function outboxRetentionClass(topic: string): OutboxRetentionClass {
  if (
    topic.startsWith('admission.')
    || topic === 'indexer.rollback'
    || topic === 'indexer.anchor'
    || topic === 'indexer.floor'
    || topic === 'statusRetracted'
    || topic === 'room.observation'
    || topic === 'capacity.intent'
    || topic === 'billing.aggregate-member-retraction-deferred'
    || topic === 'post-finality.recovery-branch-installed'
    || topic === 'post-finality.recovery-resolved'
  ) return 'safety'
  if (
    topic.startsWith('queue.progress')
    || topic.startsWith('coordinator.heartbeat')
    || topic.startsWith('node.heartbeat')
  ) return 'transient'
  return 'audit'
}

export interface CanonicalJournalRow {
  number: string
  hash: string
  parentHash: string
}

export interface CanonicalIngestionPlan {
  rollbackFrom: string | null
  commonAncestorNumber: string | null
  commonAncestorHash: string | null
}

export interface CanonicalAnchor {
  chainId: number
  number: string
  hash: string
  verifiedSources: string[]
}

export interface PostFinalityRecovery {
  recoveryId: string
  chainId: number
  operationId: string
  priorFloor: { number: string; hash: `0x${string}` }
  branchStartNumber: string
  branchBlocks: CanonicalBlockInput[]
  requiredIndexerSources: string[]
  verifiedSources: { install: string[]; finalize?: string[] }
  status: 'BRANCH_INSTALLED' | 'RESOLVED'
  replacementFloor: { number: string; hash: `0x${string}` } | null
  reason: string
  createdAt: string
  resolvedAt: string | null
}

/**
 * Validate an ordered candidate branch against a canonical journal and find
 * the first divergent height. A caller receiving only a remote head must
 * backfill its ancestry until the first candidate's parent is canonical;
 * deleting on an unknown parent would make a transient RPC fault destructive.
 */
export function planCanonicalIngestion(
  chainId: number,
  existing: CanonicalJournalRow[],
  candidates: CanonicalBlockInput[],
  anchor: CanonicalAnchor | null = null,
): CanonicalIngestionPlan {
  if (candidates.length === 0) throw new Error('canonical block batch cannot be empty')
  const sortedExisting = [...existing].sort((a, b) => (BigInt(a.number) < BigInt(b.number) ? -1 : 1))
  const byNumber = new Map(sortedExisting.map((row) => [row.number, row]))
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    if (candidate.chainId !== chainId) throw new Error('canonical block batch mixes chain ids')
    if (BigInt(candidate.number) < 0n) throw new Error('canonical block number cannot be negative')
    if (index > 0) {
      const previous = candidates[index - 1]!
      if (BigInt(candidate.number) !== BigInt(previous.number) + 1n) {
        throw new Error('canonical block batch must be contiguous and ascending')
      }
      if (candidate.parentHash.toLowerCase() !== previous.hash.toLowerCase()) {
        throw new Error('canonical block batch has a broken parent link')
      }
    }
  }

  const first = candidates[0]!
  const firstNumber = BigInt(first.number)
  if (anchor && anchor.chainId !== chainId) throw new Error('canonical anchor belongs to another chain')
  if (anchor && firstNumber <= BigInt(anchor.number)) {
    throw new Error('canonical ingestion cannot rewrite at or below the finalized archive anchor')
  }
  let commonAncestorNumber: string | null = null
  let commonAncestorHash: string | null = null
  if (firstNumber > 0n) {
    const previousNumber = (firstNumber - 1n).toString()
    const previous = byNumber.get(previousNumber)
    if (previous) {
      if (previous.hash.toLowerCase() !== first.parentHash.toLowerCase()) {
        throw new CanonicalParentMissingError(chainId, first.number, first.parentHash)
      }
      commonAncestorNumber = previous.number
      commonAncestorHash = previous.hash
    } else {
      const anchoredParent = anchor
        && BigInt(anchor.number) === firstNumber - 1n
        && anchor.hash.toLowerCase() === first.parentHash.toLowerCase()
      if (!anchoredParent) throw new CanonicalParentMissingError(chainId, first.number, first.parentHash)
      commonAncestorNumber = anchor.number
      commonAncestorHash = anchor.hash
    }
  }

  let rollbackFrom: string | null = null
  for (const candidate of candidates) {
    const current = byNumber.get(BigInt(candidate.number).toString())
    if (current && current.hash.toLowerCase() !== candidate.hash.toLowerCase()) {
      rollbackFrom = BigInt(candidate.number).toString()
      break
    }
    if (!current) {
      const laterExists = sortedExisting.some((row) => BigInt(row.number) > BigInt(candidate.number))
      if (laterExists) rollbackFrom = BigInt(candidate.number).toString()
      break
    }
    commonAncestorNumber = current.number
    commonAncestorHash = current.hash
  }
  return { rollbackFrom, commonAncestorNumber, commonAncestorHash }
}

type PrincipalRow = {
  principal_id: string
  tenant_id: string
  kind: HostedPrincipalKind
  roles: HostedRole[]
  limits: TenantLimits
}

export interface HostedWalletChallenge {
  challengeId: string
  tenantId: string
  chainId: number
  allocationId: `0x${string}`
  walletAddress: `0x${string}`
  domain: string
  uri: string
  message: string
  expiresAt: string
  sessionExpiresAt: string
  usedAt: string | null
}

export interface HostedAllocationAuthority {
  factId: string
  tenantId: string
  allocationId: `0x${string}`
  roomId: string
  blockNumber: string
  blockHash: `0x${string}`
}

export interface HostedSponsorshipAuthority {
  sponsorshipId: string
  sponsorTenantId: string
  beneficiaryTenantId: string
  allocationId: string | null
  unit: string
  active: boolean
  expiresAt: string | null
}

export interface HostedRoomSemanticProjection {
  errors: string[]
  cursors: {
    admissionMax: string | null
    depositQueuedMax: string | null
    depositRefundedMax: string | null
    forcedQueuedMax: string | null
    forcedOutcomeMax: string | null
    importMax: string | null
    batchMax: string | null
    withdrawalRootMax: string | null
    withdrawalClaimMax: string | null
  }
  latestFacts: Array<{
    eventName: string
    args: Record<string, unknown>
    calldata: Record<string, unknown> | null
    transactionHash: `0x${string}`
    blockNumber: string
    blockHash: `0x${string}`
  }>
}

export interface HostedSystemSemanticProjection {
  errors:string[]
  latestNodeFacts:Array<{
    eventName:string
    args:Record<string,unknown>
    transactionHash:`0x${string}`
    blockNumber:string
    blockHash:`0x${string}`
  }>
}

/** Bounded-cardinality aggregates exported by the hosted Prometheus surface. */
export interface HostedMetricsSnapshot {
  canonicalHeadBlock:number
  canonicalFloorBlock:number
  indexerLagBlocks:number
  databaseBytes:number
  outboxBacklog:number
  objectBacklog:number
  sseConnections:number
  reorgs:number
  factRetractions:number
  postFinalitySurprises:number
  deadlineRiskTransactions:number
  usageReconciliationLagSeconds:number
  admissionOldestReservedSeconds:number
  queueBytes:number
  queueWaitAverageSeconds:number
  queueWaitMaximumSeconds:number
  queueAttempts:number
  queueFairnessSpread:number
  gpuLeases:number
  trustedDeadlineSlackSumSeconds:number
  trustedDeadlineSlackCount:number
  trustedDeadlineBuckets:{ overdue:number;fiveMinutes:number;thirtyMinutes:number;infinite:number }
  sponsorship:{ available:number;reserved:number;consumed:number;denials:number;refunds:number }
  admissionStatuses:Array<{ status:string;count:number }>
  queueStatuses:Array<{ status:string;count:number }>
  reconciliationStatuses:Array<{ status:'reconciled'|'drifted';count:number }>
  roomStates:Array<{ state:'open'|'closed'|'unknown';count:number }>
  roomLifecycleEvents:Array<{ event:string;count:number }>
  l1TransactionStatuses:Array<{ status:string;count:number }>
  blobPublishStatuses:Array<{ status:string;count:number }>
  blobRequirementStatuses:Array<{ status:string;count:number }>
  aggregateOutcomes:Array<{ outcome:'applied'|'failed'|'retracted';count:number }>
  aggregateCharges:Array<{ kind:string;count:number }>
}

type WalletChallengeRow = {
  challenge_id: string
  tenant_id: string
  chain_id: string
  allocation_id: `0x${string}`
  wallet_address: `0x${string}`
  domain: string
  uri: string
  message: string
  request_hash: string
  idempotency_key: string
  expires_at: string
  session_expires_at: string
  used_at: string | null
}

function hostedWalletChallenge(row: WalletChallengeRow): HostedWalletChallenge {
  return {
    challengeId:row.challenge_id,tenantId:row.tenant_id,chainId:Number(row.chain_id),
    allocationId:row.allocation_id,walletAddress:row.wallet_address,
    domain:row.domain,uri:row.uri,message:row.message,
    expiresAt:row.expires_at,sessionExpiresAt:row.session_expires_at,usedAt:row.used_at,
  }
}

type AdmissionRow = {
  room_id: string
  admission_id: string
  tenant_id: string
  transaction_hash: `0x${string}`
  raw_signed_transaction: `0x${string}`
  sender: `0x${string}`
  request: AdmissionWalRecord['request']
  receipt: Record<string, unknown> | null
  status: AdmissionWalRecord['status']
  lease_owner: string | null
  lease_expires_at: string | null
  created_at: string
  updated_at: string
}

function admission(row: AdmissionRow): AdmissionWalRecord {
  return {
    roomId: String(row.room_id),
    admissionId: String(row.admission_id),
    tenantId: row.tenant_id,
    transactionHash: row.transaction_hash,
    rawSignedTransaction: row.raw_signed_transaction,
    sender: row.sender,
    request: row.request,
    receipt: row.receipt,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Canonical bytes persisted before an aggregate transaction is signed. The
 * binding includes the exact calldata and every proof-result digest so a
 * billing manifest cannot later be attached to a different aggregate.
 */
export function aggregateBillingRequestBytes(input: AggregateBillingRequestBinding): Uint8Array {
  const members = [...input.members]
    .sort((left, right) => left.memberIndex - right.memberIndex)
    .map((member) => ({
      memberIndex: member.memberIndex,
      jobId: member.jobId,
      roomId: member.roomId,
      batchIndex: member.batchIndex,
      resultObjectKey: member.resultObjectKey,
      resultDigest: member.resultDigest,
    }))
  return new TextEncoder().encode(canonicalJson({
    schema: 'zkdeal.aggregate-billing-operation.v1',
    chainId: input.chainId,
    aggregateHash: input.aggregateHash.toLowerCase(),
    destinationAddress: input.destinationAddress.toLowerCase(),
    calldataHash: createHash('sha256').update(input.calldata.toLowerCase()).digest('hex'),
    members,
  }))
}

export function aggregateBillingRequestHash(input: AggregateBillingRequestBinding): string {
  return createHash('sha256').update(aggregateBillingRequestBytes(input)).digest('hex')
}

function decodedAggregateMemberKeys(
  abi: Abi,
  calldata: `0x${string}`,
): Array<{ roomId: string; batchIndex: string }> {
  let decoded: { functionName: string; args?: readonly unknown[] }
  try {
    decoded = decodeFunctionData({ abi, data: calldata })
  } catch (error) {
    throw new Error(`aggregate L1 calldata is not decodable: ${(error as Error).message}`)
  }
  if (decoded.functionName !== 'submitAggregate') {
    throw new Error('aggregate L1 operation must call submitAggregate')
  }
  const args = decoded.args as readonly unknown[] | undefined
  const aggregate = args?.[0]
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
    throw new Error('submitAggregate calldata has no named aggregate tuple')
  }
  const aggregateRecord = aggregate as Record<string, unknown>
  if (!Array.isArray(aggregateRecord.members) || aggregateRecord.members.length === 0) {
    throw new Error('submitAggregate calldata contains no members')
  }
  if (typeof aggregateRecord.aggregateSeal !== 'string' || aggregateRecord.aggregateSeal === '0x') {
    throw new Error('submitAggregate calldata contains no aggregate proof seal')
  }
  return aggregateRecord.members.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`submitAggregate member ${index} is malformed`)
    }
    const member = value as Record<string, unknown>
    const submission = member.submission
    if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
      throw new Error(`submitAggregate member ${index} has no submission`)
    }
    const journal = (submission as Record<string, unknown>).journal
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
      throw new Error(`submitAggregate member ${index} has no journal`)
    }
    const roomId = String(member.roomId)
    const journalRecord = journal as Record<string, unknown>
    if (String(journalRecord.roomId) !== roomId) {
      throw new Error(`submitAggregate member ${index} room conflicts with its journal`)
    }
    return { roomId, batchIndex: String(journalRecord.batchIndex) }
  })
}

function canonicalDecimal(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value)
  if (!match) throw new Error('decimal value is malformed')
  const integer = match[2]!.replace(/^0+(?=[0-9])/, '')
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  const zero = integer === '0' && fraction === ''
  return `${zero ? '' : match[1]}${integer}${fraction ? `.${fraction}` : ''}`
}

function canonicalTimestamp(value: string | Date): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('timestamp value is malformed')
  return new Date(milliseconds).toISOString()
}

function nullableTimestamp(value: string | Date | null): string | null {
  return value === null ? null : canonicalTimestamp(value)
}

type HostedL1TransactionRow = {
  operation_id: string
  chain_id: string
  sender: `0x${string}`
  nonce: string
  operation: string
  idempotency_key: string
  request_hash: string
  request_object_key: string
  transport_request_hash: string | null
  transport_request_object_key: string | null
  destination_address: `0x${string}` | null
  calldata: `0x${string}`
  inclusion_deadline: string
  transaction_hash: `0x${string}` | null
  raw_transaction_object_key: string | null
  bundle_object_key: string | null
  status: HostedL1TransactionStatus
  attempts: number
  last_attempt_at: string | null
  next_attempt_at: string
  deadline_risk: boolean
  block_number: string | null
  block_hash: `0x${string}` | null
  gas_used: string | null
  effective_gas_price: string | null
  blob_gas_used: string | null
  blob_gas_price: string | null
  receipt_provider_ids: string[]
  receipt_observed_at: string | null
  receipt_canonical: boolean
  finalized_block: string | null
  finalized_hash: `0x${string}` | null
  last_error: string | null
  created_at: string
  updated_at: string
}

function hostedL1Transaction(row: HostedL1TransactionRow): HostedL1Transaction {
  return {
    operationId: row.operation_id,
    chainId: Number(row.chain_id),
    sender: row.sender,
    nonce: row.nonce,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    requestObjectKey: row.request_object_key,
    transportRequestHash: row.transport_request_hash,
    transportRequestObjectKey: row.transport_request_object_key,
    destinationAddress: row.destination_address,
    calldata: row.calldata,
    inclusionDeadline: row.inclusion_deadline,
    transactionHash: row.transaction_hash,
    rawTransactionObjectKey: row.raw_transaction_object_key,
    bundleObjectKey: row.bundle_object_key,
    status: row.status,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    deadlineRisk: row.deadline_risk,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    gasUsed: row.gas_used,
    effectiveGasPrice: row.effective_gas_price,
    blobGasUsed: row.blob_gas_used,
    blobGasPrice: row.blob_gas_price,
    receiptProviderIds: row.receipt_provider_ids,
    receiptObservedAt: row.receipt_observed_at,
    receiptCanonical: row.receipt_canonical,
    finalizedBlock: row.finalized_block,
    finalizedHash: row.finalized_hash,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const HOSTED_L1_TRANSACTION_SELECT = `
  operation_id,chain_id::text,sender,nonce::text,operation,idempotency_key,
  request_hash,request_object_key,transport_request_hash,transport_request_object_key,
  destination_address,calldata,inclusion_deadline::text,
  transaction_hash,raw_transaction_object_key,bundle_object_key,status,attempts,
  last_attempt_at::text,next_attempt_at::text,deadline_risk,
  block_number::text,block_hash,gas_used::text,effective_gas_price::text,
  blob_gas_used::text,blob_gas_price::text,receipt_provider_ids,receipt_observed_at::text,
  receipt_canonical,finalized_block::text,finalized_hash,last_error,
  created_at::text,updated_at::text`

type PostFinalityRecoveryRow = {
  recovery_id: string
  chain_id: string
  operation_id: string
  prior_floor_number: string
  prior_floor_hash: `0x${string}`
  branch_start_number: string
  branch_blocks: CanonicalBlockInput[]
  required_indexer_sources: string[]
  verified_sources: { install: string[]; finalize?: string[] }
  status: 'BRANCH_INSTALLED' | 'RESOLVED'
  replacement_floor_number: string | null
  replacement_floor_hash: `0x${string}` | null
  reason: string
  created_at: string
  resolved_at: string | null
}

const POST_FINALITY_RECOVERY_SELECT = `
  recovery_id,chain_id::text,operation_id,prior_floor_number::text,prior_floor_hash,
  branch_start_number::text,branch_blocks,required_indexer_sources,verified_sources,status,
  replacement_floor_number::text,replacement_floor_hash,reason,created_at::text,resolved_at::text`

function postFinalityRecovery(row: PostFinalityRecoveryRow): PostFinalityRecovery {
  return {
    recoveryId: row.recovery_id,
    chainId: Number(row.chain_id),
    operationId: row.operation_id,
    priorFloor: { number: row.prior_floor_number, hash: row.prior_floor_hash },
    branchStartNumber: row.branch_start_number,
    branchBlocks: row.branch_blocks,
    requiredIndexerSources: row.required_indexer_sources,
    verifiedSources: row.verified_sources,
    status: row.status,
    replacementFloor: row.replacement_floor_number && row.replacement_floor_hash
      ? { number: row.replacement_floor_number, hash: row.replacement_floor_hash }
      : null,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

type HostedWithdrawalClaimRow = {
  claim_id: string
  chain_id: string
  room_id: string
  epoch: string
  withdrawal_index: string
  tenant_id: string
  idempotency_key: string
  operation_id: string | null
  transaction_hash: `0x${string}` | null
  status: HostedWithdrawalClaim['status']
  lease_owner: string | null
  lease_expires_at: string | null
  attempts: number
  next_attempt_at: string
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

const HOSTED_WITHDRAWAL_CLAIM_SELECT = `
  claim_id::text,chain_id::text,room_id::text,epoch::text,withdrawal_index::text,
  tenant_id,idempotency_key,operation_id,transaction_hash,status,lease_owner,
  lease_expires_at::text,attempts,next_attempt_at::text,error_code,error_message,
  created_at::text,updated_at::text`

function hostedWithdrawalClaim(row: HostedWithdrawalClaimRow): HostedWithdrawalClaim {
  return {
    claimId: row.claim_id,
    chainId: Number(row.chain_id),
    roomId: row.room_id,
    epoch: row.epoch,
    withdrawalIndex: row.withdrawal_index,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    operationId: row.operation_id,
    transactionHash: row.transaction_hash,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface HostedProveJobRow {
  job_id: string
  retry_of_job_id: string | null
  tenant_id: string
  room_id: string | null
  allocation_id: string | null
  sponsorship_id: string | null
  service_class: HostedProveJob['serviceClass']
  correlation_id: string | null
  partition: HostedProveJob['partition']
  proof_class: string
  endpoint: string
  needs_gpu: boolean
  request_object_key: string
  request_bytes: string
  estimated_work: string
  estimated_proof_time_ms: string
  payer_tenant_id: string | null
  quote_price_id: string | null
  quote_unit_price: string | null
  quote_currency: string | null
  quote_effective_from: string | Date | null
  quote_accepted_at: string | Date | null
  maximum_charge_amount: string | null
  maximum_charge_currency: string | null
  quote_sla_policy_id: string | null
  quote_sla_effective_from: string | Date | null
  deadline_at: string | Date | null
  latest_start_at: string | Date | null
  deadline_trusted: boolean
  deadline_chain_id: string | null
  deadline_block: string | null
  latest_start_block: string | null
  deadline_fact_key: string | null
  deadline_fact_block_hash: string | null
  settlement_margin_ms: string
  priority: number
  tenant_weight: string
  attempts: number
  max_attempts: number
  enqueued_at: string | Date
  aging_started_at: string | Date
  status: HostedProveJob['status']
  lease_owner: string | null
  lease_expires_at: string | Date | null
  result_object_key: string | null
  result_digest: string | null
  error_code: string | null
}

const PROVE_JOB_COLUMNS = `
  job_id, retry_of_job_id, tenant_id, room_id::text, allocation_id, sponsorship_id,
  service_class, correlation_id, partition, proof_class, endpoint, needs_gpu,
  request_object_key, request_bytes::text, estimated_work::text,
  estimated_proof_time_ms::text,payer_tenant_id,quote_price_id::text,
  quote_unit_price::text,quote_currency,quote_effective_from::text,quote_accepted_at::text,
  maximum_charge_amount::text,maximum_charge_currency,quote_sla_policy_id::text,
  quote_sla_effective_from::text,deadline_at::text, latest_start_at::text,
  deadline_trusted, deadline_chain_id::text, deadline_block::text,
  latest_start_block::text, deadline_fact_key, deadline_fact_block_hash,
  settlement_margin_ms::text, priority, tenant_weight::text,
  attempts, max_attempts, enqueued_at::text, aging_started_at::text, status,
  lease_owner, lease_expires_at::text, result_object_key,result_digest,error_code`

function proveJob(row: HostedProveJobRow): HostedProveJob {
  const timestamp = (value: string | Date | null): string | null =>
    value instanceof Date ? value.toISOString() : value
  return {
    jobId: row.job_id,
    retryOfJobId: row.retry_of_job_id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    allocationId: row.allocation_id,
    sponsorshipId: row.sponsorship_id,
    serviceClass: row.service_class,
    correlationId: row.correlation_id,
    partition: row.partition,
    proofClass: row.proof_class,
    endpoint: row.endpoint,
    needsGpu: row.needs_gpu,
    requestObjectKey: row.request_object_key,
    requestBytes: row.request_bytes,
    estimatedWork: row.estimated_work,
    estimatedProofTimeMs: row.estimated_proof_time_ms,
    billingMode: row.maximum_charge_amount === null ? 'telemetry-only' : 'quoted',
    payerTenantId: row.payer_tenant_id,
    quotePriceId: row.quote_price_id,
    quoteUnitPrice: row.quote_unit_price,
    quoteCurrency: row.quote_currency,
    quoteEffectiveFrom: timestamp(row.quote_effective_from),
    quoteAcceptedAt: timestamp(row.quote_accepted_at),
    maximumChargeAmount: row.maximum_charge_amount,
    maximumChargeCurrency: row.maximum_charge_currency,
    quoteSlaPolicyId: row.quote_sla_policy_id,
    quoteSlaEffectiveFrom: timestamp(row.quote_sla_effective_from),
    deadlineAt: timestamp(row.deadline_at),
    latestStartAt: timestamp(row.latest_start_at),
    deadlineTrusted: row.deadline_trusted,
    deadlineChainId: row.deadline_chain_id,
    deadlineBlock: row.deadline_block,
    latestStartBlock: row.latest_start_block,
    deadlineFactKey: row.deadline_fact_key,
    deadlineFactBlockHash: row.deadline_fact_block_hash,
    settlementMarginMs: row.settlement_margin_ms,
    priority: row.priority,
    tenantWeight: row.tenant_weight,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    enqueuedAt: timestamp(row.enqueued_at)!,
    agingStartedAt: timestamp(row.aging_started_at)!,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: timestamp(row.lease_expires_at),
    resultObjectKey: row.result_object_key,
    resultDigest: row.result_digest,
    errorCode: row.error_code,
  }
}

type BillingLedgerRow = {
  entry_id: string
  tenant_id: string
  beneficiary_tenant_id: string | null
  sponsorship_id: string | null
  allocation_id: string | null
  job_id: string | null
  room_id: string | null
  aggregate_hash: `0x${string}` | null
  member_index: number | null
  entry_kind: BillingLedgerEntry['entryKind']
  unit: string
  quantity: string
  currency: string | null
  amount: string | null
  price_id: string | null
  price_effective_from: string | null
  sla_policy_id: string | null
  sla_effective_from: string | null
  source_fact_id: string | null
  reverses_entry_id: string | null
  idempotency_key: string
  metadata: Record<string, unknown>
  created_at: string
}

const BILLING_LEDGER_SELECT = `
  entry_id::text,tenant_id,beneficiary_tenant_id,sponsorship_id,
  allocation_id,job_id,room_id::text,aggregate_hash,
  member_index,entry_kind,unit,quantity::text,currency,amount::text,
  price_id::text,price_effective_from::text,sla_policy_id::text,sla_effective_from::text,
  source_fact_id::text,reverses_entry_id::text,idempotency_key,metadata,
  created_at::text`

function billingLedgerEntry(row: BillingLedgerRow): BillingLedgerEntry {
  return {
    entryId: row.entry_id,
    tenantId: row.tenant_id,
    beneficiaryTenantId: row.beneficiary_tenant_id,
    sponsorshipId: row.sponsorship_id,
    allocationId: row.allocation_id,
    jobId: row.job_id,
    roomId: row.room_id,
    aggregateHash: row.aggregate_hash,
    memberIndex: row.member_index,
    entryKind: row.entry_kind,
    unit: row.unit,
    quantity: row.quantity,
    currency: row.currency,
    amount: row.amount,
    priceId: row.price_id,
    priceEffectiveFrom: row.price_effective_from,
    slaPolicyId: row.sla_policy_id,
    slaEffectiveFrom: row.sla_effective_from,
    sourceFactId: row.source_fact_id,
    reversesEntryId: row.reverses_entry_id,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

interface NodeLifecycleRow {
  operation_id: string
  principal_id: string
  onchain_node_id: `0x${string}`
  desired_state: NodeLifecycleDesiredState
  idempotency_key: string
  prior_operation_id: string | null
  status: NodeLifecycleOperation['status']
  provider_operation_id: string | null
  provider_evidence: Record<string, unknown>
  canonical_fact_id: string | null
  canonical_fact_block_hash: `0x${string}` | null
  attempts: number
  max_attempts: number
  next_attempt_at: string
  lease_owner: string | null
  lease_token: string | null
  lease_expires_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

const NODE_LIFECYCLE_SELECT = `
  operation_id,principal_id,onchain_node_id,desired_state,idempotency_key,prior_operation_id,
  status,provider_operation_id,provider_evidence,canonical_fact_id::text,
  canonical_fact_block_hash,attempts,max_attempts,next_attempt_at::text,
  lease_owner,lease_token::text,lease_expires_at::text,last_error,created_at::text,updated_at::text`

function nodeLifecycleOperation(row: NodeLifecycleRow): NodeLifecycleOperation {
  return {
    operationId: row.operation_id,principalId: row.principal_id,onchainNodeId: row.onchain_node_id,
    desiredState: row.desired_state,idempotencyKey: row.idempotency_key,
    priorOperationId: row.prior_operation_id,status: row.status,
    providerOperationId: row.provider_operation_id,providerEvidence: row.provider_evidence,
    canonicalFactId: row.canonical_fact_id,canonicalFactBlockHash: row.canonical_fact_block_hash,
    attempts: row.attempts,maxAttempts: row.max_attempts,nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,leaseToken: row.lease_token,leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,createdAt: row.created_at,updatedAt: row.updated_at,
  }
}

export class PostgresHostedStore {
  constructor(
    private readonly pool: SqlPool,
    private readonly apiKeyPepper: string,
    private readonly aggregateAbi: Abi | null = null,
  ) {
    if (apiKeyPepper.length < 32) throw new Error('API key pepper must contain at least 32 characters')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async bootstrap(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS hosted_schema_meta (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`)
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-hosted-schema'))")
      const installed = await client.query<{ version: number | null }>(
        'SELECT max(version)::integer AS version FROM hosted_schema_meta',
      )
      const current = installed.rows[0]?.version ?? 0
      if (current > HOSTED_SCHEMA_VERSION) {
        throw new Error(`database schema ${current} is newer than supported schema ${HOSTED_SCHEMA_VERSION}`)
      }
      // Idempotent CREATE/ADD statements make every deployment converge on
      // the current table/column set before the version-specific data/key
      // migration runs.
      await client.query(HOSTED_SCHEMA_SQL)
      if (current < 2) await client.query(HOSTED_SCHEMA_V2_MIGRATION_SQL)
      if (current < 3) await client.query(HOSTED_SCHEMA_V3_MIGRATION_SQL)
      if (current < 4) await client.query(HOSTED_SCHEMA_V4_MIGRATION_SQL)
      if (current < 5) await client.query(HOSTED_SCHEMA_V5_MIGRATION_SQL)
      if (current < 6) await client.query(HOSTED_SCHEMA_V6_MIGRATION_SQL)
      if (current < 7) await client.query(HOSTED_SCHEMA_V7_MIGRATION_SQL)
      if (current < 8) await client.query(HOSTED_SCHEMA_V8_MIGRATION_SQL)
      if (current < 9) await client.query(HOSTED_SCHEMA_V9_MIGRATION_SQL)
      if (current < 10) await client.query(HOSTED_SCHEMA_V10_MIGRATION_SQL)
      if (current < 11) await client.query(HOSTED_SCHEMA_V11_MIGRATION_SQL)
      if (current < 12) await client.query(HOSTED_SCHEMA_V12_MIGRATION_SQL)
      if (current < 13) await client.query(HOSTED_SCHEMA_V13_MIGRATION_SQL)
      if (current < 14) await client.query(HOSTED_SCHEMA_V14_MIGRATION_SQL)
      if (current < 15) await client.query(HOSTED_SCHEMA_V15_MIGRATION_SQL)
      if (current < 16) await client.query(HOSTED_SCHEMA_V16_MIGRATION_SQL)
      if (current < 17) await client.query(HOSTED_SCHEMA_V17_MIGRATION_SQL)
      if (current < 18) await client.query(HOSTED_SCHEMA_V18_MIGRATION_SQL)
      if (current < 19) await client.query(HOSTED_SCHEMA_V19_MIGRATION_SQL)
      if (current < 20) await client.query(HOSTED_SCHEMA_V20_MIGRATION_SQL)
      if (current < 21) await client.query(HOSTED_SCHEMA_V21_MIGRATION_SQL)
      if (current < 22) await client.query(HOSTED_SCHEMA_V22_MIGRATION_SQL)
      if (current < 23) await client.query(HOSTED_SCHEMA_V23_MIGRATION_SQL)
      if (current < 24) await client.query(HOSTED_SCHEMA_V24_MIGRATION_SQL)
      if (current < 25) await client.query(HOSTED_SCHEMA_V25_MIGRATION_SQL)
      if (current < 26) await client.query(HOSTED_SCHEMA_V26_MIGRATION_SQL)
      if (current < 27) await client.query(HOSTED_SCHEMA_V27_MIGRATION_SQL)
      if (current < 28) await client.query(HOSTED_SCHEMA_V28_MIGRATION_SQL)
      await client.query(
        'INSERT INTO hosted_schema_meta(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [HOSTED_SCHEMA_VERSION],
      )
      const invariant = await client.query<{
        version: number
        observation_key: string[]
        required_tables: number
        trusted_deadline_columns: number
        trusted_deadline_constraints: number
        capacity_execution_columns: number
        capacity_execution_constraints: number
        billing_tables: number
        billing_immutable_triggers: number
        billing_binding_columns: number
        l1_cost_columns: number
        billing_allocation_constraints: number
        retry_binding_columns: number
        retry_binding_constraints: number
        l1_binding_scope_columns: number
        l1_binding_constraints: number
      }>(
        `SELECT
           (SELECT max(version)::integer FROM hosted_schema_meta) AS version,
           (
             SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_constraint AS constraint_row
             CROSS JOIN LATERAL unnest(constraint_row.conkey)
               WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = constraint_row.conrelid
              AND attribute.attnum = key.attnum
             WHERE constraint_row.conrelid = 'hosted_room_observations'::regclass
               AND constraint_row.contype = 'p'
           ) AS observation_key,
           (
             SELECT count(*)::integer FROM (VALUES
               (to_regclass('hosted_indexer_logs')),
               (to_regclass('hosted_withdrawals')),
               (to_regclass('hosted_prove_jobs')),
               (to_regclass('hosted_provider_nodes')),
               (to_regclass('hosted_proof_profiles')),
               (to_regclass('hosted_gpu_resource_leases')),
               (to_regclass('hosted_sponsorship_reservations')),
               (to_regclass('hosted_scheduler_global_state')),
               (to_regclass('hosted_rate_limit_windows')),
               (to_regclass('hosted_room_reconciliation_queue')),
               (to_regclass('hosted_capacity_operations')),
               (to_regclass('hosted_worker_leases')),
               (to_regclass('hosted_blob_archives')),
               (to_regclass('hosted_blob_requirements')),
               (to_regclass('hosted_l1_nonce_state')),
               (to_regclass('hosted_l1_transactions')),
               (to_regclass('hosted_l1_finality_audit_cursors')),
               (to_regclass('hosted_post_finality_recoveries')),
                (to_regclass('hosted_withdrawal_epochs')),
                (to_regclass('hosted_primary_wal_checkpoints')),
               (to_regclass('hosted_sponsorships')),
               (to_regclass('hosted_capacity_signals')),
               (to_regclass('hosted_audit_records')),
               (to_regclass('hosted_node_lifecycle_operations')),
               (to_regclass('hosted_l1_service_bindings')),
               (to_regclass('hosted_l1_operation_access')),
               (to_regclass('hosted_room_proving_policies')),
               (to_regclass('hosted_wallet_challenges')),
               (to_regclass('hosted_wallet_sessions'))
             ) AS required(table_name) WHERE table_name IS NOT NULL
           ) AS required_tables,
           (
             SELECT count(*)::integer FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='hosted_prove_jobs'
               AND column_name IN (
                 'deadline_chain_id','deadline_block','latest_start_block',
                 'deadline_fact_key','deadline_fact_block_hash'
               )
           ) AS trusted_deadline_columns,
           (
           SELECT count(*)::integer FROM pg_constraint
           WHERE conrelid='hosted_prove_jobs'::regclass
               AND conname='hosted_prove_jobs_trusted_deadline_source'
           ) AS trusted_deadline_constraints,
           (
             SELECT count(*)::integer FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='hosted_capacity_intents'
               AND column_name IN (
                 'execution_status','applied_state','provider_operation_id','provider_response',
                 'max_attempts','lease_owner','lease_token','lease_expires_at',
                 'last_success_at','alerted_at'
               )
           ) AS capacity_execution_columns,
           (
             SELECT count(*)::integer FROM pg_constraint
             WHERE conrelid='hosted_capacity_intents'::regclass
               AND conname IN (
                 'hosted_capacity_execution_status_check',
                 'hosted_capacity_applied_state_check',
                 'hosted_capacity_max_attempts_check',
                 'hosted_capacity_lease_token_check'
               )
           ) AS capacity_execution_constraints,
           (
             SELECT count(*)::integer FROM (VALUES
               (to_regclass('hosted_aggregate_billing_manifests')),
               (to_regclass('hosted_aggregate_billing_members')),
                (to_regclass('hosted_aggregate_outcome_receipts')),
                (to_regclass('hosted_aggregate_outcome_retractions')),
               (to_regclass('hosted_billing_ledger')),
               (to_regclass('hosted_billing_prices')),
               (to_regclass('hosted_sla_policies')),
               (to_regclass('hosted_invoice_exports'))
             ) AS billing(table_name) WHERE table_name IS NOT NULL
           ) AS billing_tables,
           (
             SELECT count(*)::integer FROM pg_trigger
             WHERE NOT tgisinternal AND tgname IN (
               'hosted_aggregate_billing_manifests_immutable',
                'hosted_aggregate_billing_members_immutable',
                'hosted_aggregate_outcomes_immutable',
                'hosted_aggregate_retractions_immutable',
               'hosted_billing_immutable',
               'hosted_billing_prices_immutable',
               'hosted_sla_policies_immutable',
               'hosted_invoice_exports_immutable',
               'hosted_sponsorship_charges_immutable',
               'hosted_refunds_immutable'
             )
            ) AS billing_immutable_triggers,
           (
             SELECT count(*)::integer FROM information_schema.columns
             WHERE table_schema=current_schema() AND (
               (table_name='hosted_prove_jobs' AND column_name IN (
                 'payer_tenant_id','quote_price_id','maximum_charge_amount',
                 'maximum_charge_currency','result_digest'
               )) OR
               (table_name='hosted_aggregate_billing_manifests' AND column_name IN (
                 'operation_id','transaction_hash','destination_address','request_hash','calldata_hash'
               )) OR
                (table_name='hosted_aggregate_billing_members' AND column_name IN (
                  'result_digest','payer_tenant_id','price_id','maximum_charge_amount',
                  'allocation_fact_id','allocation_fact_block_hash'
                )) OR
               (table_name='hosted_billing_ledger' AND column_name IN (
                 'beneficiary_tenant_id','sponsorship_id','price_id','sla_policy_id'
               ))
             )
            ) AS billing_binding_columns,
            (
              SELECT count(*)::integer FROM information_schema.columns
              WHERE table_schema=current_schema() AND table_name='hosted_l1_transactions'
                AND column_name IN ('gas_used','effective_gas_price','blob_gas_used','blob_gas_price')
            ) AS l1_cost_columns,
            (
              SELECT count(*)::integer FROM pg_constraint
              WHERE (conrelid='hosted_aggregate_billing_members'::regclass
                       AND conname IN ('hosted_aggregate_members_allocation_fact_fk','hosted_aggregate_members_allocation_binding_check'))
                 OR (conrelid='hosted_billing_ledger'::regclass
                       AND conname IN ('hosted_billing_entry_kind_check','hosted_billing_sign_check','hosted_billing_reversal_check'))
            ) AS billing_allocation_constraints,
            (
              SELECT count(*)::integer FROM information_schema.columns
              WHERE table_schema=current_schema()
                AND (table_name,column_name) IN (
                  ('hosted_prove_jobs','retry_of_job_id'),
                  ('hosted_sponsorship_reservations','transferred_to_job_id')
                )
            ) AS retry_binding_columns,
            (
              SELECT count(*)::integer FROM pg_constraint
              WHERE conname IN (
                'hosted_prove_jobs_retry_of_fk',
                'hosted_sponsorship_reservation_status_check',
                'hosted_sponsorship_reservation_transfer_check',
                'hosted_sponsorship_reservation_transfer_fk'
              )
            ) AS retry_binding_constraints,
            (
              SELECT count(*)::integer FROM information_schema.columns
              WHERE table_schema=current_schema() AND table_name='hosted_l1_service_bindings'
                AND column_name IN ('sponsorship_id','allocation_id')
            ) AS l1_binding_scope_columns,
            (
              SELECT count(*)::integer FROM pg_constraint
              WHERE (conrelid='hosted_l1_service_bindings'::regclass
                       AND conname IN (
                         'hosted_l1_service_bindings_binding_kind_check',
                         'hosted_l1_service_bindings_allocation_id_check',
                         'hosted_l1_service_bindings_scope_check'
                       ))
                 OR (conrelid='hosted_l1_operation_access'::regclass
                       AND conname='hosted_l1_operation_access_binding_kind_check')
            ) AS l1_binding_constraints`,
      )
      const row = invariant.rows[0]
      if (
        row?.version !== HOSTED_SCHEMA_VERSION
        || row.required_tables !== 29
        || row.observation_key?.join(',') !== 'chain_id,room_id'
        || row.trusted_deadline_columns !== 5
        || row.trusted_deadline_constraints !== 1
        || row.capacity_execution_columns !== 10
        || row.capacity_execution_constraints !== 4
        || row.billing_tables !== 8
        || row.billing_immutable_triggers !== 10
        || row.billing_binding_columns !== 20
        || row.l1_cost_columns !== 4
        || row.billing_allocation_constraints !== 5
        || row.retry_binding_columns !== 2
        || row.retry_binding_constraints !== 4
        || row.l1_binding_scope_columns !== 2
        || row.l1_binding_constraints !== 4
      ) throw new Error('hosted schema migration invariant check failed')
    })
  }

  private async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await fn(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  private async assertFence(client: SqlClient, fence: CoordinatorFence): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM coordinator_leases
       WHERE lease_name = $1 AND holder_id = $2 AND fence_token = $3
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [fence.leaseName, fence.holderId, fence.token.toString()],
    )
    if (result.rowCount !== 1) throw new HostedFenceError()
    if (fence.delegation) {
      const delegated = await client.query(
        `SELECT 1 FROM hosted_worker_leases
         WHERE component = $1 AND worker_id = $2 AND worker_fence_token = $3
           AND coordinator_holder_id = $4 AND coordinator_fence_token = $5
           AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          fence.delegation.component,
          fence.delegation.workerId,
          fence.delegation.token.toString(),
          fence.holderId,
          fence.token.toString(),
        ],
      )
      if (delegated.rowCount !== 1) throw new HostedFenceError('worker delegation is absent, expired, or fenced')
    }
  }

  /**
   * Database-time revalidation used immediately before readiness is exposed.
   * Mutating methods still perform the same check inside their own transaction;
   * this method prevents an old active from remaining load-balancer-ready in
   * the interval before its renewal timer observes a promoted epoch.
   */
  async assertCurrentFence(fence: CoordinatorFence): Promise<void> {
    await this.transaction(async (client) => this.assertFence(client, fence))
  }

  private async outbox(
    client: SqlClient,
    tenantId: string | null,
    topic: string,
    aggregateId: string,
    payload: unknown,
    audience?: HostedOutboxAudience,
  ): Promise<void> {
    if (topic === 'statusRetracted') {
      const item = payload as { previousState?: unknown; reason?: unknown } | null
      if (!item || item.previousState === undefined || item.reason === undefined) {
        throw new Error('statusRetracted events require previousState and reason')
      }
    }
    const resolvedAudience = audience ?? (tenantId === null ? 'admin-internal' : 'tenant')
    if (resolvedAudience === 'tenant' && tenantId === null) {
      throw new Error('tenant outbox events require a tenant id')
    }
    if (resolvedAudience === 'public-chain' && tenantId !== null) {
      throw new Error('public chain outbox events cannot carry tenant routing metadata')
    }
    const retentionClass = outboxRetentionClass(topic)
    await client.query(
      `INSERT INTO hosted_outbox(tenant_id, audience, topic, aggregate_id, payload, retention_class)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [tenantId, resolvedAudience, topic, aggregateId, JSON.stringify(payload), retentionClass],
    )
  }

  async acquireLease(
    leaseName: string,
    holderId: string,
    ttlMs: number,
  ): Promise<CoordinatorFence | null> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
      throw new Error('coordinator lease TTL must be from one second through five minutes')
    }
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO coordinator_leases(lease_name, holder_id, fence_token, expires_at)
         VALUES (
           $1, $2, 1,
           clock_timestamp() + ($3::bigint * interval '1 millisecond')
         ) ON CONFLICT (lease_name) DO NOTHING`,
        [leaseName, holderId, ttlMs],
      )
      const selected = await client.query<{
        holder_id: string
        fence_token: string
        expired: boolean
      }>(
        `SELECT holder_id, fence_token::text,
                expires_at <= clock_timestamp() AS expired
         FROM coordinator_leases WHERE lease_name = $1 FOR UPDATE`,
        [leaseName],
      )
      const row = selected.rows[0]
      if (!row) throw new Error('coordinator lease disappeared while acquiring it')
      if (!row.expired && row.holder_id !== holderId) return null
      const token = row.holder_id === holderId && !row.expired
        ? BigInt(row.fence_token)
        : BigInt(row.fence_token) + 1n
      const updated = await client.query<{ expires_at: string }>(
        `UPDATE coordinator_leases
         SET holder_id = $2, fence_token = $3,
             expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE lease_name = $1 RETURNING expires_at::text`,
        [leaseName, holderId, token.toString(), ttlMs],
      )
      return {
        leaseName,
        holderId,
        token,
        expiresAt: updated.rows[0]!.expires_at,
      }
    })
  }

  /**
   * Persist the active primary's WAL target under the same fencing token used
   * for every hosted mutation. A standby may use only this durable row - not an
   * HTTP-supplied LSN - as its promotion target.
   */
  async recordPrimaryReplicationCheckpoint(fence: CoordinatorFence): Promise<{
    targetLsn: string
    recordedAt: string
  }> {
    if (fence.delegation) throw new HostedFenceError('delegated workers cannot publish a primary WAL checkpoint')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ target_lsn: string; recorded_at: string }>(
        `INSERT INTO hosted_primary_wal_checkpoints(
           checkpoint_name,primary_holder_id,primary_fence_token,target_lsn,recorded_at
         ) VALUES ($1,$2,$3,pg_current_wal_flush_lsn(),clock_timestamp())
         ON CONFLICT (checkpoint_name) DO UPDATE SET
           primary_holder_id=EXCLUDED.primary_holder_id,
           primary_fence_token=EXCLUDED.primary_fence_token,
           target_lsn=EXCLUDED.target_lsn,
           recorded_at=EXCLUDED.recorded_at
         RETURNING target_lsn::text,recorded_at::text`,
        [fence.leaseName, fence.holderId, fence.token.toString()],
      )
      const row = result.rows[0]
      if (!row) throw new Error('primary WAL checkpoint was not persisted')
      return { targetLsn: row.target_lsn, recordedAt: row.recorded_at }
    })
  }

  /**
   * Transfer the global writer epoch only after the promoted PostgreSQL
   * standby proves it replayed the former primary's durable target. Health,
   * replay evidence, checkpoint freshness, and the monotonic fence update are
   * evaluated in one transaction so no caller can race a changing lease.
   */
  async acquireLeaseForPromotion(
    leaseName: string,
    holderId: string,
    ttlMs: number,
    maximumCheckpointAgeMs: number,
  ): Promise<ReplicationPromotionResult | null> {
    if (leaseName !== 'coordinator-writer') throw new Error('only the global coordinator lease can be promoted')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
      throw new Error('coordinator lease TTL must be from one second through five minutes')
    }
    if (
      !Number.isSafeInteger(maximumCheckpointAgeMs)
      || maximumCheckpointAgeMs < 5_000
      || maximumCheckpointAgeMs > 5 * 60_000
    ) throw new Error('promotion checkpoint age must be from five seconds through five minutes')

    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-hosted-promotion'))")
      const selected = await client.query<{
        holder_id: string
        fence_token: string
        expired: boolean
      }>(
        `SELECT holder_id,fence_token::text,
                expires_at <= clock_timestamp() AS expired
         FROM coordinator_leases WHERE lease_name=$1 FOR UPDATE`,
        [leaseName],
      )
      const previous = selected.rows[0]
      if (!previous) {
        throw new HostedPromotionError('checkpoint-missing', 'no former coordinator epoch exists to promote')
      }
      if (!previous.expired) return null
      if (previous.holder_id === holderId) {
        throw new HostedPromotionError(
          'checkpoint-lease-mismatch',
          'an expired coordinator must restart as active instead of self-promoting a standby epoch',
        )
      }

      const checkpointResult = await client.query<{
        primary_holder_id: string
        primary_fence_token: string
        target_lsn: string
        recorded_at: string
      }>(
        `SELECT primary_holder_id,primary_fence_token::text,target_lsn::text,recorded_at::text
         FROM hosted_primary_wal_checkpoints WHERE checkpoint_name=$1 FOR UPDATE`,
        [leaseName],
      )
      const checkpoint = checkpointResult.rows[0]
      if (!checkpoint) {
        throw new HostedPromotionError('checkpoint-missing', 'former primary did not publish a WAL target checkpoint')
      }
      if (
        checkpoint.primary_holder_id !== previous.holder_id
        || checkpoint.primary_fence_token !== previous.fence_token
      ) {
        throw new HostedPromotionError(
          'checkpoint-lease-mismatch',
          'primary WAL checkpoint does not bind the former coordinator fence',
        )
      }

      const healthResult = await client.query<{
        accepting_writes: boolean
        schema_version: number
        replay_lsn: string | null
        checked_at: string
      }>(
        `SELECT NOT pg_is_in_recovery() AS accepting_writes,
                (SELECT max(version)::integer FROM hosted_schema_meta) AS schema_version,
                pg_last_wal_replay_lsn()::text AS replay_lsn,
                clock_timestamp()::text AS checked_at`,
      )
      const health = healthResult.rows[0]
      if (!health) throw new HostedPromotionError('database-read-only', 'database health query returned no row')
      const replication = verifyReplicationPromotion({
        acceptingWrites: health.accepting_writes,
        schemaVersion: health.schema_version,
        expectedSchemaVersion: HOSTED_SCHEMA_VERSION,
        targetLsn: checkpoint.target_lsn,
        replayLsn: health.replay_lsn,
        checkpointRecordedAt: checkpoint.recorded_at,
        checkedAt: health.checked_at,
        maximumCheckpointAgeMs,
        previousHolderId: previous.holder_id,
        previousFenceToken: previous.fence_token,
      })

      const token = BigInt(previous.fence_token) + 1n
      const updated = await client.query<{ expires_at: string }>(
        `UPDATE coordinator_leases SET
           holder_id=$2,fence_token=$3,
           expires_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
           updated_at=clock_timestamp()
         WHERE lease_name=$1 AND holder_id=$5 AND fence_token=$6
         RETURNING expires_at::text`,
        [leaseName, holderId, token.toString(), ttlMs, previous.holder_id, previous.fence_token],
      )
      const lease = updated.rows[0]
      if (!lease) throw new HostedFenceError('former coordinator epoch changed during promotion')
      await client.query(
        `DELETE FROM hosted_worker_leases
         WHERE coordinator_holder_id=$1 AND coordinator_fence_token=$2`,
        [previous.holder_id, previous.fence_token],
      )
      await client.query(
        `UPDATE hosted_primary_wal_checkpoints SET
           primary_holder_id=$2,primary_fence_token=$3,
           target_lsn=pg_current_wal_flush_lsn(),recorded_at=clock_timestamp()
         WHERE checkpoint_name=$1`,
        [leaseName, holderId, token.toString()],
      )
      return {
        fence: { leaseName, holderId, token, expiresAt: lease.expires_at },
        replication,
      }
    })
  }

  async acquireWorkerLease(
    component: string,
    workerId: string,
    expectedCoordinatorId: string,
    ttlMs: number,
  ): Promise<CoordinatorFence | null> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(component)) throw new Error('invalid worker component')
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(workerId)) throw new Error('invalid worker id')
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(expectedCoordinatorId)) {
      throw new Error('invalid expected coordinator id')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
      throw new Error('worker lease TTL must be from one second through five minutes')
    }
    return this.transaction(async (client) => {
      const coordinator = await client.query<{
        holder_id: string
        fence_token: string
        expires_at: string
      }>(
        `SELECT holder_id, fence_token::text, expires_at::text
         FROM coordinator_leases
         WHERE lease_name = 'coordinator-writer'
           AND holder_id = $1 AND expires_at > clock_timestamp()
         FOR SHARE`,
        [expectedCoordinatorId],
      )
      const active = coordinator.rows[0]
      if (!active) return null
      const existing = await client.query<{
        worker_id: string
        worker_fence_token: string
        coordinator_holder_id: string
        coordinator_fence_token: string
        expired: boolean
      }>(
        `SELECT worker_id, worker_fence_token::text, coordinator_holder_id,
                coordinator_fence_token::text,
                expires_at <= clock_timestamp() AS expired
         FROM hosted_worker_leases WHERE component = $1 FOR UPDATE`,
        [component],
      )
      const row = existing.rows[0]
      const sameEpoch = row
        && row.coordinator_holder_id === active.holder_id
        && row.coordinator_fence_token === active.fence_token
      if (row && !row.expired && sameEpoch && row.worker_id !== workerId) return null
      const renewsExactLease = row && !row.expired && sameEpoch && row.worker_id === workerId
      const workerToken = row
        ? renewsExactLease
          ? BigInt(row.worker_fence_token)
          : BigInt(row.worker_fence_token) + 1n
        : 1n
      const updated = await client.query<{ expires_at: string }>(
        `INSERT INTO hosted_worker_leases(
           component, worker_id, worker_fence_token, coordinator_holder_id,
           coordinator_fence_token, expires_at
         ) VALUES (
           $1,$2,$3,$4,$5,
           LEAST($6::timestamptz, clock_timestamp() + ($7::bigint * interval '1 millisecond'))
         )
         ON CONFLICT (component) DO UPDATE SET
           worker_id = EXCLUDED.worker_id,
           worker_fence_token = EXCLUDED.worker_fence_token,
           coordinator_holder_id = EXCLUDED.coordinator_holder_id,
           coordinator_fence_token = EXCLUDED.coordinator_fence_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = clock_timestamp()
         RETURNING expires_at::text`,
        [
          component,
          workerId,
          workerToken.toString(),
          active.holder_id,
          active.fence_token,
          active.expires_at,
          ttlMs,
        ],
      )
      return {
        leaseName: 'coordinator-writer',
        holderId: active.holder_id,
        token: BigInt(active.fence_token),
        expiresAt: updated.rows[0]!.expires_at,
        delegation: { component, workerId, token: workerToken },
      }
    })
  }

  async releaseLease(fence: CoordinatorFence): Promise<boolean> {
    if (fence.delegation) {
      const result = await this.pool.query(
        `DELETE FROM hosted_worker_leases
         WHERE component = $1 AND worker_id = $2 AND worker_fence_token = $3
           AND coordinator_holder_id = $4 AND coordinator_fence_token = $5`,
        [
          fence.delegation.component,
          fence.delegation.workerId,
          fence.delegation.token.toString(),
          fence.holderId,
          fence.token.toString(),
        ],
      )
      return result.rowCount === 1
    }
    const result = await this.pool.query(
      `UPDATE coordinator_leases SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE lease_name = $1 AND holder_id = $2 AND fence_token = $3`,
      [fence.leaseName, fence.holderId, fence.token.toString()],
    )
    return result.rowCount === 1
  }

  private keyHash(token: string): Buffer {
    return createHmac('sha256', this.apiKeyPepper).update(token, 'utf8').digest()
  }

  async upsertTenant(
    fence: CoordinatorFence,
    input: { tenantId: string; displayName: string; tier: string; limits?: Partial<TenantLimits> },
  ): Promise<void> {
    const limits = { ...DEFAULT_TENANT_LIMITS, ...(input.limits ?? {}) }
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        `INSERT INTO hosted_tenants(tenant_id, display_name, tier, limits)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           display_name = EXCLUDED.display_name, tier = EXCLUDED.tier,
           limits = EXCLUDED.limits, updated_at = clock_timestamp()`,
        [input.tenantId, input.displayName, input.tier, JSON.stringify(limits)],
      )
      await this.outbox(client, input.tenantId, 'tenant.updated', input.tenantId, {
        tier: input.tier,
        limits,
      })
    })
  }

  async createWalletChallenge(
    fence: CoordinatorFence,
    input: {
      tenantId: string
      chainId: number
      allocationId: `0x${string}`
      walletAddress: `0x${string}`
      domain: string
      uri: string
      sessionTtlSeconds: number
      idempotencyKey: string
    },
  ): Promise<{ challenge: HostedWalletChallenge; created: boolean }> {
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) throw new Error('wallet challenge chain id is invalid')
    if (!/^0x[0-9a-f]{64}$/.test(input.allocationId)) throw new Error('wallet challenge allocation id is invalid')
    if (!/^0x[0-9a-f]{40}$/.test(input.walletAddress)) throw new Error('wallet challenge address is invalid')
    if (!Number.isSafeInteger(input.sessionTtlSeconds) || input.sessionTtlSeconds < 600 || input.sessionTtlSeconds > 3_600) {
      throw new Error('wallet session lifetime must be from 600 through 3600 seconds')
    }
    const requestHash=createHash('sha256').update(canonicalJson({
      tenantId:input.tenantId,chainId:input.chainId,allocationId:input.allocationId,
      walletAddress:input.walletAddress,domain:input.domain,uri:input.uri,
      sessionTtlSeconds:input.sessionTtlSeconds,
    })).digest('hex')
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const existing=await client.query<WalletChallengeRow>(
        `SELECT challenge_id,tenant_id,chain_id::text,allocation_id,wallet_address,domain,uri,message,
                request_hash,idempotency_key,expires_at::text,session_expires_at::text,used_at::text
         FROM hosted_wallet_challenges WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.tenantId,input.idempotencyKey],
      )
      const replay=existing.rows[0]
      if (replay) {
        if (replay.request_hash!==requestHash) throw new Error('wallet challenge idempotency key is bound to another request')
        return { challenge:hostedWalletChallenge(replay),created:false }
      }
      const now=await client.query<{ now:string }>('SELECT clock_timestamp()::text AS now')
      const issuedAt=new Date(now.rows[0]!.now)
      const expiresAt=new Date(issuedAt.getTime()+5*60_000)
      const sessionExpiresAt=new Date(issuedAt.getTime()+input.sessionTtlSeconds*1_000)
      const nonce=randomBytes(16).toString('hex')
      const challengeId=`wch_${randomBytes(12).toString('hex')}`
      const message=[
        `${input.domain} wants you to sign in with your Ethereum account:`,
        input.walletAddress,'','Authorize an allocation-scoped zkdeal hosted session.','',
        `URI: ${input.uri}`,'Version: 1',`Chain ID: ${input.chainId}`,`Nonce: ${nonce}`,
        `Issued At: ${issuedAt.toISOString()}`,`Expiration Time: ${expiresAt.toISOString()}`,
        `Session Expiration Time: ${sessionExpiresAt.toISOString()}`,
        `Tenant ID: ${input.tenantId}`,`Allocation ID: ${input.allocationId}`,
      ].join('\n')
      const inserted=await client.query<WalletChallengeRow>(
        `INSERT INTO hosted_wallet_challenges(
           challenge_id,tenant_id,chain_id,allocation_id,wallet_address,domain,uri,nonce_hash,
           message,request_hash,idempotency_key,expires_at,session_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING challenge_id,tenant_id,chain_id::text,allocation_id,wallet_address,domain,uri,message,
                   request_hash,idempotency_key,expires_at::text,session_expires_at::text,used_at::text`,
        [challengeId,input.tenantId,input.chainId,input.allocationId,input.walletAddress,input.domain,input.uri,
          createHash('sha256').update(nonce).digest(),message,requestHash,input.idempotencyKey,
          expiresAt.toISOString(),sessionExpiresAt.toISOString()],
      )
      await this.outbox(client,input.tenantId,'wallet.challenge-created',challengeId,{
        chainId:input.chainId,allocationId:input.allocationId,expiresAt:expiresAt.toISOString(),
      },'tenant')
      return { challenge:hostedWalletChallenge(inserted.rows[0]!),created:true }
    })
  }

  async walletChallenge(challengeId: string): Promise<HostedWalletChallenge | null> {
    const result=await this.pool.query<WalletChallengeRow>(
      `SELECT challenge_id,tenant_id,chain_id::text,allocation_id,wallet_address,domain,uri,message,
              request_hash,idempotency_key,expires_at::text,session_expires_at::text,used_at::text
       FROM hosted_wallet_challenges WHERE challenge_id=$1`,[challengeId],
    )
    return result.rows[0] ? hostedWalletChallenge(result.rows[0]) : null
  }

  async canonicalAllocationAuthority(
    chainId:number,tenantId:string,allocationId:`0x${string}`,
  ):Promise<HostedAllocationAuthority|null> {
    const result=await this.pool.query<{
      fact_id:string;tenant_id:string;room_id:string;block_number:string;block_hash:`0x${string}`
    }>(
      `SELECT fact.fact_id::text,fact.block_number::text,fact.block_hash,
              observation.tenant_id,fact.room_id::text
       FROM hosted_indexer_facts AS fact
       JOIN hosted_room_observations AS observation
         ON observation.chain_id=fact.chain_id AND observation.room_id=fact.room_id
       WHERE fact.chain_id=$1 AND fact.canonical AND observation.reconciled
         AND observation.tenant_id=$2 AND fact.room_id IS NOT NULL
         AND fact.payload #>> '{provenance,eventName}' IN ('AllocationUsed','AllocationRenewed')
         AND lower(COALESCE(fact.payload #>> '{args,allocationId}',
                            fact.payload #>> '{args,newAllocationId}'))=lower($3)
       ORDER BY fact.block_number DESC,fact.fact_id DESC LIMIT 1`,
      [chainId,tenantId,allocationId],
    )
    const row=result.rows[0]
    return row ? {
      factId:row.fact_id,tenantId:row.tenant_id,allocationId,roomId:row.room_id,
      blockNumber:row.block_number,blockHash:row.block_hash,
    } : null
  }

  async issueWalletSession(
    fence:CoordinatorFence,
    input:{
      challengeId:string
      signature:`0x${string}`
      idempotencyKey:string
      authority:HostedAllocationAuthority
      authorityHead:{ number:string;hash:`0x${string}` }
    },
  ):Promise<{
    token:string;principalId:string;tenantId:string;chainId:number;allocationId:`0x${string}`
    roomId:string;walletAddress:`0x${string}`;expiresAt:string;already:boolean
  }> {
    if (!/^wch_[0-9a-f]{24}$/.test(input.challengeId)) throw new Error('wallet challenge id is invalid')
    if (!/^0x[0-9a-f]{130}$/.test(input.signature)) throw new Error('wallet signature is invalid')
    const requestHash=createHash('sha256').update(canonicalJson({
      challengeId:input.challengeId,signature:input.signature,idempotencyKey:input.idempotencyKey,
    })).digest('hex')
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const challengeResult=await client.query<WalletChallengeRow>(
        `SELECT challenge_id,tenant_id,chain_id::text,allocation_id,wallet_address,domain,uri,message,
                request_hash,idempotency_key,expires_at::text,session_expires_at::text,used_at::text
         FROM hosted_wallet_challenges WHERE challenge_id=$1 FOR UPDATE`,[input.challengeId],
      )
      const challenge=challengeResult.rows[0]
      if (!challenge) throw new HostedAuthError('wallet challenge was not found')
      const generated=this.walletSessionPrincipal(challenge.challenge_id,challenge.message)
      if (challenge.used_at!==null) {
        const replay=await client.query<{
          tenant_id:string;chain_id:string;allocation_id:`0x${string}`;room_id:string;
          wallet_address:`0x${string}`;expires_at:string;verification_request_hash:string;
          verification_idempotency_key:string
        }>(
          `SELECT tenant_id,chain_id::text,allocation_id,room_id::text,wallet_address,expires_at::text,
                  verification_request_hash,verification_idempotency_key
           FROM hosted_wallet_sessions WHERE challenge_id=$1`,[input.challengeId],
        )
        const row=replay.rows[0]
        if (!row || row.verification_request_hash!==requestHash
          || row.verification_idempotency_key!==input.idempotencyKey) {
          throw new HostedAuthError('wallet challenge nonce has already been consumed')
        }
        return {
          token:generated.token,principalId:generated.principalId,tenantId:row.tenant_id,
          chainId:Number(row.chain_id),allocationId:row.allocation_id,roomId:row.room_id,
          walletAddress:row.wallet_address,expiresAt:row.expires_at,already:true,
        }
      }
      const freshness=await client.query(
        `SELECT 1 FROM hosted_wallet_challenges
         WHERE challenge_id=$1 AND expires_at>clock_timestamp()
           AND session_expires_at>clock_timestamp() FOR SHARE`,[input.challengeId],
      )
      if (freshness.rowCount!==1) throw new HostedAuthError('wallet challenge is expired')
      if (
        challenge.tenant_id!==input.authority.tenantId
        || challenge.allocation_id!==input.authority.allocationId
      ) throw new HostedAuthError('wallet allocation authority belongs to another tenant')
      const authority=await client.query<{
        fact_id:string;room_id:string;block_number:string;block_hash:string;tenant_id:string
      }>(
        `SELECT fact.fact_id::text,fact.room_id::text,fact.block_number::text,fact.block_hash,
                observation.tenant_id
         FROM hosted_indexer_facts AS fact
         JOIN hosted_room_observations AS observation
           ON observation.chain_id=fact.chain_id AND observation.room_id=fact.room_id
         WHERE fact.fact_id=$1 AND fact.chain_id=$2 AND fact.canonical
           AND lower(fact.block_hash)=lower($3) AND observation.reconciled
           AND observation.tenant_id=$4
           AND fact.payload #>> '{provenance,eventName}' IN ('AllocationUsed','AllocationRenewed')
           AND lower(COALESCE(fact.payload #>> '{args,allocationId}',
                              fact.payload #>> '{args,newAllocationId}'))=lower($5)
         FOR SHARE OF fact,observation`,
        [input.authority.factId,challenge.chain_id,input.authority.blockHash,
          challenge.tenant_id,challenge.allocation_id],
      )
      const authorityRow=authority.rows[0]
      if (!authorityRow || authorityRow.room_id!==input.authority.roomId
        || authorityRow.block_number!==input.authority.blockNumber) {
        throw new HostedAuthError('wallet allocation authority is no longer canonical')
      }
      const canonicalHead=await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id=$1 AND block_number=$2 AND lower(block_hash)=lower($3) AND canonical
         FOR SHARE`,[challenge.chain_id,input.authorityHead.number,input.authorityHead.hash],
      )
      if (canonicalHead.rowCount!==1 || BigInt(input.authorityHead.number)<BigInt(authorityRow.block_number)) {
        throw new HostedAuthError('wallet authority head is stale or no longer canonical')
      }
      const tenant=await client.query<{ limits:TenantLimits }>(
        `SELECT limits FROM hosted_tenants WHERE tenant_id=$1 AND active FOR SHARE`,[challenge.tenant_id],
      )
      if (!tenant.rows[0]) throw new HostedAuthError('wallet challenge tenant is inactive')
      await this.insertPrincipal(client,generated,{
        tenantId:challenge.tenant_id,kind:'api-key',roles:['job-submit','job-read'],
        limits:{ ...DEFAULT_TENANT_LIMITS,...tenant.rows[0].limits },
      })
      await client.query(
        `UPDATE hosted_principals SET overlap_until=$2 WHERE principal_id=$1`,
        [generated.principalId,challenge.session_expires_at],
      )
      await client.query(
        `INSERT INTO hosted_wallet_sessions(
           principal_id,challenge_id,tenant_id,chain_id,allocation_id,room_id,wallet_address,
           authority_fact_id,authority_fact_block_hash,authority_head_block,authority_head_hash,
           verification_request_hash,verification_idempotency_key,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [generated.principalId,challenge.challenge_id,challenge.tenant_id,challenge.chain_id,
          challenge.allocation_id,authorityRow.room_id,challenge.wallet_address,authorityRow.fact_id,
          authorityRow.block_hash,input.authorityHead.number,input.authorityHead.hash,
          requestHash,input.idempotencyKey,challenge.session_expires_at],
      )
      const consumed=await client.query(
        `UPDATE hosted_wallet_challenges SET used_at=clock_timestamp()
         WHERE challenge_id=$1 AND used_at IS NULL`,[challenge.challenge_id],
      )
      if (consumed.rowCount!==1) throw new HostedAuthError('wallet challenge nonce was consumed concurrently')
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,idempotency_key,details)
         VALUES ($1,'wallet.session.issue',$2,$3,$4::jsonb)`,
        [generated.principalId,challenge.allocation_id,input.idempotencyKey,JSON.stringify({
          chainId:Number(challenge.chain_id),roomId:authorityRow.room_id,
          authorityFactId:authorityRow.fact_id,authorityHeadHash:input.authorityHead.hash,
        })],
      )
      await this.outbox(client,challenge.tenant_id,'wallet.session-issued',generated.principalId,{
        chainId:Number(challenge.chain_id),allocationId:challenge.allocation_id,
        roomId:authorityRow.room_id,expiresAt:challenge.session_expires_at,
      },'tenant')
      return {
        token:generated.token,principalId:generated.principalId,tenantId:challenge.tenant_id,
        chainId:Number(challenge.chain_id),allocationId:challenge.allocation_id,
        roomId:authorityRow.room_id,walletAddress:challenge.wallet_address,
        expiresAt:challenge.session_expires_at,already:false,
      }
    })
  }

  async provisionPrincipal(
    fence: CoordinatorFence,
    input: {
      tenantId: string
      kind: HostedPrincipalKind
      roles: HostedRole[]
      limits?: Partial<TenantLimits>
    },
  ): Promise<{ principalId: string; token: string }> {
    validatePrincipalRoles(input.kind, input.roles)
    const generated = this.generatePrincipal(input.kind)
    const limits = { ...DEFAULT_TENANT_LIMITS, ...(input.limits ?? {}) }
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await this.insertPrincipal(client, generated, { ...input, limits })
      await this.outbox(client, input.tenantId, 'principal.provisioned', generated.principalId, {
        kind: input.kind,
        roles: input.roles,
      })
    })
    return generated
  }

  private generatePrincipal(kind: HostedPrincipalKind): { principalId: string; token: string } {
    const prefix = kind === 'node' ? 'node' : kind === 'service' ? 'svc' : 'key'
    const principalId = `${prefix}_${randomBytes(10).toString('hex')}`
    return {
      principalId,
      token: `zkd.${principalId}.${randomBytes(32).toString('base64url')}`,
    }
  }

  private walletSessionPrincipal(challengeId:string,message:string):{ principalId:string;token:string } {
    const principalId=`key_${createHash('sha256').update(`wallet-session\0${challengeId}`).digest('hex').slice(0,20)}`
    const secret=createHmac('sha256',this.apiKeyPepper)
      .update(`wallet-session\0${challengeId}\0${createHash('sha256').update(message).digest('hex')}`)
      .digest('base64url')
    return { principalId,token:`zkd.${principalId}.${secret}` }
  }

  private async insertPrincipal(
    client: SqlClient,
    generated: { principalId: string; token: string },
    input: {
      tenantId: string
      kind: HostedPrincipalKind
      roles: HostedRole[]
      limits: TenantLimits
    },
  ): Promise<void> {
    validatePrincipalRoles(input.kind, input.roles)
    await client.query(
      `INSERT INTO hosted_principals(
         principal_id, tenant_id, kind, key_hash, roles, limits
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        generated.principalId,
        input.tenantId,
        input.kind,
        this.keyHash(generated.token),
        input.roles,
        JSON.stringify(input.limits),
      ],
    )
  }

  async authenticate(token: string, kind?: HostedPrincipalKind): Promise<HostedPrincipal | null> {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'zkd' || !/^(key|node|svc)_[0-9a-f]{20}$/.test(parts[1]!)) {
      return null
    }
    const result = await this.pool.query<PrincipalRow>(
      `UPDATE hosted_principals
       SET last_used_at = clock_timestamp()
       WHERE principal_id = $1 AND key_hash = $2 AND active
         AND revoked_at IS NULL
         AND (overlap_until IS NULL OR overlap_until > clock_timestamp())
         AND ($3::text IS NULL OR kind = $3)
       RETURNING principal_id, tenant_id, kind, roles, limits`,
      [parts[1], this.keyHash(token), kind ?? null],
    )
    const row = result.rows[0]
    if (!row) return null
    const scoped=await this.pool.query<{
      chain_id:string;allocation_id:`0x${string}`;room_id:string;wallet_address:`0x${string}`;
      authority_fact_id:string;authority_fact_block_hash:`0x${string}`;expires_at:string;
      session_active:boolean;fact_canonical:boolean;head_canonical:boolean;disposed:boolean
    }>(
      `SELECT session.chain_id::text,session.allocation_id,session.room_id::text,
              session.wallet_address,session.authority_fact_id::text,session.authority_fact_block_hash,
              session.expires_at::text,(session.expires_at>clock_timestamp()) AS session_active,
              COALESCE(fact.canonical,false) AS fact_canonical,
              COALESCE(head.canonical,false) AS head_canonical,
              EXISTS (
                SELECT 1 FROM hosted_indexer_facts AS disposed
                WHERE disposed.chain_id=session.chain_id AND disposed.canonical
                  AND disposed.payload #>> '{provenance,eventName}'='AllocationDisposed'
                  AND lower(disposed.payload #>> '{args,allocationId}')=lower(session.allocation_id)
              ) AS disposed
       FROM hosted_wallet_sessions AS session
       LEFT JOIN hosted_indexer_facts AS fact
         ON fact.fact_id=session.authority_fact_id
        AND lower(fact.block_hash)=lower(session.authority_fact_block_hash)
       LEFT JOIN canonical_l1_blocks AS head
         ON head.chain_id=session.chain_id AND head.block_number=session.authority_head_block
        AND lower(head.block_hash)=lower(session.authority_head_hash)
       WHERE session.principal_id=$1`,[row.principal_id],
    )
    const walletScope=scoped.rows[0]
    if (walletScope
      && (!walletScope.session_active || !walletScope.fact_canonical || !walletScope.head_canonical || walletScope.disposed)) {
      return null
    }
    return {
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      kind: row.kind,
      roles: row.roles,
      limits: { ...DEFAULT_TENANT_LIMITS, ...row.limits },
      ...(walletScope ? { walletSession:{
        chainId:Number(walletScope.chain_id),allocationId:walletScope.allocation_id,
        roomId:walletScope.room_id,walletAddress:walletScope.wallet_address,
        authorityFactId:walletScope.authority_fact_id,
        authorityBlockHash:walletScope.authority_fact_block_hash,expiresAt:walletScope.expires_at,
      } } : {}),
    }
  }

  async principalScope(principalId: string): Promise<{
    tenantId: string
    kind: HostedPrincipalKind
    active: boolean
  } | null> {
    const result = await this.pool.query<{
      tenant_id: string
      kind: HostedPrincipalKind
      active: boolean
    }>(
      `SELECT tenant_id, kind, active AND revoked_at IS NULL AS active
       FROM hosted_principals WHERE principal_id = $1`,
      [principalId],
    )
    const row = result.rows[0]
    return row ? { tenantId: row.tenant_id, kind: row.kind, active: row.active } : null
  }

  async assignL1ServiceBinding(
    fence: CoordinatorFence,
    input: {
      principalId: string
      bindingKind: HostedL1BindingKind
      chainId: number
      contractAddress: `0x${string}`
      expectedSender: `0x${string}`
      nodeId?: `0x${string}` | null
      roomId?: string | null
      sponsorshipId?: string | null
      allocationId?: `0x${string}` | null
    },
  ): Promise<{ binding: HostedL1ServiceBinding; created: boolean }> {
    const contractAddress = input.contractAddress.toLowerCase() as `0x${string}`
    const expectedSender = input.expectedSender.toLowerCase() as `0x${string}`
    const nodeId = input.nodeId?.toLowerCase() as `0x${string}` | null | undefined
    const roomId = input.roomId ?? null
    const sponsorshipId=input.sponsorshipId ?? null
    const allocationId=input.allocationId?.toLowerCase() as `0x${string}` | null | undefined
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('binding chainId is invalid')
    if (!/^0x[0-9a-f]{40}$/.test(contractAddress) || !/^0x[0-9a-f]{40}$/.test(expectedSender)) {
      throw new Error('binding addresses are malformed')
    }
    const noNode=nodeId==null,noRoom=roomId===null,noSponsor=sponsorshipId===null,noAllocation=allocationId==null
    const scopeValid=(
      (input.bindingKind==='node-liveness' && !noNode && /^0x[0-9a-f]{64}$/.test(nodeId!) && noRoom && noSponsor && noAllocation)
      || (input.bindingKind==='room-submit' && noNode && !noRoom && /^(?:0|[1-9][0-9]*)$/.test(roomId!) && noSponsor && noAllocation)
      || (input.bindingKind==='room-aggregate' && noNode && noRoom && noSponsor && noAllocation)
      || (input.bindingKind==='pool-sponsor' && noNode && noRoom && sponsorshipId!==null
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sponsorshipId) && noAllocation)
      || (input.bindingKind==='pool-finality-oracle' && noNode && !noRoom
        && /^(?:0|[1-9][0-9]*)$/.test(roomId!) && noSponsor && noAllocation)
      || (input.bindingKind==='pool-beneficiary' && noNode && noRoom && noSponsor
        && !noAllocation && /^0x[0-9a-f]{64}$/.test(allocationId!))
    )
    if (!scopeValid) throw new Error('L1 service binding scope is malformed')
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const principal = await client.query<{ kind: HostedPrincipalKind;roles: HostedRole[] }>(
        `SELECT kind,roles FROM hosted_principals
         WHERE principal_id=$1 AND active AND revoked_at IS NULL FOR UPDATE`, [input.principalId],
      )
      const identity = principal.rows[0]
      const requiredRole=HOSTED_L1_BINDING_ROLE[input.bindingKind]
      if (!identity || identity.kind !== 'service' || !identity.roles.includes(requiredRole)) {
        throw new HostedAuthError(`active service principal with ${requiredRole} role is required`)
      }
      const existing = await client.query<{
        principal_id: string;binding_kind: HostedL1BindingKind;chain_id: string
        contract_address: `0x${string}`;expected_sender: `0x${string}`
        node_id: `0x${string}` | null;room_id: string | null;sponsorship_id:string|null
        allocation_id:`0x${string}`|null;active: boolean
        created_at: string;updated_at: string
      }>(
        `SELECT principal_id,binding_kind,chain_id::text,contract_address,expected_sender,
                node_id,room_id::text,sponsorship_id,allocation_id,active,created_at::text,updated_at::text
         FROM hosted_l1_service_bindings WHERE principal_id=$1 FOR UPDATE`, [input.principalId],
      )
      const prior = existing.rows[0]
      if (prior) {
        if (
          prior.binding_kind !== input.bindingKind || Number(prior.chain_id) !== input.chainId
          || prior.contract_address !== contractAddress || prior.expected_sender !== expectedSender
          || prior.node_id !== (nodeId ?? null) || prior.room_id !== roomId
          || prior.sponsorship_id!==sponsorshipId || prior.allocation_id!==(allocationId ?? null) || !prior.active
        ) throw new Error('L1 service principal is already bound to different immutable authority')
        return { binding: {
          principalId: prior.principal_id,bindingKind: prior.binding_kind,chainId: Number(prior.chain_id),
          contractAddress: prior.contract_address,expectedSender: prior.expected_sender,
          nodeId: prior.node_id,roomId: prior.room_id,sponsorshipId:prior.sponsorship_id,
          allocationId:prior.allocation_id,active: prior.active,
          createdAt: prior.created_at,updatedAt: prior.updated_at,
        },created: false }
      }
      const inserted = await client.query<{
        principal_id: string;binding_kind: HostedL1BindingKind;chain_id: string
        contract_address: `0x${string}`;expected_sender: `0x${string}`
        node_id: `0x${string}` | null;room_id: string | null;sponsorship_id:string|null
        allocation_id:`0x${string}`|null;active: boolean
        created_at: string;updated_at: string
      }>(
        `INSERT INTO hosted_l1_service_bindings(
           principal_id,binding_kind,chain_id,contract_address,expected_sender,node_id,room_id,
           sponsorship_id,allocation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING principal_id,binding_kind,chain_id::text,contract_address,expected_sender,
                   node_id,room_id::text,sponsorship_id,allocation_id,active,created_at::text,updated_at::text`,
        [input.principalId,input.bindingKind,input.chainId,contractAddress,expectedSender,nodeId ?? null,
          roomId,sponsorshipId,allocationId ?? null],
      )
      const row=inserted.rows[0]!
      return { binding: {
        principalId: row.principal_id,bindingKind: row.binding_kind,chainId: Number(row.chain_id),
        contractAddress: row.contract_address,expectedSender: row.expected_sender,nodeId: row.node_id,
        roomId: row.room_id,sponsorshipId:row.sponsorship_id,allocationId:row.allocation_id,
        active: row.active,createdAt: row.created_at,updatedAt: row.updated_at,
      },created: true }
    })
  }

  async l1ServiceBinding(principalId: string): Promise<HostedL1ServiceBinding | null> {
    const result = await this.pool.query<{
      principal_id: string;binding_kind: HostedL1BindingKind;chain_id: string
      contract_address: `0x${string}`;expected_sender: `0x${string}`
      node_id: `0x${string}` | null;room_id: string | null;sponsorship_id:string|null
      allocation_id:`0x${string}`|null;active: boolean
      created_at: string;updated_at: string
    }>(
      `SELECT principal_id,binding_kind,chain_id::text,contract_address,expected_sender,
              node_id,room_id::text,sponsorship_id,allocation_id,active,created_at::text,updated_at::text
       FROM hosted_l1_service_bindings WHERE principal_id=$1`, [principalId],
    )
    const row=result.rows[0]
    return row ? {
      principalId: row.principal_id,bindingKind: row.binding_kind,chainId: Number(row.chain_id),
      contractAddress: row.contract_address,expectedSender: row.expected_sender,nodeId: row.node_id,
      roomId: row.room_id,sponsorshipId:row.sponsorship_id,allocationId:row.allocation_id,
      active: row.active,createdAt: row.created_at,updatedAt: row.updated_at,
    } : null
  }

  async l1OperationAccess(operationId: string): Promise<HostedL1OperationAccess | null> {
    const result = await this.pool.query<{
      operation_id: string;tenant_id: string;principal_id: string;correlation_id: string
      minimum_confirmations: number;require_finalized: boolean;binding_kind: HostedL1BindingKind
      created_at: string
    }>(
      `SELECT operation_id,tenant_id,principal_id,correlation_id,minimum_confirmations,
              require_finalized,binding_kind,created_at::text
       FROM hosted_l1_operation_access WHERE operation_id=$1`, [operationId],
    )
    const row=result.rows[0]
    return row ? {
      operationId: row.operation_id,tenantId: row.tenant_id,principalId: row.principal_id,
      correlationId: row.correlation_id,minimumConfirmations: row.minimum_confirmations,
      requireFinalized: row.require_finalized,bindingKind: row.binding_kind,createdAt: row.created_at,
    } : null
  }

  async rotatePrincipal(
    fence: CoordinatorFence,
    principalId: string,
    overlapMs: number,
  ): Promise<{ principalId: string; token: string }> {
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > 24 * 60 * 60_000) {
      throw new Error('principal overlap must be from zero through one day')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const existing = await client.query<PrincipalRow>(
        `SELECT principal_id, tenant_id, kind, roles, limits
         FROM hosted_principals
         WHERE principal_id = $1 AND active AND revoked_at IS NULL
         FOR UPDATE`,
        [principalId],
      )
      const row = existing.rows[0]
      if (!row) throw new HostedAuthError('principal is not active')
      validatePrincipalRoles(row.kind, row.roles)
      const replacement = this.generatePrincipal(row.kind)
      await this.insertPrincipal(client, replacement, {
        tenantId: row.tenant_id,
        kind: row.kind,
        roles: row.roles,
        limits: { ...DEFAULT_TENANT_LIMITS, ...row.limits },
      })
      // A scoped hosted service remains usable throughout the credential
      // overlap without accepting a caller-authored replacement scope.
      await client.query(
        `INSERT INTO hosted_l1_service_bindings(
           principal_id,binding_kind,chain_id,contract_address,expected_sender,node_id,room_id,
           sponsorship_id,allocation_id,active
         ) SELECT $2,binding_kind,chain_id,contract_address,expected_sender,node_id,room_id,
                  sponsorship_id,allocation_id,active
           FROM hosted_l1_service_bindings WHERE principal_id=$1`,
        [principalId,replacement.principalId],
      )
      const updated = await client.query(
        `UPDATE hosted_principals
         SET overlap_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
         WHERE principal_id = $1 AND active AND revoked_at IS NULL`,
        [principalId, overlapMs],
      )
      if (updated.rowCount !== 1) throw new HostedAuthError('principal changed while rotating')
      await this.outbox(client, row.tenant_id, 'principal.rotated', principalId, {
        replacementPrincipalId: replacement.principalId,
        overlapMs,
      })
      return replacement
    })
  }

  async revokePrincipal(fence: CoordinatorFence, principalId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ tenant_id: string }>(
        `UPDATE hosted_principals SET active = false, revoked_at = clock_timestamp()
         WHERE principal_id = $1 AND active RETURNING tenant_id`,
        [principalId],
      )
      const row = result.rows[0]
      if (row) await this.outbox(client, row.tenant_id, 'principal.revoked', principalId, {})
      return result.rowCount === 1
    })
  }

  async revokeWalletSession(
    fence:CoordinatorFence,principalId:string,idempotencyKey:string,
  ):Promise<boolean> {
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const result=await client.query<{ tenant_id:string;allocation_id:string }>(
        `UPDATE hosted_principals AS principal SET active=false,revoked_at=clock_timestamp()
         FROM hosted_wallet_sessions AS session
         WHERE principal.principal_id=$1 AND principal.principal_id=session.principal_id
           AND principal.active
         RETURNING principal.tenant_id,session.allocation_id`,[principalId],
      )
      const row=result.rows[0]
      if (!row) return false
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,idempotency_key,details)
         VALUES ($1,'wallet.session.revoke',$2,$3,'{}'::jsonb)`,
        [principalId,row.allocation_id,idempotencyKey],
      )
      await this.outbox(client,row.tenant_id,'wallet.session-revoked',principalId,{
        allocationId:row.allocation_id,
      },'tenant')
      return true
    })
  }

  async reserveAdmission(
    fence: CoordinatorFence,
    input: Omit<AdmissionWalRecord, 'receipt' | 'status' | 'leaseOwner' | 'leaseExpiresAt' | 'createdAt' | 'updatedAt'>,
  ): Promise<AdmissionWalRecord> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-admission:' || $1::text))", [input.roomId])
      const unresolved = await client.query<AdmissionRow>(
        `SELECT room_id::text, admission_id::text, tenant_id,
                transaction_hash, raw_signed_transaction, sender, request,
                receipt, status, lease_owner, lease_expires_at::text,
                created_at::text, updated_at::text
         FROM admission_wal
         WHERE room_id=$1 AND status='RESERVED' AND receipt IS NULL
         ORDER BY admission_id LIMIT 1 FOR UPDATE`,
        [input.roomId],
      )
      const head = unresolved.rows[0]
      if (head) {
        if (head.admission_id !== input.admissionId) {
          throw new Error('an earlier admission reservation must be signed and committed before issuing another id')
        }
        if (
          head.tenant_id !== input.tenantId
          || head.transaction_hash.toLowerCase() !== input.transactionHash.toLowerCase()
          || head.raw_signed_transaction.toLowerCase() !== input.rawSignedTransaction.toLowerCase()
          || head.sender.toLowerCase() !== input.sender.toLowerCase()
          || canonicalJson(head.request) !== canonicalJson(input.request)
        ) throw new Error('admission id is bound to different immutable WAL bytes')
        return admission(head)
      }
      const depositInboxId = input.request.depositInboxId
      if (depositInboxId !== '0') {
        const depositConflict = await client.query<{ admission_id: string }>(
          `SELECT admission_id::text FROM admission_wal
           WHERE room_id=$1 AND status<>'CANCELLED'
             AND request->>'depositInboxId'=$2
             AND admission_id<>$3
           ORDER BY admission_id LIMIT 1 FOR UPDATE`,
          [input.roomId,depositInboxId,input.admissionId],
        )
        if (depositConflict.rows[0]) {
          throw new Error('deposit inbox id is already bound to an unresolved admission')
        }
      }
      const result = await client.query<AdmissionRow>(
        `INSERT INTO admission_wal(
           room_id, admission_id, tenant_id, transaction_hash,
           raw_signed_transaction, sender, request, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'RESERVED')
         ON CONFLICT (room_id, admission_id) DO NOTHING
         RETURNING room_id::text, admission_id::text, tenant_id,
                   transaction_hash, raw_signed_transaction, sender, request,
                   receipt, status, lease_owner, lease_expires_at::text,
                   created_at::text, updated_at::text`,
        [
          input.roomId,
          input.admissionId,
          input.tenantId,
          input.transactionHash,
          input.rawSignedTransaction,
          input.sender,
          JSON.stringify(input.request),
        ],
      )
      let row = result.rows[0]
      if (!row) {
        const existing = await client.query<AdmissionRow>(
          `SELECT room_id::text, admission_id::text, tenant_id,
                  transaction_hash, raw_signed_transaction, sender, request,
                  receipt, status, lease_owner, lease_expires_at::text,
                  created_at::text, updated_at::text
           FROM admission_wal WHERE room_id = $1 AND admission_id = $2 FOR UPDATE`,
          [input.roomId, input.admissionId],
        )
        row = existing.rows[0]
        if (
          !row
          || row.tenant_id !== input.tenantId
          || row.transaction_hash.toLowerCase() !== input.transactionHash.toLowerCase()
          || row.raw_signed_transaction.toLowerCase() !== input.rawSignedTransaction.toLowerCase()
          || row.sender.toLowerCase() !== input.sender.toLowerCase()
          || canonicalJson(row.request) !== canonicalJson(input.request)
        ) throw new Error('admission id is bound to different immutable WAL bytes')
      } else {
        await this.outbox(client, input.tenantId, 'admission.reserved', `${input.roomId}:${input.admissionId}`, {
          transactionHash: input.transactionHash,
        })
      }
      return admission(row)
    })
  }

  async commitAdmission(
    fence: CoordinatorFence,
    roomId: string,
    admissionId: string,
    receipt: object,
  ): Promise<AdmissionWalRecord> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<AdmissionRow>(
        `UPDATE admission_wal SET receipt = $3::jsonb, status = 'COMMITTED',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE room_id = $1 AND admission_id = $2
           AND status = 'RESERVED'
         RETURNING room_id::text, admission_id::text, tenant_id,
                   transaction_hash, raw_signed_transaction, sender, request,
                   receipt, status, lease_owner, lease_expires_at::text,
                   created_at::text, updated_at::text`,
        [roomId, admissionId, JSON.stringify(receipt)],
      )
      let row = result.rows[0]
      if (!row) {
        const existing = await client.query<AdmissionRow>(
          `SELECT room_id::text, admission_id::text, tenant_id,
                  transaction_hash, raw_signed_transaction, sender, request,
                  receipt, status, lease_owner, lease_expires_at::text,
                  created_at::text, updated_at::text
           FROM admission_wal WHERE room_id = $1 AND admission_id = $2 FOR UPDATE`,
          [roomId, admissionId],
        )
        row = existing.rows[0]
        if (!row || !row.receipt) throw new Error('admission reservation is missing or no longer committable')
        if (canonicalJson(row.receipt) !== canonicalJson(receipt)) {
          throw new Error('admission receipt is already committed with different bytes')
        }
      } else {
        await this.outbox(client, row.tenant_id, 'admission.committed', `${roomId}:${admissionId}`, receipt)
      }
      return admission(row)
    })
  }

  async leaseAdmissions(
    fence: CoordinatorFence,
    roomId: string,
    consumerId: string,
    limit: number,
    leaseMs: number,
    tenantId: string | null = null,
  ): Promise<AdmissionWalRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_024) throw new Error('invalid admission lease limit')
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) throw new Error('invalid admission lease TTL')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-admission:' || $1::text))", [roomId])
      const rows = await client.query<AdmissionRow>(
        `WITH ordered AS (
           SELECT room_id, admission_id,
                  (receipt IS NOT NULL AND (
                    status='COMMITTED' OR (status='LEASED' AND lease_expires_at <= clock_timestamp())
                  )) AS eligible
           FROM admission_wal
           WHERE room_id=$1 AND status NOT IN ('ACKED','CANCELLED')
             AND ($5::text IS NULL OR tenant_id=$5)
           ORDER BY admission_id
         ), ready AS (
           SELECT room_id,admission_id,eligible,
                  bool_and(eligible) OVER (ORDER BY admission_id ROWS UNBOUNDED PRECEDING) AS prefix_ready
           FROM ordered
         ), picked AS (
           SELECT room_id,admission_id FROM ready
           WHERE eligible AND prefix_ready
           ORDER BY admission_id LIMIT $2
         )
         UPDATE admission_wal AS wal SET
           status = 'LEASED', lease_owner = $3,
           lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
         FROM picked
         WHERE wal.room_id = picked.room_id AND wal.admission_id = picked.admission_id
         RETURNING wal.room_id::text, wal.admission_id::text, wal.tenant_id,
                   wal.transaction_hash, wal.raw_signed_transaction, wal.sender, wal.request,
                   wal.receipt, wal.status, wal.lease_owner, wal.lease_expires_at::text,
                   wal.created_at::text, wal.updated_at::text`,
        [roomId, limit, consumerId, leaseMs, tenantId],
      )
      return rows.rows.map(admission)
    })
  }

  async reservedAdmissions(limit = 1_000): Promise<AdmissionWalRecord[]> {
    const result = await this.pool.query<AdmissionRow>(
      `SELECT room_id::text, admission_id::text, tenant_id,
              transaction_hash, raw_signed_transaction, sender, request,
              receipt, status, lease_owner, lease_expires_at::text,
              created_at::text, updated_at::text
       FROM admission_wal
       WHERE status='RESERVED' AND receipt IS NULL
       ORDER BY room_id,admission_id
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 10_000))],
    )
    return result.rows.map(admission)
  }

  async ackAdmissions(
    fence: CoordinatorFence,
    roomId: string,
    consumerId: string,
    admissionIds: string[],
    tenantId: string | null = null,
  ): Promise<number> {
    if (admissionIds.length === 0) return 0
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ tenant_id: string; admission_id: string }>(
        `UPDATE admission_wal SET status = 'ACKED', lease_owner = NULL,
             lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE room_id = $1 AND lease_owner = $2 AND status = 'LEASED'
           AND admission_id = ANY($3::numeric[])
           AND ($4::text IS NULL OR tenant_id = $4)
         RETURNING tenant_id, admission_id::text`,
        [roomId, consumerId, admissionIds, tenantId],
      )
      for (const row of result.rows) {
        await this.outbox(client, row.tenant_id, 'admission.acked', `${roomId}:${row.admission_id}`, {})
      }
      return result.rowCount ?? 0
    })
  }

  async admissionByTransactionHash(transactionHash: string): Promise<AdmissionWalRecord | null> {
    const result = await this.pool.query<AdmissionRow>(
      `SELECT room_id::text, admission_id::text, tenant_id,
              transaction_hash, raw_signed_transaction, sender, request,
              receipt, status, lease_owner, lease_expires_at::text,
              created_at::text, updated_at::text
       FROM admission_wal WHERE lower(transaction_hash) = lower($1)`,
      [transactionHash],
    )
    return result.rows[0] ? admission(result.rows[0]) : null
  }

  /** Exact immutable ACKED records eligible for one hosted batch submission. */
  async acknowledgedAdmissions(
    roomId: string,
    tenantId: string,
    admissionIds: string[],
  ): Promise<AdmissionWalRecord[]> {
    if (admissionIds.length === 0) return []
    if (
      admissionIds.length > 1_024
      || new Set(admissionIds).size !== admissionIds.length
      || admissionIds.some((id) => !/^(?:0|[1-9][0-9]*)$/.test(id))
    ) throw new Error('batch admission ids must be unique unsigned decimals')
    const result=await this.pool.query<AdmissionRow>(
      `SELECT room_id::text,admission_id::text,tenant_id,
              transaction_hash,raw_signed_transaction,sender,request,
              receipt,status,lease_owner,lease_expires_at::text,
              created_at::text,updated_at::text
       FROM admission_wal
       WHERE room_id=$1 AND tenant_id=$2 AND admission_id=ANY($3::numeric[])
       ORDER BY admission_id`,
      [roomId,tenantId,admissionIds],
    )
    const records=result.rows.map(admission)
    if (
      records.length!==admissionIds.length
      || records.some((record) => record.status!=='ACKED' || !record.receipt)
      || records.some((record,index) => record.admissionId!==admissionIds[index])
    ) throw new Error('batch admissions must be the exact ordered ACKED tenant WAL records')
    return records
  }

  async admissionHighWater(roomId: string): Promise<bigint> {
    const result = await this.pool.query<{ high_water: string }>(
      `SELECT COALESCE(max(admission_id), 0)::text AS high_water
       FROM admission_wal WHERE room_id = $1`,
      [roomId],
    )
    return BigInt(result.rows[0]?.high_water ?? '0')
  }

  async admissionPendingCount(roomId: string): Promise<number> {
    const result = await this.pool.query<{ pending: string }>(
      `SELECT count(*)::text AS pending FROM admission_wal
       WHERE room_id = $1 AND status IN ('RESERVED','COMMITTED','LEASED')`,
      [roomId],
    )
    return Number(result.rows[0]?.pending ?? '0')
  }

  async admissionPendingDeposit(roomId: string, depositInboxId: string): Promise<boolean> {
    if (!/^\d+$/.test(depositInboxId) || depositInboxId === '0') return false
    const result = await this.pool.query(
      `SELECT 1 FROM admission_wal
       WHERE room_id=$1 AND status<>'CANCELLED'
         AND request->>'depositInboxId'=$2
       LIMIT 1`,
      [roomId,depositInboxId],
    )
    return result.rowCount === 1
  }

  /**
   * Admission's hosted policy source. The observation must be schema-current,
   * reconciled, and tied to the canonical block journal; caller-authored or
   * replica-local files are never consulted.
   */
  async admissionRoomPolicy(chainId: number, roomId: string): Promise<{
    roomId: string
    status: 'OPEN' | 'CLOSED'
    authorizationMode: 'UNANIMOUS_APPROVERS' | 'VALIDITY_ONLY'
    admissionSigner: `0x${string}` | null
    serviceBond: string
    minimumServiceBond: string
    omissionPenalty: string
    bondEpoch: string
    maximumAdmissionWindow: string
    minimumDepositConfirmations: string
    latestObservedL1Block: string
    latestBatchIndex: string
    admissionCursor: string
    deposits: []
    admissions: []
    batches: []
  } | null> {
    const result = await this.pool.query<{
      document: Record<string, unknown>
      head_block: string
      schema_version: number
      reconciled: boolean
      reconciliation_errors: unknown
    }>(
      `SELECT observation.document,observation.head_block::text,
              observation.schema_version,observation.reconciled,
              observation.reconciliation_errors
       FROM hosted_room_observations AS observation
       JOIN canonical_l1_blocks AS block
         ON block.chain_id=observation.chain_id
        AND block.block_number=observation.head_block
        AND lower(block.block_hash)=lower(observation.head_hash)
        AND block.canonical
       WHERE observation.chain_id=$1 AND observation.room_id=$2`,
      [chainId,roomId],
    )
    const row = result.rows[0]
    if (!row) return null
    if (
      row.schema_version !== 2 || !row.reconciled
      || !Array.isArray(row.reconciliation_errors) || row.reconciliation_errors.length !== 0
    ) throw new Error('hosted room observation is not schema-current and reconciled')
    const document = row.document
    const state = document.roomState
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('hosted room observation lacks the reconciled roomState tuple')
    }
    const room = state as Record<string, unknown>
    const decimal = (name: string): string => {
      const value = String(room[name] ?? '')
      if (!/^\d+$/.test(value)) throw new Error(`hosted room observation has invalid ${name}`)
      return value
    }
    const address = String(room.admissionSigner ?? '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new Error('hosted room observation has invalid admissionSigner')
    }
    const stateValue = String(room.state ?? '')
    const authorizationValue = String(room.authorizationMode ?? '')
    if (!['1','2','Open','Closed','OPEN','CLOSED'].includes(stateValue)) {
      throw new Error('hosted room observation has invalid room state')
    }
    if (!['0','1','UNANIMOUS_APPROVERS','VALIDITY_ONLY'].includes(authorizationValue)) {
      throw new Error('hosted room observation has invalid authorization mode')
    }
    return {
      roomId,
      status: ['1','Open','OPEN'].includes(stateValue) ? 'OPEN' : 'CLOSED',
      authorizationMode: ['1','VALIDITY_ONLY'].includes(authorizationValue)
        ? 'VALIDITY_ONLY'
        : 'UNANIMOUS_APPROVERS',
      admissionSigner: /^0x0{40}$/.test(address) ? null : address as `0x${string}`,
      serviceBond: decimal('serviceBond'),
      minimumServiceBond: decimal('minimumServiceBond'),
      omissionPenalty: decimal('omissionPenalty'),
      bondEpoch: decimal('bondEpoch'),
      maximumAdmissionWindow: decimal('maximumAdmissionWindow'),
      minimumDepositConfirmations: decimal('minimumDepositConfirmations'),
      latestObservedL1Block: row.head_block,
      latestBatchIndex: decimal('batchIndex'),
      admissionCursor: decimal('admissionCursor'),
      deposits: [],admissions: [],batches: [],
    }
  }

  async roomTenant(chainId: number, roomId: string): Promise<string | null> {
    const result = await this.pool.query<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM hosted_room_observations
       WHERE chain_id = $1 AND room_id = $2`,
      [chainId, roomId],
    )
    return result.rows[0]?.tenant_id ?? null
  }

  async recordUsage(
    fence: CoordinatorFence,
    entry: Omit<UsageEntry, 'usageId'>,
  ): Promise<string> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ usage_id: string }>(
        `INSERT INTO hosted_usage_ledger(
           tenant_id, allocation_id, job_id, room_id, unit, quantity,
           observed_at, idempotency_key, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING usage_id::text`,
        [
          entry.tenantId,
          entry.allocationId,
          entry.jobId,
          entry.roomId,
          entry.unit,
          entry.quantity,
          entry.observedAt,
          entry.idempotencyKey,
          JSON.stringify(entry.metadata),
        ],
      )
      let usageId = result.rows[0]?.usage_id
      if (!usageId) {
        const existing = await client.query<{
          usage_id: string
          tenant_id: string
          allocation_id: string | null
          job_id: string | null
          room_id: string | null
          unit: string
          quantity: string
          observed_at: string | Date
          metadata: Record<string, unknown>
        }>(
          `SELECT usage_id::text, tenant_id, allocation_id, job_id, room_id::text,
                  unit, quantity::text, observed_at, metadata
           FROM hosted_usage_ledger WHERE idempotency_key = $1`,
          [entry.idempotencyKey],
        )
        const row = existing.rows[0]
        if (
          !row
          || row.tenant_id !== entry.tenantId
          || row.allocation_id !== entry.allocationId
          || row.job_id !== entry.jobId
          || row.room_id !== entry.roomId
          || row.unit !== entry.unit
          || canonicalDecimal(row.quantity) !== canonicalDecimal(entry.quantity)
          || canonicalTimestamp(row.observed_at) !== canonicalTimestamp(entry.observedAt)
          || canonicalJson(row.metadata) !== canonicalJson(entry.metadata)
        ) throw new Error('usage idempotency key is bound to a different entry')
        usageId = row.usage_id
      } else {
        await this.outbox(client, entry.tenantId, 'usage.recorded', usageId, {
          unit: entry.unit,
          quantity: entry.quantity,
          allocationId: entry.allocationId,
          jobId: entry.jobId,
          roomId: entry.roomId,
        })
      }
      return usageId
    })
  }

  async listUsage(tenantId: string, afterUsageId = '0', limit = 200): Promise<UsageEntry[]> {
    const result = await this.pool.query<{
      usage_id: string
      tenant_id: string
      allocation_id: string | null
      job_id: string | null
      room_id: string | null
      unit: string
      quantity: string
      observed_at: string
      idempotency_key: string
      metadata: Record<string, unknown>
    }>(
      `SELECT usage_id::text, tenant_id, allocation_id, job_id, room_id::text,
              unit, quantity::text, observed_at::text, idempotency_key, metadata
       FROM hosted_usage_ledger WHERE tenant_id = $1 AND usage_id > $2
       ORDER BY usage_id LIMIT $3`,
      [tenantId, afterUsageId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map((row) => ({
      usageId: row.usage_id,
      tenantId: row.tenant_id,
      allocationId: row.allocation_id,
      jobId: row.job_id,
      roomId: row.room_id,
      unit: row.unit,
      quantity: row.quantity,
      observedAt: row.observed_at,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
    }))
  }

  async recordCanonicalBlock(
    fence: CoordinatorFence,
    block: CanonicalBlockInput,
  ): Promise<{ rolledBackFrom: string | null }> {
    return this.recordCanonicalBlocks(fence, [block])
  }

  async setCanonicalAnchor(fence: CoordinatorFence, anchor: CanonicalAnchor): Promise<CanonicalAnchor> {
    if (!Number.isSafeInteger(anchor.chainId) || anchor.chainId <= 0) throw new Error('invalid anchor chain id')
    if (BigInt(anchor.number) < 0n) throw new Error('invalid anchor block number')
    if (!/^0x[0-9a-fA-F]{64}$/.test(anchor.hash)) throw new Error('invalid anchor block hash')
    const sources = [...new Set(anchor.verifiedSources.map((source) => source.trim()).filter(Boolean))]
    if (sources.length < 2) throw new Error('canonical anchor requires two independent agreeing sources')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const inserted = await client.query<{
        chain_id: string
        block_number: string
        block_hash: string
        verified_sources: string[]
      }>(
        `INSERT INTO hosted_canonical_anchors(chain_id, block_number, block_hash, verified_sources)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (chain_id) DO NOTHING
         RETURNING chain_id::text, block_number::text, block_hash, verified_sources`,
        [anchor.chainId, anchor.number, anchor.hash.toLowerCase(), JSON.stringify(sources)],
      )
      let row = inserted.rows[0]
      if (!row) {
        const existing = await client.query<{
          chain_id: string
          block_number: string
          block_hash: string
          verified_sources: string[]
        }>(
          `SELECT chain_id::text, block_number::text, block_hash, verified_sources
           FROM hosted_canonical_anchors WHERE chain_id = $1 FOR UPDATE`,
          [anchor.chainId],
        )
        row = existing.rows[0]
        if (
          !row
          || row.block_number !== anchor.number
          || row.block_hash.toLowerCase() !== anchor.hash.toLowerCase()
        ) throw new Error('canonical anchor is immutable and conflicts with the requested anchor')
      } else {
        await this.outbox(client, null, 'indexer.anchor', String(anchor.chainId), {
          chainId: anchor.chainId,
          number: anchor.number,
          hash: anchor.hash.toLowerCase(),
        }, 'public-chain')
      }
      await client.query(
        `INSERT INTO hosted_canonical_floors(chain_id, block_number, block_hash, verified_sources)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (chain_id) DO NOTHING`,
        [anchor.chainId, anchor.number, anchor.hash.toLowerCase(), JSON.stringify(sources)],
      )
      return {
        chainId: Number(row.chain_id),
        number: row.block_number,
        hash: row.block_hash,
        verifiedSources: row.verified_sources,
      }
    })
  }

  async canonicalAnchor(chainId: number): Promise<CanonicalAnchor | null> {
    const result = await this.pool.query<{
      chain_id: string
      block_number: string
      block_hash: string
      verified_sources: string[]
    }>(
      `SELECT chain_id::text, block_number::text, block_hash, verified_sources
       FROM hosted_canonical_anchors WHERE chain_id = $1`,
      [chainId],
    )
    const row = result.rows[0]
    return row ? {
      chainId: Number(row.chain_id),
      number: row.block_number,
      hash: row.block_hash,
      verifiedSources: row.verified_sources,
    } : null
  }

  async canonicalFloor(chainId: number): Promise<CanonicalAnchor | null> {
    const result = await this.pool.query<{
      chain_id: string
      block_number: string
      block_hash: string
      verified_sources: string[]
    }>(
      `SELECT chain_id::text, block_number::text, block_hash, verified_sources
       FROM hosted_canonical_floors WHERE chain_id = $1`,
      [chainId],
    )
    const row = result.rows[0]
    return row ? {
      chainId: Number(row.chain_id),
      number: row.block_number,
      hash: row.block_hash,
      verifiedSources: row.verified_sources,
    } : null
  }

  async advanceCanonicalFloor(
    fence: CoordinatorFence,
    floor: CanonicalAnchor,
  ): Promise<CanonicalAnchor> {
    const sources = [...new Set(floor.verifiedSources.map((source) => source.trim()).filter(Boolean))]
    if (sources.length < 2) throw new Error('canonical floor requires two independent agreeing sources')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const recovery = await client.query(
        `SELECT 1 FROM hosted_l1_transactions
         WHERE chain_id=$1 AND status='RECOVERY_REQUIRED' LIMIT 1 FOR SHARE`, [floor.chainId],
      )
      if (recovery.rowCount !== 0) {
        throw new Error('canonical floor is frozen by an unresolved post-finality recovery')
      }
      const anchor = await client.query<{ block_number: string; block_hash: string }>(
        `SELECT block_number::text, block_hash FROM hosted_canonical_anchors
         WHERE chain_id = $1 FOR SHARE`,
        [floor.chainId],
      )
      const anchorRow = anchor.rows[0]
      if (!anchorRow) throw new Error('canonical floor cannot advance before bootstrap anchor')
      if (BigInt(floor.number) < BigInt(anchorRow.block_number)) {
        throw new Error('canonical floor cannot move below the bootstrap anchor')
      }
      const canonical = await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id = $1 AND block_number = $2 AND lower(block_hash) = lower($3) AND canonical
         UNION ALL
         SELECT 1 FROM hosted_canonical_anchors
         WHERE chain_id = $1 AND block_number = $2 AND lower(block_hash) = lower($3)
         LIMIT 1`,
        [floor.chainId, floor.number, floor.hash],
      )
      if (canonical.rowCount !== 1) throw new Error('canonical floor is not an indexed canonical block')
      const unavailableBlobs = await client.query(
        `SELECT 1 FROM hosted_blob_requirements
         WHERE chain_id=$1 AND canonical AND block_number <= $2
           AND status <> 'VERIFIED' LIMIT 1 FOR SHARE`,
        [floor.chainId, floor.number],
      )
      if (unavailableBlobs.rowCount !== 0) {
        throw new Error('canonical floor cannot advance past an unarchived blob sidecar requirement')
      }
      const current = await client.query<{
        block_number: string
        block_hash: string
        verified_sources: string[]
      }>(
        `SELECT block_number::text, block_hash, verified_sources
         FROM hosted_canonical_floors WHERE chain_id = $1 FOR UPDATE`,
        [floor.chainId],
      )
      const row = current.rows[0]
      if (row && BigInt(floor.number) < BigInt(row.block_number)) {
        throw new Error('canonical floor is advance-only')
      }
      if (
        row
        && floor.number === row.block_number
        && floor.hash.toLowerCase() !== row.block_hash.toLowerCase()
      ) throw new Error('canonical floor hash conflicts at the current height')
      if (!row || BigInt(floor.number) > BigInt(row.block_number)) {
        await client.query(
          `INSERT INTO hosted_canonical_floors(chain_id, block_number, block_hash, verified_sources)
           VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (chain_id) DO UPDATE SET
             block_number = EXCLUDED.block_number,
             block_hash = EXCLUDED.block_hash,
             verified_sources = EXCLUDED.verified_sources,
             updated_at = clock_timestamp()`,
          [floor.chainId, floor.number, floor.hash.toLowerCase(), JSON.stringify(sources)],
        )
        await this.outbox(client, null, 'indexer.floor', String(floor.chainId), {
          chainId: floor.chainId,
          number: floor.number,
          hash: floor.hash.toLowerCase(),
        }, 'public-chain')
      }
      // Billing is part of the same fenced finality transaction. A process
      // crash cannot leave a floor advancement committed while omitting the
      // success-only member charges it authorized.
      await this.reconcileAggregateBillingTx(client, floor.chainId)
      return {
        chainId: floor.chainId,
        number: row && BigInt(row.block_number) > BigInt(floor.number) ? row.block_number : floor.number,
        hash: row && BigInt(row.block_number) > BigInt(floor.number) ? row.block_hash : floor.hash.toLowerCase(),
        verifiedSources: row && BigInt(row.block_number) === BigInt(floor.number)
          ? row.verified_sources
          : sources,
      }
    })
  }

  async canonicalHead(chainId: number): Promise<{ number: string; hash: string } | null> {
    const result = await this.pool.query<{ block_number: string; block_hash: string }>(
      `SELECT block_number::text, block_hash FROM canonical_l1_blocks
       WHERE chain_id = $1 AND canonical ORDER BY block_number DESC LIMIT 1`,
      [chainId],
    )
    const row = result.rows[0]
    return row ? { number: row.block_number, hash: row.block_hash } : null
  }

  async canonicalBlockAt(chainId: number, number: string): Promise<{
    number: string
    hash: string
    parentHash: string
  } | null> {
    const result = await this.pool.query<{
      block_number: string
      block_hash: string
      parent_hash: string
    }>(
      `SELECT block_number::text, block_hash, parent_hash
       FROM canonical_l1_blocks
       WHERE chain_id = $1 AND block_number = $2 AND canonical`,
      [chainId, number],
    )
    const row = result.rows[0]
    return row ? { number: row.block_number, hash: row.block_hash, parentHash: row.parent_hash } : null
  }

  async databaseHealth(): Promise<{
    reachable: boolean
    acceptingWrites: boolean
    schemaVersion: number
    checkedAt: string
  }> {
    const result = await this.pool.query<{
      accepting_writes: boolean
      schema_version: number
      checked_at: string | Date
    }>(
      `SELECT NOT pg_is_in_recovery() AS accepting_writes,
              (SELECT max(version)::integer FROM hosted_schema_meta) AS schema_version,
              clock_timestamp() AS checked_at`,
    )
    const row = result.rows[0]
    if (!row) throw new Error('database health query returned no row')
    return {
      reachable: true,
      acceptingWrites: row.accepting_writes,
      schemaVersion: row.schema_version,
      checkedAt: row.checked_at instanceof Date ? row.checked_at.toISOString() : row.checked_at,
    }
  }

  async consumePrincipalRate(principalId: string, limit: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new Error('invalid principal rate limit')
    }
    const result = await this.pool.query(
      `INSERT INTO hosted_rate_limit_windows(principal_id, window_start, used)
       VALUES ($1,date_trunc('minute',clock_timestamp()),1)
       ON CONFLICT (principal_id, window_start) DO UPDATE SET
         used = hosted_rate_limit_windows.used + 1
       WHERE hosted_rate_limit_windows.used < $2
       RETURNING used`,
      [principalId, limit],
    )
    // Opportunistic cleanup does not affect correctness and bounds storage
    // even when the retention worker is temporarily unavailable.
    if (Math.random() < 0.01) {
      void this.pool.query(
        `DELETE FROM hosted_rate_limit_windows
         WHERE window_start < clock_timestamp() - interval '2 hours'`,
      ).catch(() => {})
    }
    return result.rowCount === 1
  }

  async recordAudit(
    fence: CoordinatorFence,
    input: {
      tenantId: string | null
      principalId: string | null
      action: string
      target: string
      idempotencyKey?: string | null
      details: Record<string, unknown>
    },
  ): Promise<string> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ audit_id: string }>(
        `INSERT INTO hosted_audit_records(
           tenant_id, principal_id, action, target, idempotency_key, details
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING audit_id::text`,
        [
          input.tenantId, input.principalId, input.action.slice(0, 200),
          input.target.slice(0, 500), input.idempotencyKey ?? null,
          JSON.stringify(input.details),
        ],
      )
      return result.rows[0]!.audit_id
    })
  }

  async ingestIndexerRecords(
    fence: CoordinatorFence,
    input: {
      chainId: number
      blockNumber: string
      blockHash: `0x${string}`
      source: string
      schemaVersion: number
      logs: Array<{
        logIndex: number
        transactionHash: `0x${string}`
        address: `0x${string}`
        eventName: string
        decoded: Record<string, unknown>
      }>
      facts: Array<{
        factKey: string
        factKind: string
        roomId: string | null
        tenantId: string | null
        payload: Record<string, unknown>
      }>
      blobRequirements?: IndexedBlobRequirement[]
    },
  ): Promise<{ logs: number; facts: number }> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const canonical = await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id = $1 AND block_number = $2 AND lower(block_hash) = lower($3) AND canonical
         FOR SHARE`,
        [input.chainId, input.blockNumber, input.blockHash],
      )
      if (canonical.rowCount !== 1) throw new Error('indexer record block is not canonical')
      let insertedLogs = 0
      for (const log of input.logs) {
        const inserted = await client.query(
          `INSERT INTO hosted_indexer_logs(
             chain_id, block_number, block_hash, log_index, transaction_hash,
             address, event_name, decoded, canonical
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
           ON CONFLICT (chain_id, block_hash, log_index) DO NOTHING`,
          [
            input.chainId, input.blockNumber, input.blockHash, log.logIndex,
            log.transactionHash, log.address, log.eventName, JSON.stringify(log.decoded),
          ],
        )
        if (inserted.rowCount === 1) insertedLogs += 1
        else {
          const existing = await client.query<{
            transaction_hash: string
            address: string
            event_name: string
            decoded: Record<string, unknown>
          }>(
            `SELECT transaction_hash,address,event_name,decoded FROM hosted_indexer_logs
             WHERE chain_id=$1 AND block_hash=$2 AND log_index=$3`,
            [input.chainId, input.blockHash, log.logIndex],
          )
          const row = existing.rows[0]
          if (
            !row
            || row.transaction_hash.toLowerCase() !== log.transactionHash.toLowerCase()
            || row.address.toLowerCase() !== log.address.toLowerCase()
            || row.event_name !== log.eventName
            || canonicalJson(row.decoded) !== canonicalJson(log.decoded)
          ) throw new Error('indexer log identity conflicts with durable canonical bytes')
        }
      }
      let insertedFacts = 0
      for (const fact of input.facts) {
        const inserted = await client.query(
          `INSERT INTO hosted_indexer_facts(
             fact_key, chain_id, block_number, block_hash, fact_kind,
             room_id, tenant_id, payload, canonical
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
           ON CONFLICT (chain_id, block_hash, fact_key) DO NOTHING`,
          [
            fact.factKey, input.chainId, input.blockNumber, input.blockHash,
            fact.factKind, fact.roomId, fact.tenantId, JSON.stringify(fact.payload),
          ],
        )
        if (inserted.rowCount === 1) {
          insertedFacts += 1
          if (fact.roomId !== null) {
            await client.query(
              `INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
               VALUES ($1,$2,true,100)
               ON CONFLICT (chain_id,room_id) DO UPDATE SET
                 dirty=true,priority=GREATEST(hosted_room_reconciliation_queue.priority,100),
                 next_retry_at=NULL,updated_at=clock_timestamp()`,
              [input.chainId, fact.roomId],
            )
          }
          // SSE is a notification/refetch channel. Publish only canonical
          // provenance keys here; the authenticated fact API owns full data.
          await this.outbox(client, null, `indexer.${fact.factKind}`, fact.factKey, {
            chainId: input.chainId,
            blockNumber: input.blockNumber,
            blockHash: input.blockHash,
            roomId: fact.roomId,
          }, 'public-chain')
        } else {
          const existing = await client.query<{
            fact_kind: string
            room_id: string | null
            tenant_id: string | null
            payload: Record<string, unknown>
          }>(
            `SELECT fact_kind,room_id::text,tenant_id,payload FROM hosted_indexer_facts
             WHERE chain_id=$1 AND block_hash=$2 AND fact_key=$3`,
            [input.chainId, input.blockHash, fact.factKey],
          )
          const row = existing.rows[0]
          if (
            !row
            || row.fact_kind !== fact.factKind
            || row.room_id !== fact.roomId
            || row.tenant_id !== fact.tenantId
            || canonicalJson(row.payload) !== canonicalJson(fact.payload)
          ) throw new Error('indexer fact key conflicts with durable canonical bytes')
        }
      }
      for (const requirement of input.blobRequirements ?? []) {
        if (
          requirement.chainId !== input.chainId
          || requirement.blockNumber !== input.blockNumber
          || requirement.blockHash.toLowerCase() !== input.blockHash.toLowerCase()
        ) throw new Error('blob requirement provenance does not match the indexed source block')
        const inserted = await client.query(
          `INSERT INTO hosted_blob_requirements(
             chain_id,transaction_hash,block_number,block_hash,room_id,batch_index,
             blob_start_index,versioned_hashes,commitments
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (chain_id,block_hash,transaction_hash,room_id,batch_index) DO NOTHING`,
          [
            requirement.chainId, requirement.transactionHash.toLowerCase(), requirement.blockNumber,
            requirement.blockHash.toLowerCase(), requirement.roomId, requirement.batchIndex,
            requirement.blobStartIndex, requirement.versionedHashes.map((value) => value.toLowerCase()),
            requirement.commitments.map((value) => value.toLowerCase()),
          ],
        )
        if (inserted.rowCount === 0) {
          const existing = await client.query<{
            blob_start_index: number
            versioned_hashes: string[]
            commitments: string[]
          }>(
            `SELECT blob_start_index,versioned_hashes,commitments
             FROM hosted_blob_requirements
             WHERE chain_id=$1 AND block_hash=$2 AND transaction_hash=$3
               AND room_id=$4 AND batch_index=$5`,
            [
              requirement.chainId, requirement.blockHash.toLowerCase(),
              requirement.transactionHash.toLowerCase(), requirement.roomId, requirement.batchIndex,
            ],
          )
          const row = existing.rows[0]
          if (
            !row
            || row.blob_start_index !== requirement.blobStartIndex
            || canonicalJson(row.versioned_hashes) !== canonicalJson(requirement.versionedHashes.map((value) => value.toLowerCase()))
            || canonicalJson(row.commitments) !== canonicalJson(requirement.commitments.map((value) => value.toLowerCase()))
          ) throw new Error('blob requirement conflicts with durable indexed manifest bytes')
        }
      }
      const cursor = await client.query<{ block_number: string; block_hash: string }>(
        `SELECT block_number::text,block_hash FROM hosted_indexer_cursors
         WHERE chain_id=$1 AND source=$2 FOR UPDATE`,
        [input.chainId, input.source],
      )
      const current = cursor.rows[0]
      if (current && BigInt(input.blockNumber) < BigInt(current.block_number)) {
        throw new Error('indexer cursor is monotonic outside canonical rollback')
      }
      if (
        current
        && input.blockNumber === current.block_number
        && input.blockHash.toLowerCase() !== current.block_hash.toLowerCase()
      ) throw new Error('indexer cursor conflicts at the current height')
      await client.query(
        `INSERT INTO hosted_indexer_cursors(chain_id,source,block_number,block_hash,schema_version)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (chain_id,source) DO UPDATE SET
           block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,
           schema_version=EXCLUDED.schema_version,updated_at=clock_timestamp()`,
        [input.chainId, input.source, input.blockNumber, input.blockHash, input.schemaVersion],
      )
      return { logs: insertedLogs, facts: insertedFacts }
    })
  }

  async recordBlobArchive(
    fence: CoordinatorFence,
    input: {
      chainId: number
      transactionHash: `0x${string}`
      versionedHashes: readonly `0x${string}`[]
      commitments: readonly `0x${string}`[]
      proofs: readonly `0x${string}`[]
      bundleObjectKey: string
      bundleSha256: string
      signedTransactionObjectKey: string | null
      archiveSource: 'hosted-prepublish' | 'beacon-fallback'
      verifiedSources: string[]
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const sources = [...new Set(input.verifiedSources)].sort()
      const values = [
        input.chainId,
        input.transactionHash.toLowerCase(),
        input.versionedHashes.map((value) => value.toLowerCase()),
        input.commitments.map((value) => value.toLowerCase()),
        input.proofs.map((value) => value.toLowerCase()),
        input.bundleObjectKey,
        input.bundleSha256.toLowerCase(),
        input.signedTransactionObjectKey,
        input.archiveSource,
        JSON.stringify(sources),
      ] as const
      const inserted = await client.query(
        `INSERT INTO hosted_blob_archives(
           chain_id,transaction_hash,versioned_hashes,commitments,proofs,
           bundle_object_key,bundle_sha256,signed_transaction_object_key,
           archive_source,verified_sources
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (chain_id,transaction_hash) DO NOTHING`,
        values,
      )
      if (inserted.rowCount === 1) {
        await this.outbox(client, null, 'blob-archive.verified', input.transactionHash, {
          chainId: input.chainId,
          transactionHash: input.transactionHash.toLowerCase(),
          archiveSource: input.archiveSource,
        }, 'admin-internal')
        return
      }
      const existing = await client.query<{
        versioned_hashes: string[]
        commitments: string[]
        proofs: string[]
        bundle_object_key: string
        bundle_sha256: string
        signed_transaction_object_key: string | null
        archive_source: string
        verified_sources: string[]
      }>(
        `SELECT versioned_hashes,commitments,proofs,bundle_object_key,bundle_sha256,
                signed_transaction_object_key,archive_source,verified_sources
         FROM hosted_blob_archives WHERE chain_id=$1 AND transaction_hash=$2`,
        [input.chainId, input.transactionHash.toLowerCase()],
      )
      const row = existing.rows[0]
      if (
        !row
        || canonicalJson(row.versioned_hashes) !== canonicalJson(values[2])
        || canonicalJson(row.commitments) !== canonicalJson(values[3])
        || canonicalJson(row.proofs) !== canonicalJson(values[4])
        || row.bundle_object_key !== input.bundleObjectKey
        || row.bundle_sha256 !== input.bundleSha256.toLowerCase()
        || row.signed_transaction_object_key !== input.signedTransactionObjectKey
        || row.archive_source !== input.archiveSource
        || canonicalJson(row.verified_sources) !== canonicalJson(sources)
      ) throw new Error('blob archive transaction key is bound to different immutable bytes')
    })
  }

  async blobArchive(chainId: number, transactionHash: `0x${string}`): Promise<{
    versionedHashes: `0x${string}`[]
    commitments: `0x${string}`[]
    proofs: `0x${string}`[]
    bundleObjectKey: string
    bundleSha256: string
    archiveSource: 'hosted-prepublish' | 'beacon-fallback'
    verifiedSources: string[]
  } | null> {
    const result = await this.pool.query<{
      versioned_hashes: `0x${string}`[]
      commitments: `0x${string}`[]
      proofs: `0x${string}`[]
      bundle_object_key: string
      bundle_sha256: string
      archive_source: 'hosted-prepublish' | 'beacon-fallback'
      verified_sources: string[]
    }>(
      `SELECT versioned_hashes,commitments,proofs,bundle_object_key,bundle_sha256,
              archive_source,verified_sources
       FROM hosted_blob_archives WHERE chain_id=$1 AND transaction_hash=$2`,
      [chainId, transactionHash.toLowerCase()],
    )
    const row = result.rows[0]
    return row ? {
      versionedHashes: row.versioned_hashes,
      commitments: row.commitments,
      proofs: row.proofs,
      bundleObjectKey: row.bundle_object_key,
      bundleSha256: row.bundle_sha256,
      archiveSource: row.archive_source,
      verifiedSources: row.verified_sources,
    } : null
  }

  async pendingBlobRequirements(limit = 100): Promise<IndexedBlobRequirement[]> {
    const result = await this.pool.query<{
      chain_id: string
      transaction_hash: `0x${string}`
      block_number: string
      block_hash: `0x${string}`
      room_id: string
      batch_index: string
      blob_start_index: number
      versioned_hashes: `0x${string}`[]
      commitments: `0x${string}`[]
    }>(
      `SELECT chain_id::text,transaction_hash,block_number::text,block_hash,
              room_id::text,batch_index::text,blob_start_index,versioned_hashes,commitments
       FROM hosted_blob_requirements
       WHERE canonical AND status IN ('PENDING','ERROR')
       ORDER BY block_number,requirement_id LIMIT $1`,
      [Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map((row) => ({
      chainId: Number(row.chain_id), transactionHash: row.transaction_hash,
      blockNumber: row.block_number, blockHash: row.block_hash,
      roomId: row.room_id, batchIndex: row.batch_index,
      blobStartIndex: row.blob_start_index, versionedHashes: row.versioned_hashes,
      commitments: row.commitments,
    }))
  }

  async completeBlobRequirement(
    fence: CoordinatorFence,
    requirement: IndexedBlobRequirement,
    error: string | null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      if (error === null) {
        const archive = await client.query(
          `SELECT 1 FROM hosted_blob_archives
           WHERE chain_id=$1 AND transaction_hash=$2 FOR SHARE`,
          [requirement.chainId, requirement.transactionHash.toLowerCase()],
        )
        if (archive.rowCount !== 1) throw new Error('blob requirement cannot verify without a durable archive')
      }
      const updated = await client.query(
        `UPDATE hosted_blob_requirements SET
           status=$6,last_error=$7,attempts=attempts+1,
           verified_at=CASE WHEN $7::text IS NULL THEN clock_timestamp() ELSE verified_at END,
           updated_at=clock_timestamp()
         WHERE chain_id=$1 AND block_hash=$2 AND transaction_hash=$3
           AND room_id=$4 AND batch_index=$5 AND canonical
           AND status <> 'RETRACTED'`,
        [
          requirement.chainId, requirement.blockHash.toLowerCase(),
          requirement.transactionHash.toLowerCase(), requirement.roomId, requirement.batchIndex,
          error === null ? 'VERIFIED' : 'ERROR', error,
        ],
      )
      if (updated.rowCount !== 1) throw new Error('canonical blob requirement is absent or retracted')
    })
  }

  async blobArchiveReadyThrough(chainId: number, blockNumber: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM hosted_blob_requirements
       WHERE chain_id=$1 AND canonical AND block_number <= $2
         AND status <> 'VERIFIED' LIMIT 1`,
      [chainId, blockNumber],
    )
    return result.rowCount === 0
  }

  async reserveL1Transaction(
    fence: CoordinatorFence,
    input: {
      operationId: string
      chainId: number
      sender: `0x${string}`
      operation: string
      idempotencyKey: string
      requestHash: string
      requestObjectKey: string
      transportRequestHash?: string | null
      transportRequestObjectKey?: string | null
      destinationAddress?: `0x${string}` | null
      calldata: `0x${string}`
      inclusionDeadline: string
      remotePendingNonce: string
      access?: {
        tenantId: string
        principalId: string
        correlationId: string
        minimumConfirmations: number
        requireFinalized: boolean
        bindingKind: HostedL1BindingKind
      }
    },
  ): Promise<HostedL1Transaction> {
    const transportHash=input.transportRequestHash ?? null
    const transportObjectKey=input.transportRequestObjectKey ?? null
    if ((transportHash===null)!==(transportObjectKey===null)
      || (transportHash!==null && !/^[0-9a-f]{64}$/.test(transportHash))) {
      throw new Error('transport request hash and object key must be supplied together')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const sender = input.sender.toLowerCase() as `0x${string}`
      // Idempotency is global across every managed sender and operation kind.
      // Take this lock before the sender-specific nonce lock so simultaneous
      // cross-authority requests deterministically replay or reject instead of
      // surfacing a raw UNIQUE violation after each observed an absent row.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`zkdeal-l1-idempotency:${input.idempotencyKey}`],
      )
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`zkdeal-l1-nonce:${input.chainId}:${sender}`],
      )
      const replay = await client.query<HostedL1TransactionRow>(
        `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
         FROM hosted_l1_transactions WHERE idempotency_key=$1 FOR UPDATE`,
        [input.idempotencyKey],
      )
      const existing = replay.rows[0]
      if (existing) {
        if (
          Number(existing.chain_id) !== input.chainId || existing.sender !== sender
          || existing.operation !== input.operation || existing.request_hash !== input.requestHash
          || existing.request_object_key !== input.requestObjectKey
          || existing.transport_request_hash !== transportHash
          || existing.transport_request_object_key !== transportObjectKey
          || existing.destination_address !== (input.destinationAddress?.toLowerCase() ?? null)
          || existing.calldata !== input.calldata.toLowerCase()
          || existing.inclusion_deadline !== input.inclusionDeadline
        ) throw new Error('L1 transaction idempotency key is bound to another immutable request')
        if (input.access) {
          const access = await client.query<{
            tenant_id: string;principal_id: string;correlation_id: string
            minimum_confirmations: number;require_finalized: boolean;binding_kind: HostedL1BindingKind
          }>(
            `SELECT tenant_id,principal_id,correlation_id,minimum_confirmations,
                    require_finalized,binding_kind
             FROM hosted_l1_operation_access WHERE operation_id=$1 FOR SHARE`,
            [existing.operation_id],
          )
          const bound = access.rows[0]
          if (
            !bound || bound.tenant_id !== input.access.tenantId
            || bound.principal_id !== input.access.principalId
            || bound.correlation_id !== input.access.correlationId
            || bound.minimum_confirmations !== input.access.minimumConfirmations
            || bound.require_finalized !== input.access.requireFinalized
            || bound.binding_kind !== input.access.bindingKind
          ) throw new Error('L1 transaction idempotency key is bound to another access scope')
        }
        return hostedL1Transaction(existing)
      }

      await client.query(
        `INSERT INTO hosted_l1_nonce_state(chain_id,sender,next_nonce)
         VALUES ($1,$2,$3)
         ON CONFLICT (chain_id,sender) DO UPDATE SET
           next_nonce=GREATEST(hosted_l1_nonce_state.next_nonce,EXCLUDED.next_nonce),
           updated_at=clock_timestamp()`,
        [input.chainId, sender, input.remotePendingNonce],
      )
      const state = await client.query<{ next_nonce: string }>(
        `SELECT next_nonce::text FROM hosted_l1_nonce_state
         WHERE chain_id=$1 AND sender=$2 FOR UPDATE`,
        [input.chainId, sender],
      )
      const nonce = state.rows[0]!.next_nonce
      await client.query(
        `UPDATE hosted_l1_nonce_state SET next_nonce=next_nonce+1,updated_at=clock_timestamp()
         WHERE chain_id=$1 AND sender=$2`, [input.chainId, sender],
      )
      const inserted = await client.query<HostedL1TransactionRow>(
        `INSERT INTO hosted_l1_transactions(
           operation_id,chain_id,sender,nonce,operation,idempotency_key,request_hash,
           request_object_key,transport_request_hash,transport_request_object_key,
           destination_address,calldata,inclusion_deadline,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PREPARED')
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [
          input.operationId, input.chainId, sender, nonce, input.operation,
          input.idempotencyKey, input.requestHash, input.requestObjectKey,
          transportHash,transportObjectKey,input.destinationAddress?.toLowerCase() ?? null,
          input.calldata.toLowerCase(),input.inclusionDeadline,
        ],
      )
      await this.outbox(client, null, 'l1-transaction.prepared', input.operationId, {
        operation: input.operation, chainId: input.chainId, sender, nonce,
      }, 'admin-internal')
      if (input.access) {
        await client.query(
          `INSERT INTO hosted_l1_operation_access(
             operation_id,tenant_id,principal_id,correlation_id,minimum_confirmations,
             require_finalized,binding_kind
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.operationId,input.access.tenantId,input.access.principalId,
            input.access.correlationId,input.access.minimumConfirmations,
            input.access.requireFinalized,input.access.bindingKind,
          ],
        )
      }
      return hostedL1Transaction(inserted.rows[0]!)
    })
  }

  async attachSignedL1Transaction(
    fence: CoordinatorFence,
    operationId: string,
    input: {
      transactionHash: `0x${string}`
      rawTransactionObjectKey: string
      /** Null for ordinary EIP-1559 operations; blob sends must bind a bundle. */
      bundleObjectKey: string | null
    },
  ): Promise<HostedL1Transaction> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<HostedL1TransactionRow>(
        `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
         FROM hosted_l1_transactions WHERE operation_id=$1 FOR UPDATE`, [operationId],
      )
      const row = current.rows[0]
      if (!row) throw new Error('prepared L1 operation was not found')
      if (row.transaction_hash) {
        if (
          row.transaction_hash !== input.transactionHash.toLowerCase()
          || row.raw_transaction_object_key !== input.rawTransactionObjectKey
          || row.bundle_object_key !== input.bundleObjectKey
        ) throw new Error('prepared L1 operation is already bound to different signed bytes')
        return hostedL1Transaction(row)
      }
      if (row.status !== 'PREPARED') throw new Error('L1 operation is not awaiting a signature')
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET
           transaction_hash=$2,raw_transaction_object_key=$3,bundle_object_key=$4,
           status='SIGNED',updated_at=clock_timestamp()
         WHERE operation_id=$1 RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [
          operationId, input.transactionHash.toLowerCase(),
          input.rawTransactionObjectKey, input.bundleObjectKey,
        ],
      )
      return hostedL1Transaction(updated.rows[0]!)
    })
  }

  async markL1TransactionBroadcast(
    fence: CoordinatorFence,
    operationId: string,
  ): Promise<HostedL1Transaction> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const candidate = await client.query<{ operation: string }>(
        `SELECT operation FROM hosted_l1_transactions WHERE operation_id=$1 FOR UPDATE`, [operationId],
      )
      if (candidate.rows[0]?.operation === 'publish-aggregate') {
        const binding = await client.query(
          `SELECT 1 FROM hosted_aggregate_billing_manifests WHERE operation_id=$1 FOR SHARE`, [operationId],
        )
        if (binding.rowCount !== 1) throw new Error('aggregate L1 operation cannot broadcast before its immutable billing manifest')
      }
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET status='BROADCAST',attempts=attempts+1,
           last_error=NULL,last_attempt_at=clock_timestamp(),
           next_attempt_at=clock_timestamp() + interval '3 seconds',updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status IN ('SIGNED','BROADCAST','INCLUDED')
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [operationId],
      )
      if (!updated.rows[0]) throw new Error('signed L1 operation is not broadcastable')
      await this.outbox(client, null, 'l1-transaction.broadcast', operationId, {
        transactionHash: updated.rows[0].transaction_hash,
        attempts: updated.rows[0].attempts,
      }, 'admin-internal')
      return hostedL1Transaction(updated.rows[0])
    })
  }

  async markL1TransactionIncluded(
    fence: CoordinatorFence,
    operationId: string,
    blockNumber: string,
    blockHash: `0x${string}`,
    receiptCost?: {
      gasUsed: string
      effectiveGasPrice: string
      blobGasUsed?: string | null
      blobGasPrice?: string | null
    },
    receiptEvidence?: { verifiedSources: readonly string[]; observedAt?: string },
  ): Promise<HostedL1Transaction> {
    const integer = (value: string | null | undefined, field: string): string | null => {
      if (value === null || value === undefined) return null
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} must be an unsigned decimal integer`)
      return BigInt(value).toString()
    }
    const gasUsed = receiptCost ? integer(receiptCost.gasUsed, 'gasUsed') : null
    const effectiveGasPrice = receiptCost ? integer(receiptCost.effectiveGasPrice, 'effectiveGasPrice') : null
    const blobGasUsed = receiptCost ? integer(receiptCost.blobGasUsed ?? null, 'blobGasUsed') : null
    const blobGasPrice = receiptCost ? integer(receiptCost.blobGasPrice ?? null, 'blobGasPrice') : null
    if ((blobGasUsed === null) !== (blobGasPrice === null)) {
      throw new Error('blobGasUsed and blobGasPrice must be supplied together')
    }
    const verifiedSources = receiptEvidence
      ? [...new Set(receiptEvidence.verifiedSources.map((source) => source.trim()).filter(Boolean))]
      : []
    if (receiptEvidence && verifiedSources.length < 2) {
      throw new Error('canonical receipt evidence requires two independent sources')
    }
    const observedAt = receiptEvidence
      ? canonicalTimestamp(receiptEvidence.observedAt ?? new Date().toISOString())
      : null
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET status='INCLUDED',block_number=$2,block_hash=$3,
           gas_used=COALESCE(gas_used,$4),effective_gas_price=COALESCE(effective_gas_price,$5),
           blob_gas_used=COALESCE(blob_gas_used,$6),blob_gas_price=COALESCE(blob_gas_price,$7),
           receipt_provider_ids=CASE WHEN cardinality($8::text[])>0 THEN $8 ELSE receipt_provider_ids END,
           receipt_observed_at=COALESCE($9::timestamptz,receipt_observed_at),
           receipt_canonical=CASE WHEN cardinality($8::text[])>0 THEN true ELSE receipt_canonical END,
           last_error=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status IN ('BROADCAST','INCLUDED')
           AND ($4::numeric IS NULL OR gas_used IS NULL OR gas_used=$4)
           AND ($5::numeric IS NULL OR effective_gas_price IS NULL OR effective_gas_price=$5)
           AND ($6::numeric IS NULL OR blob_gas_used IS NULL OR blob_gas_used=$6)
           AND ($7::numeric IS NULL OR blob_gas_price IS NULL OR blob_gas_price=$7)
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [
          operationId,blockNumber,blockHash.toLowerCase(),gasUsed,effectiveGasPrice,
          blobGasUsed,blobGasPrice,verifiedSources,observedAt,
        ],
      )
      if (!updated.rows[0]) throw new Error('broadcast L1 operation is not includable or receipt cost conflicts')
      return hostedL1Transaction(updated.rows[0])
    })
  }

  async markL1TransactionRetracted(
    fence: CoordinatorFence,
    operationId: string,
    reason: string,
    verifiedSources: readonly string[] = [],
  ): Promise<HostedL1Transaction> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const prior = await client.query<HostedL1TransactionRow>(
        `SELECT ${HOSTED_L1_TRANSACTION_SELECT} FROM hosted_l1_transactions
         WHERE operation_id=$1 FOR UPDATE`, [operationId],
      )
      const row = prior.rows[0]
      if (!row || !['INCLUDED', 'FINALIZED'].includes(row.status)) {
        throw new Error('only an included L1 operation can be retracted')
      }
      const finalizedSurprise = row.status === 'FINALIZED'
      const sources = [...new Set(verifiedSources.map((source) => source.trim()).filter(Boolean))]
      if (finalizedSurprise && sources.length < 2) {
        throw new Error('post-finality correction requires two independent agreeing canonical sources')
      }
      const updated = await client.query<HostedL1TransactionRow>(
        finalizedSurprise
          ? `UPDATE hosted_l1_transactions SET status='RECOVERY_REQUIRED',receipt_canonical=false,last_error=$2,
               updated_at=clock_timestamp()
             WHERE operation_id=$1 RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`
          : `UPDATE hosted_l1_transactions SET status='BROADCAST',block_number=NULL,block_hash=NULL,
               finalized_block=NULL,finalized_hash=NULL,receipt_canonical=false,last_error=$2,
               next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
             WHERE operation_id=$1 RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [operationId, reason.slice(0, 500)],
      )
      if (finalizedSurprise && row.block_number && row.block_hash) {
        const descendants = await client.query<HostedL1TransactionRow>(
          `SELECT ${HOSTED_L1_TRANSACTION_SELECT} FROM hosted_l1_transactions
           WHERE chain_id=$1 AND block_number >= $2 AND status='FINALIZED'
             AND operation_id<>$3 FOR UPDATE`,
          [row.chain_id,row.block_number,operationId],
        )
        await client.query(
          `UPDATE hosted_l1_transactions SET status='RECOVERY_REQUIRED',last_error=$3,
             updated_at=clock_timestamp()
           WHERE chain_id=$1 AND block_number >= $2 AND status='FINALIZED'`,
          [row.chain_id,row.block_number,reason.slice(0,500)],
        )
        await client.query(
          `UPDATE canonical_l1_blocks SET canonical=false
           WHERE chain_id=$1 AND block_number >= $2 AND canonical`,
          [row.chain_id,row.block_number],
        )
        await client.query(
          `UPDATE hosted_indexer_logs SET canonical=false
           WHERE chain_id=$1 AND block_number >= $2 AND canonical`,
          [row.chain_id,row.block_number],
        )
        await client.query(
          `UPDATE hosted_indexer_facts SET canonical=false
           WHERE chain_id=$1 AND block_number >= $2 AND canonical`,
          [row.chain_id,row.block_number],
        )
        await client.query(
          `UPDATE hosted_blob_requirements SET canonical=false,status='RETRACTED',
             retracted_at=clock_timestamp(),last_error=$3,updated_at=clock_timestamp()
           WHERE chain_id=$1 AND block_number >= $2 AND canonical`,
          [row.chain_id,row.block_number,reason.slice(0,500)],
        )
        await client.query(
          `UPDATE hosted_withdrawals SET previous_status=status,status='RETRACTED',
             retraction_reason=$3,updated_at=clock_timestamp()
           WHERE chain_id=$1 AND finalized_block >= $2 AND status<>'RETRACTED'`,
          [row.chain_id,row.block_number,reason.slice(0,500)],
        )
        await client.query(
          `UPDATE hosted_withdrawal_epochs SET status='RECOVERY_REQUIRED',last_error=$3,
             updated_at=clock_timestamp()
           WHERE chain_id=$1 AND finalized_block >= $2 AND status='FINALIZED'`,
          [row.chain_id,row.block_number,reason.slice(0,500)],
        )
        await client.query(
          `DELETE FROM hosted_room_observations WHERE chain_id=$1 AND head_block >= $2`,
          [row.chain_id,row.block_number],
        )
        await client.query(
          `UPDATE hosted_room_reconciliation_queue SET dirty=true,priority=GREATEST(priority,1000),
             next_retry_at=NULL,last_error='post-finality canonical provenance was retracted',
             updated_at=clock_timestamp()
           WHERE chain_id=$1`, [row.chain_id],
        )
        await client.query('DELETE FROM hosted_indexer_cursors WHERE chain_id=$1', [row.chain_id])
        await this.reconcileAggregateBillingTx(client,Number(row.chain_id))
        for (const descendant of descendants.rows) {
          await this.outbox(client, null, 'statusRetracted', descendant.operation_id, {
            previousState: {
              status: descendant.status,
              transactionHash: descendant.transaction_hash,
              blockNumber: descendant.block_number,
              blockHash: descendant.block_hash,
            },
            reason: {
              code: 'POST_FINALITY_ANCESTOR_SURPRISE',
              message: reason,
              surprisedOperationId: operationId,
              verifiedSources: sources,
            },
          }, 'public-chain')
        }
      }
      await this.outbox(client, null, 'statusRetracted', operationId, {
        previousState: {
          status: row.status, transactionHash: row.transaction_hash,
          blockNumber: row.block_number, blockHash: row.block_hash,
        },
        reason: {
          code: finalizedSurprise ? 'POST_FINALITY_SURPRISE' : 'L1_REORGANIZATION',
          message: reason,
          verifiedSources: finalizedSurprise ? sources : undefined,
        },
      }, 'public-chain')
      return hostedL1Transaction(updated.rows[0]!)
    })
  }

  async installPostFinalityRecoveryBranch(
    fence: CoordinatorFence,
    input: {
      recoveryId: string
      operationId: string
      chainId: number
      expectedPriorFloor: { number: string; hash: `0x${string}` }
      blocks: CanonicalBlockInput[]
      requiredIndexerSources: string[]
      verifiedSources: string[]
      reason: string
    },
  ): Promise<PostFinalityRecovery> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.recoveryId)) {
      throw new Error('post-finality recovery id is invalid')
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.operationId)) {
      throw new Error('post-finality recovery operation id is invalid')
    }
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
      throw new Error('post-finality recovery chain id is invalid')
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.expectedPriorFloor.hash)) {
      throw new Error('post-finality recovery prior floor hash is invalid')
    }
    let priorFloorNumber: bigint
    try {
      priorFloorNumber = BigInt(input.expectedPriorFloor.number)
    } catch {
      throw new Error('post-finality recovery prior floor number is invalid')
    }
    if (priorFloorNumber < 0n) throw new Error('post-finality recovery prior floor number is invalid')
    const reason = input.reason.trim()
    if (reason.length < 8 || reason.length > 1_000) {
      throw new Error('post-finality recovery reason must be from 8 through 1000 characters')
    }
    const requiredIndexerSources = [...new Set(
      input.requiredIndexerSources.map((source) => source.trim()).filter(Boolean),
    )].sort()
    if (requiredIndexerSources.length === 0 || requiredIndexerSources.some((source) => source.length > 200)) {
      throw new Error('post-finality recovery requires bounded indexer sources')
    }
    const installSources = [...new Set(
      input.verifiedSources.map((source) => source.trim()).filter(Boolean),
    )].sort()
    if (installSources.length < 2 || installSources.some((source) => source.length > 500)) {
      throw new Error('post-finality recovery branch requires two independent agreeing sources')
    }
    if (input.blocks.length === 0 || input.blocks.length > 4_096) {
      throw new Error('post-finality recovery branch must contain from 1 through 4096 blocks')
    }
    const blocks = input.blocks.map((block, index): CanonicalBlockInput => {
      if (block.chainId !== input.chainId) throw new Error('post-finality recovery branch mixes chain ids')
      let number: bigint
      try {
        number = BigInt(block.number)
      } catch {
        throw new Error(`post-finality recovery block ${index} number is invalid`)
      }
      if (number < 0n) throw new Error(`post-finality recovery block ${index} number is invalid`)
      if (!/^0x[0-9a-fA-F]{64}$/.test(block.hash) || !/^0x[0-9a-fA-F]{64}$/.test(block.parentHash)) {
        throw new Error(`post-finality recovery block ${index} hash is invalid`)
      }
      const normalized: CanonicalBlockInput = {
        chainId: input.chainId,
        number: number.toString(),
        hash: block.hash.toLowerCase() as `0x${string}`,
        parentHash: block.parentHash.toLowerCase() as `0x${string}`,
        observedAt: canonicalTimestamp(block.observedAt),
      }
      if (index > 0) {
        const previous = input.blocks[index - 1]!
        if (number !== BigInt(previous.number) + 1n) {
          throw new Error('post-finality recovery branch must be contiguous and ascending')
        }
        if (normalized.parentHash !== previous.hash.toLowerCase()) {
          throw new Error('post-finality recovery branch has a broken parent link')
        }
      }
      return normalized
    })
    const first = blocks[0]!
    const last = blocks.at(-1)!
    if (BigInt(last.number) < priorFloorNumber) {
      throw new Error('post-finality recovery branch must replace the complete prior archive floor')
    }
    const normalizedPriorHash = input.expectedPriorFloor.hash.toLowerCase() as `0x${string}`

    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('zkdeal-post-finality:' || $1::text))",
        [input.chainId],
      )
      const existing = await client.query<PostFinalityRecoveryRow>(
        `SELECT ${POST_FINALITY_RECOVERY_SELECT} FROM hosted_post_finality_recoveries
         WHERE recovery_id=$1 OR operation_id=$2 FOR UPDATE`,
        [input.recoveryId, input.operationId],
      )
      if (existing.rowCount !== 0) {
        const row = existing.rows[0]!
        const exact = row.recovery_id === input.recoveryId
          && row.operation_id === input.operationId
          && Number(row.chain_id) === input.chainId
          && row.prior_floor_number === priorFloorNumber.toString()
          && row.prior_floor_hash.toLowerCase() === normalizedPriorHash
          && canonicalJson(row.branch_blocks) === canonicalJson(blocks)
          && canonicalJson(row.required_indexer_sources) === canonicalJson(requiredIndexerSources)
          && canonicalJson(row.verified_sources.install) === canonicalJson(installSources)
          && row.reason === reason
        if (!exact) throw new Error('post-finality recovery identity conflicts with durable immutable terms')
        return postFinalityRecovery(row)
      }

      const operation = await client.query<{
        chain_id: string
        status: HostedL1TransactionStatus
        block_number: string | null
        block_hash: string | null
      }>(
        `SELECT chain_id::text,status,block_number::text,block_hash
         FROM hosted_l1_transactions WHERE operation_id=$1 FOR UPDATE`,
        [input.operationId],
      )
      const operationRow = operation.rows[0]
      if (!operationRow || operationRow.status !== 'RECOVERY_REQUIRED') {
        throw new Error('post-finality recovery operation is not awaiting recovery')
      }
      if (Number(operationRow.chain_id) !== input.chainId || operationRow.block_number !== first.number) {
        throw new Error('post-finality recovery branch does not start at the surprised operation block')
      }
      const floor = await client.query<{ block_number: string; block_hash: string }>(
        `SELECT block_number::text,block_hash FROM hosted_canonical_floors
         WHERE chain_id=$1 FOR UPDATE`, [input.chainId],
      )
      const floorRow = floor.rows[0]
      if (
        !floorRow
        || floorRow.block_number !== priorFloorNumber.toString()
        || floorRow.block_hash.toLowerCase() !== normalizedPriorHash
      ) throw new Error('post-finality recovery prior floor evidence is stale or conflicting')
      const parentNumber = BigInt(first.number) - 1n
      if (parentNumber < 0n) throw new Error('post-finality recovery cannot replace genesis')
      const parent = await client.query<{ block_hash: string }>(
        `SELECT block_hash FROM (
           SELECT block_hash FROM canonical_l1_blocks
           WHERE chain_id=$1 AND block_number=$2 AND canonical
           UNION
           SELECT block_hash FROM hosted_canonical_anchors
           WHERE chain_id=$1 AND block_number=$2
         ) AS parent`,
        [input.chainId, parentNumber.toString()],
      )
      if (
        parent.rowCount !== 1
        || parent.rows[0]!.block_hash.toLowerCase() !== first.parentHash
      ) throw new Error('post-finality recovery branch does not link to the retained canonical ancestor')
      const conflictingCanonical = await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id=$1 AND block_number >= $2 AND canonical LIMIT 1 FOR SHARE`,
        [input.chainId, first.number],
      )
      if (conflictingCanonical.rowCount !== 0) {
        throw new Error('post-finality recovery cannot overwrite an installed canonical branch')
      }
      for (const block of blocks) {
        const installed = await client.query(
          `INSERT INTO canonical_l1_blocks(
             chain_id,block_number,block_hash,parent_hash,canonical,observed_at
           ) VALUES ($1,$2,$3,$4,true,$5)
           ON CONFLICT (chain_id,block_number,block_hash) DO UPDATE SET
             canonical=true,observed_at=EXCLUDED.observed_at
           WHERE lower(canonical_l1_blocks.parent_hash)=lower(EXCLUDED.parent_hash)
           RETURNING 1`,
          [block.chainId,block.number,block.hash,block.parentHash,block.observedAt],
        )
        if (installed.rowCount !== 1) throw new Error('post-finality recovery block conflicts with durable parent evidence')
      }
      const inserted = await client.query<PostFinalityRecoveryRow>(
        `INSERT INTO hosted_post_finality_recoveries(
           recovery_id,chain_id,operation_id,prior_floor_number,prior_floor_hash,
           branch_start_number,branch_blocks,required_indexer_sources,verified_sources,status,reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,'BRANCH_INSTALLED',$10)
         RETURNING ${POST_FINALITY_RECOVERY_SELECT}`,
        [
          input.recoveryId,input.chainId,input.operationId,priorFloorNumber.toString(),normalizedPriorHash,
          first.number,JSON.stringify(blocks),requiredIndexerSources,
          JSON.stringify({ install: installSources }),reason,
        ],
      )
      await this.outbox(client, null, 'post-finality.recovery-branch-installed', input.recoveryId, {
        chainId: input.chainId,
        operationId: input.operationId,
        previousFloor: { number: priorFloorNumber.toString(), hash: normalizedPriorHash },
        branchStart: first.number,
        branchHead: { number: last.number, hash: last.hash },
        verifiedSources: installSources,
        state: 'INDEXER_REPLAY_REQUIRED',
      }, 'admin-internal')
      return postFinalityRecovery(inserted.rows[0]!)
    })
  }

  async finalizePostFinalityRecovery(
    fence: CoordinatorFence,
    input: {
      recoveryId: string
      replacementFloor: CanonicalAnchor
    },
  ): Promise<PostFinalityRecovery> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.recoveryId)) {
      throw new Error('post-finality recovery id is invalid')
    }
    if (!Number.isSafeInteger(input.replacementFloor.chainId) || input.replacementFloor.chainId < 1) {
      throw new Error('post-finality replacement floor chain id is invalid')
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.replacementFloor.hash)) {
      throw new Error('post-finality replacement floor hash is invalid')
    }
    let replacementNumber: bigint
    try {
      replacementNumber = BigInt(input.replacementFloor.number)
    } catch {
      throw new Error('post-finality replacement floor number is invalid')
    }
    if (replacementNumber < 0n) throw new Error('post-finality replacement floor number is invalid')
    const finalizeSources = [...new Set(
      input.replacementFloor.verifiedSources.map((source) => source.trim()).filter(Boolean),
    )].sort()
    if (finalizeSources.length < 2 || finalizeSources.some((source) => source.length > 500)) {
      throw new Error('post-finality replacement floor requires two independent agreeing sources')
    }
    const replacementHash = input.replacementFloor.hash.toLowerCase() as `0x${string}`
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('zkdeal-post-finality:' || $1::text))",
        [input.replacementFloor.chainId],
      )
      const recovery = await client.query<PostFinalityRecoveryRow>(
        `SELECT ${POST_FINALITY_RECOVERY_SELECT} FROM hosted_post_finality_recoveries
         WHERE recovery_id=$1 FOR UPDATE`, [input.recoveryId],
      )
      const row = recovery.rows[0]
      if (!row) throw new Error('post-finality recovery was not found')
      if (Number(row.chain_id) !== input.replacementFloor.chainId) {
        throw new Error('post-finality recovery belongs to another chain')
      }
      if (row.status === 'RESOLVED') {
        if (
          row.replacement_floor_number !== replacementNumber.toString()
          || row.replacement_floor_hash?.toLowerCase() !== replacementHash
          || canonicalJson(row.verified_sources.finalize ?? []) !== canonicalJson(finalizeSources)
        ) throw new Error('post-finality recovery finalization conflicts with durable immutable terms')
        return postFinalityRecovery(row)
      }
      const branchHead = row.branch_blocks.at(-1)
      if (
        !branchHead
        || branchHead.number !== replacementNumber.toString()
        || branchHead.hash.toLowerCase() !== replacementHash
      ) throw new Error('post-finality replacement floor must equal the independently installed branch head')
      const operation = await client.query<{ status: HostedL1TransactionStatus }>(
        `SELECT status FROM hosted_l1_transactions WHERE operation_id=$1 FOR UPDATE`, [row.operation_id],
      )
      if (operation.rows[0]?.status !== 'RECOVERY_REQUIRED') {
        throw new Error('post-finality recovery operation is no longer awaiting resolution')
      }
      const priorFloor = await client.query<{ block_number: string; block_hash: string }>(
        `SELECT block_number::text,block_hash FROM hosted_canonical_floors
         WHERE chain_id=$1 FOR UPDATE`, [row.chain_id],
      )
      if (
        priorFloor.rows[0]?.block_number !== row.prior_floor_number
        || priorFloor.rows[0]?.block_hash.toLowerCase() !== row.prior_floor_hash.toLowerCase()
      ) throw new Error('post-finality recovery prior floor changed during replay')
      const canonical = await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id=$1 AND block_number=$2 AND lower(block_hash)=lower($3) AND canonical
         FOR SHARE`, [row.chain_id,replacementNumber.toString(),replacementHash],
      )
      if (canonical.rowCount !== 1) throw new Error('post-finality replacement floor is not canonical')
      const missingCursor = await client.query<{ source: string }>(
        `SELECT required.source
         FROM unnest($4::text[]) AS required(source)
         LEFT JOIN hosted_indexer_cursors AS cursor
           ON cursor.chain_id=$1 AND cursor.source=required.source
          AND cursor.block_number=$2 AND lower(cursor.block_hash)=lower($3)
         WHERE cursor.source IS NULL LIMIT 1`,
        [row.chain_id,replacementNumber.toString(),replacementHash,row.required_indexer_sources],
      )
      if (missingCursor.rowCount !== 0) {
        throw new Error(`post-finality replacement branch has not been replayed by ${missingCursor.rows[0]!.source}`)
      }
      const unavailableBlobs = await client.query(
        `SELECT 1 FROM hosted_blob_requirements
         WHERE chain_id=$1 AND canonical AND block_number <= $2
           AND status <> 'VERIFIED' LIMIT 1 FOR SHARE`,
        [row.chain_id,replacementNumber.toString()],
      )
      if (unavailableBlobs.rowCount !== 0) {
        throw new Error('post-finality replacement floor cannot finalize before all blob archives verify')
      }
      await client.query(
        `UPDATE hosted_canonical_floors SET
           block_number=$2,block_hash=$3,verified_sources=$4::jsonb,updated_at=clock_timestamp()
         WHERE chain_id=$1`,
        [row.chain_id,replacementNumber.toString(),replacementHash,JSON.stringify(finalizeSources)],
      )
      await client.query(
        `UPDATE hosted_l1_transactions SET status='SUPERSEDED',
           last_error='post-finality operation was superseded by independently verified canonical recovery',
           updated_at=clock_timestamp()
         WHERE chain_id=$1 AND block_number >= $2 AND status='RECOVERY_REQUIRED'`,
        [row.chain_id,row.branch_start_number],
      )
      const updated = await client.query<PostFinalityRecoveryRow>(
        `UPDATE hosted_post_finality_recoveries SET
           status='RESOLVED',replacement_floor_number=$2,replacement_floor_hash=$3,
           verified_sources=$4::jsonb,resolved_at=clock_timestamp()
         WHERE recovery_id=$1 AND status='BRANCH_INSTALLED'
         RETURNING ${POST_FINALITY_RECOVERY_SELECT}`,
        [
          input.recoveryId,replacementNumber.toString(),replacementHash,
          JSON.stringify({ ...row.verified_sources, finalize: finalizeSources }),
        ],
      )
      if (updated.rowCount !== 1) throw new Error('post-finality recovery finalization lost its fence')
      await this.reconcileAggregateBillingTx(client,Number(row.chain_id))
      await client.query(
        `UPDATE hosted_outbox SET resolved_at=COALESCE(resolved_at,clock_timestamp())
         WHERE resolved_at IS NULL AND (
           (topic='statusRetracted' AND aggregate_id IN (
             SELECT operation_id FROM hosted_l1_transactions
             WHERE chain_id=$2 AND block_number >= $3 AND status='SUPERSEDED'
           ))
           OR (topic='post-finality.recovery-branch-installed' AND aggregate_id=$1)
         )`, [input.recoveryId,row.chain_id,row.branch_start_number],
      )
      await this.outbox(client, null, 'post-finality.recovery-resolved', input.recoveryId, {
        chainId: Number(row.chain_id),
        operationId: row.operation_id,
        previousFloor: { number: row.prior_floor_number, hash: row.prior_floor_hash },
        replacementFloor: { number: replacementNumber.toString(), hash: replacementHash },
        verifiedSources: finalizeSources,
        state: 'SUPERSEDED_AND_RECONCILED',
      }, 'public-chain')
      return postFinalityRecovery(updated.rows[0]!)
    })
  }

  async postFinalityRecovery(recoveryId: string): Promise<PostFinalityRecovery | null> {
    const result = await this.pool.query<PostFinalityRecoveryRow>(
      `SELECT ${POST_FINALITY_RECOVERY_SELECT} FROM hosted_post_finality_recoveries
       WHERE recovery_id=$1`, [recoveryId],
    )
    return result.rows[0] ? postFinalityRecovery(result.rows[0]) : null
  }

  async markL1TransactionFinalized(
    fence: CoordinatorFence,
    operationId: string,
    finalizedBlock: string,
    finalizedHash: `0x${string}`,
  ): Promise<HostedL1Transaction> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET status='FINALIZED',finalized_block=$2,
           finalized_hash=$3,last_error=NULL,updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status='INCLUDED'
           AND (
             NOT EXISTS (SELECT 1 FROM hosted_l1_operation_access WHERE operation_id=$1)
             OR receipt_canonical
           )
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [operationId, finalizedBlock, finalizedHash.toLowerCase()],
      )
      if (!updated.rows[0]) throw new Error('included L1 operation is not finalizable')
      await this.outbox(client, null, 'l1-transaction.finalized', operationId, {
        transactionHash: updated.rows[0].transaction_hash,
        blockNumber: updated.rows[0].block_number,
        blockHash: updated.rows[0].block_hash,
        finalizedBlock, finalizedHash: finalizedHash.toLowerCase(),
      }, 'public-chain')
      return hostedL1Transaction(updated.rows[0])
    })
  }

  async markL1TransactionFailed(
    fence: CoordinatorFence,
    operationId: string,
    error: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query(
        `UPDATE hosted_l1_transactions SET status='FAILED',last_error=$2,updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status NOT IN ('FINALIZED','RECOVERY_REQUIRED')`,
        [operationId, error.slice(0, 500)],
      )
      if (result.rowCount !== 1) throw new Error('L1 operation cannot transition to failed')
      await this.outbox(client, null, 'l1-transaction.failed', operationId, { error: error.slice(0, 500) }, 'admin-internal')
    })
  }

  async recordL1TransactionAttemptError(
    fence: CoordinatorFence,
    operationId: string,
    error: string,
    backoffMs: number,
    deadlineRisk: boolean,
  ): Promise<HostedL1Transaction> {
    if (!Number.isSafeInteger(backoffMs) || backoffMs < 250 || backoffMs > 300_000) {
      throw new Error('L1 transaction retry backoff is outside the supported range')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET attempts=attempts+1,last_error=$2,
           last_attempt_at=clock_timestamp(),
           next_attempt_at=clock_timestamp() + ($3::double precision * interval '1 millisecond'),
           deadline_risk=$4,updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status IN ('PREPARED','SIGNED','BROADCAST','INCLUDED')
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [operationId, error.slice(0, 500), backoffMs, deadlineRisk],
      )
      if (!updated.rows[0]) throw new Error('L1 operation is not retryable')
      await this.outbox(client, null, 'l1-transaction.retry', operationId, {
        status: updated.rows[0].status,
        attempts: updated.rows[0].attempts,
        backoffMs,
        deadlineRisk,
      }, 'admin-internal')
      return hostedL1Transaction(updated.rows[0])
    })
  }

  async markL1TransactionRecoveryRequired(
    fence: CoordinatorFence,
    operationId: string,
    reason: string,
  ): Promise<HostedL1Transaction> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const updated = await client.query<HostedL1TransactionRow>(
        `UPDATE hosted_l1_transactions SET status='RECOVERY_REQUIRED',last_error=$2,
           updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status IN ('PREPARED','SIGNED','BROADCAST','INCLUDED')
         RETURNING ${HOSTED_L1_TRANSACTION_SELECT}`,
        [operationId, reason.slice(0, 500)],
      )
      if (!updated.rows[0]) throw new Error('L1 operation cannot enter recovery-required state')
      await this.outbox(client, null, 'l1-transaction.recovery-required', operationId, {
        status: updated.rows[0].status,
        attempts: updated.rows[0].attempts,
        reason: reason.slice(0, 500),
      }, 'admin-internal')
      return hostedL1Transaction(updated.rows[0])
    })
  }

  async l1Transaction(operationId: string): Promise<HostedL1Transaction | null> {
    const result = await this.pool.query<HostedL1TransactionRow>(
      `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
       FROM hosted_l1_transactions WHERE operation_id=$1`, [operationId],
    )
    return result.rows[0] ? hostedL1Transaction(result.rows[0]) : null
  }

  async l1TraceContextByTransactionHash(transactionHash:`0x${string}`):Promise<{
    correlationId:string;tenantId:string|null;roomId:string|null;operationId:string
  }|null> {
    const result=await this.pool.query<{
      correlation_id:string;tenant_id:string|null;room_id:string|null;operation_id:string
    }>(
      `SELECT transaction.operation_id,
              COALESCE(access.correlation_id,'withdrawal:'||claim.claim_id,
                'l1:'||transaction.transaction_hash) AS correlation_id,
              COALESCE(access.tenant_id,claim.tenant_id) AS tenant_id,
              COALESCE(binding.room_id::text,claim.room_id::text) AS room_id
       FROM hosted_l1_transactions AS transaction
       LEFT JOIN hosted_l1_operation_access AS access ON access.operation_id=transaction.operation_id
       LEFT JOIN hosted_l1_service_bindings AS binding ON binding.principal_id=access.principal_id
       LEFT JOIN hosted_withdrawal_claims AS claim ON claim.operation_id=transaction.operation_id
       WHERE lower(transaction.transaction_hash)=lower($1)`,[transactionHash],
    )
    const row=result.rows[0]
    return row ? {
      correlationId:row.correlation_id,tenantId:row.tenant_id,roomId:row.room_id,
      operationId:row.operation_id,
    } : null
  }

  async l1TransactionByIdempotencyKey(idempotencyKey: string): Promise<HostedL1Transaction | null> {
    const result = await this.pool.query<HostedL1TransactionRow>(
      `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
       FROM hosted_l1_transactions WHERE idempotency_key=$1`, [idempotencyKey],
    )
    return result.rows[0] ? hostedL1Transaction(result.rows[0]) : null
  }

  async pendingL1Transactions(limit = 100, operation: string | null = null): Promise<HostedL1Transaction[]> {
    const result = await this.pool.query<HostedL1TransactionRow>(
      `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
       FROM hosted_l1_transactions
       WHERE status IN ('PREPARED','SIGNED','BROADCAST','INCLUDED')
         AND next_attempt_at <= clock_timestamp()
         AND ($2::text IS NULL OR operation=$2)
       ORDER BY nonce,created_at LIMIT $1`, [Math.max(1, Math.min(limit, 1_000)), operation],
    )
    return result.rows.map(hostedL1Transaction)
  }

  async recentFinalizedL1Transactions(limit = 100): Promise<HostedL1Transaction[]> {
    const result = await this.pool.query<HostedL1TransactionRow>(
      `SELECT ${HOSTED_L1_TRANSACTION_SELECT}
       FROM hosted_l1_transactions WHERE status='FINALIZED'
       ORDER BY updated_at DESC LIMIT $1`, [Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map(hostedL1Transaction)
  }

  async nextFinalizedL1AuditBatch(
    fence: CoordinatorFence,
    chainId: number,
    sender: `0x${string}`,
    limit = 100,
  ): Promise<HostedL1Transaction[]> {
    const bounded = Math.max(1, Math.min(limit, 1_000))
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const normalizedSender = sender.toLowerCase()
      await client.query(
        `INSERT INTO hosted_l1_finality_audit_cursors(chain_id,sender)
         VALUES ($1,$2) ON CONFLICT (chain_id,sender) DO NOTHING`,
        [chainId, normalizedSender],
      )
      const cursor = await client.query<{ last_operation_id: string | null }>(
        `SELECT last_operation_id FROM hosted_l1_finality_audit_cursors
         WHERE chain_id=$1 AND sender=$2 FOR UPDATE`, [chainId, normalizedSender],
      )
      const last = cursor.rows[0]?.last_operation_id ?? null
      const after = await client.query<HostedL1TransactionRow>(
        `SELECT ${HOSTED_L1_TRANSACTION_SELECT} FROM hosted_l1_transactions
         WHERE chain_id=$1 AND sender=$2 AND status='FINALIZED'
           AND ($3::text IS NULL OR operation_id > $3)
         ORDER BY operation_id LIMIT $4`,
        [chainId, normalizedSender, last, bounded],
      )
      const rows = [...after.rows]
      if (rows.length < bounded && last !== null) {
        const wrapped = await client.query<HostedL1TransactionRow>(
          `SELECT ${HOSTED_L1_TRANSACTION_SELECT} FROM hosted_l1_transactions
           WHERE chain_id=$1 AND sender=$2 AND status='FINALIZED' AND operation_id <= $3
           ORDER BY operation_id LIMIT $4`,
          [chainId, normalizedSender, last, bounded - rows.length],
        )
        rows.push(...wrapped.rows)
      }
      await client.query(
        `UPDATE hosted_l1_finality_audit_cursors SET last_operation_id=$3,
           last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE chain_id=$1 AND sender=$2`,
        [chainId, normalizedSender, rows.at(-1)?.operation_id ?? last],
      )
      return rows.map(hostedL1Transaction)
    })
  }

  async indexerStatus(chainId: number): Promise<Record<string, unknown>> {
    const [head, anchor, floor, cursors, reconciliation] = await Promise.all([
      this.canonicalHead(chainId),
      this.canonicalAnchor(chainId),
      this.canonicalFloor(chainId),
      this.pool.query<{ source: string; block_number: string; block_hash: string; schema_version: number; updated_at: string }>(
        `SELECT source,block_number::text,block_hash,schema_version,updated_at::text
         FROM hosted_indexer_cursors WHERE chain_id=$1 ORDER BY source`, [chainId],
      ),
      this.pool.query<{ unresolved: string; unreconciled: string }>(
        `SELECT
           (SELECT count(*)::text FROM hosted_outbox
             WHERE retention_class='safety' AND resolved_at IS NULL) AS unresolved,
           (SELECT count(*)::text FROM hosted_room_observations
             WHERE chain_id=$1 AND NOT reconciled) AS unreconciled`, [chainId],
      ),
    ])
    return {
      chainId, head, anchor, floor, cursors: cursors.rows,
      unresolvedSafetyEvents: reconciliation.rows[0]?.unresolved ?? '0',
      unreconciledRooms: reconciliation.rows[0]?.unreconciled ?? '0',
    }
  }

  async indexerCursors(chainId: number): Promise<Array<{
    source: string
    blockNumber: string
    blockHash: `0x${string}`
    schemaVersion: number
  }>> {
    const result = await this.pool.query<{
      source: string
      block_number: string
      block_hash: `0x${string}`
      schema_version: number
    }>(
      `SELECT source,block_number::text,block_hash,schema_version
       FROM hosted_indexer_cursors WHERE chain_id=$1 ORDER BY source`,
      [chainId],
    )
    return result.rows.map((row) => ({
      source: row.source,
      blockNumber: row.block_number,
      blockHash: row.block_hash,
      schemaVersion: row.schema_version,
    }))
  }

  async requestIndexerBackfill(
    fence: CoordinatorFence,
    chainId: number,
    fromBlock: string,
    actorPrincipalId: string | null,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const floor = await client.query<{ block_number: string }>(
        `SELECT block_number::text FROM hosted_canonical_floors WHERE chain_id=$1 FOR SHARE`,
        [chainId],
      )
      const floorNumber = floor.rows[0]?.block_number
      if (!floorNumber) throw new Error('canonical finalized floor is unavailable')
      if (BigInt(fromBlock) <= BigInt(floorNumber)) {
        throw new Error('indexer backfill cannot rewind at or below the finalized archive floor')
      }
      const predecessorNumber = (BigInt(fromBlock) - 1n).toString()
      const predecessor = await client.query<{ block_hash: string }>(
        `SELECT block_hash FROM canonical_l1_blocks
         WHERE chain_id=$1 AND block_number=$2 AND canonical FOR SHARE`,
        [chainId, predecessorNumber],
      )
      const predecessorHash = predecessor.rows[0]?.block_hash
      if (!predecessorHash) throw new Error('indexer backfill predecessor is not canonical')
      const requestHash = createHash('sha256')
        .update(canonicalJson({ chainId, fromBlock }))
        .digest('hex')
      const claimed = await client.query<{ request_hash: string }>(
        `INSERT INTO hosted_idempotency_records(
           scope,operation,idempotency_key,request_hash,response_status,response_body,expires_at
         ) VALUES ('hosting-admin','indexer.backfill',$1,$2,202,$3::jsonb,
                   clock_timestamp()+interval '365 days')
         ON CONFLICT (scope,operation,idempotency_key) DO NOTHING
         RETURNING request_hash`,
        [idempotencyKey, requestHash, JSON.stringify({ chainId, fromBlock })],
      )
      if (claimed.rowCount === 0) {
        const existing = await client.query<{ request_hash: string; response_body: Record<string, unknown> }>(
          `SELECT request_hash,response_body FROM hosted_idempotency_records
           WHERE scope='hosting-admin' AND operation='indexer.backfill' AND idempotency_key=$1`,
          [idempotencyKey],
        )
        if (existing.rows[0]?.request_hash !== requestHash) {
          throw new Error('backfill idempotency key is bound to another request')
        }
        return { accepted: true, replay: true, ...existing.rows[0]!.response_body }
      }
      await client.query(
        `UPDATE hosted_indexer_cursors SET block_number=$2,block_hash=$3,updated_at=clock_timestamp()
         WHERE chain_id=$1 AND block_number >= $4`,
        [chainId, predecessorNumber, predecessorHash, fromBlock],
      )
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,idempotency_key,details)
         VALUES ($1,'indexer.backfill.request',$2,$3,$4::jsonb)`,
        [actorPrincipalId, `${chainId}:${fromBlock}`, idempotencyKey, JSON.stringify({ chainId, fromBlock })],
      )
      await this.outbox(client, null, 'indexer.backfill-requested', `${chainId}:${fromBlock}`, {
        chainId, fromBlock, predecessorNumber, predecessorHash,
      }, 'admin-internal')
      return { accepted: true, replay: false, chainId, fromBlock, predecessorNumber, predecessorHash }
    })
  }

  async requestRoomReconciliation(
    fence: CoordinatorFence,
    chainId: number,
    roomId: string,
    actorPrincipalId: string | null,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const requestHash = createHash('sha256')
        .update(canonicalJson({ chainId, roomId }))
        .digest('hex')
      const claimed = await client.query<{ request_hash: string }>(
        `INSERT INTO hosted_idempotency_records(
           scope,operation,idempotency_key,request_hash,response_status,response_body,expires_at
         ) VALUES ('hosting-admin','room.reconcile',$1,$2,202,$3::jsonb,
                   clock_timestamp()+interval '365 days')
         ON CONFLICT (scope,operation,idempotency_key) DO NOTHING
         RETURNING request_hash`,
        [idempotencyKey, requestHash, JSON.stringify({ chainId, roomId })],
      )
      if (claimed.rowCount === 0) {
        const existing = await client.query<{ request_hash: string; response_body: Record<string, unknown> }>(
          `SELECT request_hash,response_body FROM hosted_idempotency_records
           WHERE scope='hosting-admin' AND operation='room.reconcile' AND idempotency_key=$1`,
          [idempotencyKey],
        )
        if (existing.rows[0]?.request_hash !== requestHash) {
          throw new Error('reconciliation idempotency key is bound to another request')
        }
        return { accepted: true, replay: true, ...existing.rows[0]!.response_body }
      }
      await client.query(
        `INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
         VALUES ($1,$2,true,1000)
         ON CONFLICT (chain_id,room_id) DO UPDATE SET
           dirty=true,priority=GREATEST(hosted_room_reconciliation_queue.priority,1000),
           next_retry_at=NULL,updated_at=clock_timestamp()`,
        [chainId, roomId],
      )
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,idempotency_key,details)
         VALUES ($1,'room.reconcile.request',$2,$3,$4::jsonb)`,
        [actorPrincipalId, `${chainId}:${roomId}`, idempotencyKey, JSON.stringify({ chainId, roomId })],
      )
      await this.outbox(client, null, 'room.reconciliation-requested', `${chainId}:${roomId}`, {
        chainId, roomId,
      }, 'admin-internal')
      return { accepted: true, replay: false, chainId, roomId }
    })
  }

  async listCanonicalBlocks(chainId: number, fromBlock: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT block_number::text AS number,block_hash AS hash,parent_hash AS "parentHash",
              observed_at::text AS "observedAt"
       FROM canonical_l1_blocks
       WHERE chain_id=$1 AND canonical AND block_number >= $2
       ORDER BY block_number LIMIT $3`,
      [chainId, fromBlock, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows
  }

  async listIndexerLogs(input: {
    chainId: number
    roomId?: string | null
    eventNames?: string[]
    afterLogId?: string
    limit?: number
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT log.block_number::text || ':' || log.log_index::text AS "logId",
              log.block_number::text AS "blockNumber",
              log.block_hash AS "blockHash",log.log_index AS "logIndex",
              log.transaction_hash AS "transactionHash",log.address,event_name AS "eventName",
              log.decoded,log.observed_at::text AS "observedAt"
       FROM hosted_indexer_logs AS log
       WHERE log.chain_id=$1 AND log.canonical AND log.block_number >= $2
         AND ($3::text[] IS NULL OR log.event_name = ANY($3::text[]))
         AND ($4::numeric IS NULL OR EXISTS (
           SELECT 1 FROM hosted_indexer_facts AS fact
           WHERE fact.chain_id=log.chain_id AND fact.block_hash=log.block_hash
             AND fact.canonical AND fact.room_id=$4
             AND (fact.payload->>'transactionHash'=log.transaction_hash
               OR fact.fact_key LIKE log.transaction_hash || ':%')
         ))
       ORDER BY log.block_number,log.log_index LIMIT $5`,
      [
        input.chainId, input.afterLogId ?? '0', input.eventNames ?? null,
        input.roomId ?? null, Math.max(1, Math.min(input.limit ?? 200, 1_000)),
      ],
    )
    return result.rows
  }

  async indexedTransaction(
    chainId: number,
    transactionHash: `0x${string}`,
    tenantId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const [logs, facts] = await Promise.all([
      this.pool.query(
        `SELECT block_number::text || ':' || log_index::text AS "logId",
                block_number::text AS "blockNumber",
                block_hash AS "blockHash",log_index AS "logIndex",address,
                event_name AS "eventName",decoded
         FROM hosted_indexer_logs
         WHERE chain_id=$1 AND canonical AND lower(transaction_hash)=lower($2)
         ORDER BY log_index`,
        [chainId, transactionHash],
      ),
      this.pool.query(
        `SELECT fact_id::text AS "factId",fact_key AS "factKey",fact_kind AS "factKind",
                room_id::text AS "roomId",tenant_id AS "tenantId",block_number::text AS "blockNumber",
                block_hash AS "blockHash",payload
         FROM hosted_indexer_facts
         WHERE chain_id=$1 AND canonical
           AND (fact_key LIKE lower($2) || ':%' OR lower(payload->>'transactionHash')=lower($2))
           AND ($3::text IS NULL OR tenant_id IS NULL OR tenant_id=$3)
         ORDER BY fact_id`,
        [chainId, transactionHash, tenantId],
      ),
    ])
    if (logs.rowCount === 0 && facts.rowCount === 0) return null
    return { chainId, transactionHash: transactionHash.toLowerCase(), logs: logs.rows, facts: facts.rows }
  }

  async listIndexerFacts(input: {
    chainId: number
    tenantId: string | null
    factKinds?: string[]
    roomId?: string | null
    afterFactId?: string
    limit?: number
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT fact_id::text AS "factId",fact_key AS "factKey",fact_kind AS "factKind",
              room_id::text AS "roomId",tenant_id AS "tenantId",block_number::text AS "blockNumber",
              block_hash AS "blockHash",payload,created_at::text AS "createdAt"
       FROM hosted_indexer_facts
       WHERE chain_id=$1 AND canonical AND fact_id > $2
         AND ($3::text[] IS NULL OR fact_kind = ANY($3::text[]))
         AND ($4::numeric IS NULL OR room_id = $4)
         AND ($5::text IS NULL OR tenant_id IS NULL OR tenant_id = $5)
       ORDER BY fact_id LIMIT $6`,
      [
        input.chainId, input.afterFactId ?? '0', input.factKinds ?? null,
        input.roomId ?? null, input.tenantId,
        Math.max(1, Math.min(input.limit ?? 200, 1_000)),
      ],
    )
    return result.rows
  }

  async latestCanonicalRoomEvent(
    chainId:number,roomId:string,eventName:string,
  ):Promise<Record<string,unknown>|null> {
    if (!/^(?:0|[1-9][0-9]*)$/.test(roomId)) throw new Error('roomId must be an unsigned decimal')
    if (!/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(eventName)) throw new Error('eventName is invalid')
    const result=await this.pool.query(
      `SELECT fact_id::text AS "factId",fact_key AS "factKey",fact_kind AS "factKind",
              room_id::text AS "roomId",tenant_id AS "tenantId",block_number::text AS "blockNumber",
              block_hash AS "blockHash",payload,created_at::text AS "createdAt"
       FROM hosted_indexer_facts
       WHERE chain_id=$1 AND canonical AND room_id=$2
         AND payload #>> '{provenance,eventName}'=$3
       ORDER BY block_number DESC,fact_id DESC LIMIT 1`,[chainId,roomId,eventName],
    )
    return result.rows[0] ?? null
  }

  /**
   * Build the bounded semantic reconciliation input for one room. Heavy event
   * histories are reduced inside PostgreSQL: the worker receives cursor
   * extrema, only the newest field-check fixture for each stateful event, and
   * concrete invariant failures. This avoids a room-size-dependent heap scan
   * while still checking every canonical fact through SQL aggregates.
   */
  async roomSemanticProjection(
    chainId: number,
    roomId: string,
    throughBlock: string,
  ): Promise<HostedRoomSemanticProjection> {
    const semanticEvents = [
      'AdmissionRecorded','DepositQueued','DepositRefunded','ForcedTransactionQueued',
      'ForcedOutcomeRecorded','L1StateInputPublished','BatchAccepted',
      'WithdrawalRootPublished','WithdrawalClaimed','AggregateMemberOutcome',
       'OmissionChallengeOpened','OmissionChallengeRepaired','OmissionChallengeSettled',
       'ChallengePayoutClaimed','RoomClosedByRecovery','DataAvailabilityConfigured',
       'DataAvailabilityAccepted','RoomOwnershipAssigned','AllocationUsed','AllocationRenewed',
       'AllocationDisposed','ServiceBondFunded','ServiceBondWithdrawn',
    ]
    const [summaryResult,driftResult,conflictResult,referenceResult,sideResult,latestResult] = await Promise.all([
      this.pool.query<{
        admission_max:string|null;deposit_queued_max:string|null;deposit_refunded_max:string|null;
        forced_queued_max:string|null;forced_outcome_max:string|null;import_max:string|null;
        batch_max:string|null;withdrawal_root_max:string|null;withdrawal_claim_max:string|null
      }>(
        `WITH semantic AS (
           SELECT payload #>> '{provenance,eventName}' AS event_name,payload->'args' AS args
           FROM hosted_indexer_facts
           WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
             AND payload #>> '{provenance,eventName}'=ANY($4::text[])
         )
         SELECT
           max(CASE WHEN event_name='AdmissionRecorded' AND args->>'admissionId' ~ '^[0-9]+$' THEN (args->>'admissionId')::numeric END)::text AS admission_max,
           max(CASE WHEN event_name='DepositQueued' AND args->>'inboxId' ~ '^[0-9]+$' THEN (args->>'inboxId')::numeric END)::text AS deposit_queued_max,
           max(CASE WHEN event_name='DepositRefunded' AND args->>'inboxId' ~ '^[0-9]+$' THEN (args->>'inboxId')::numeric END)::text AS deposit_refunded_max,
           max(CASE WHEN event_name='ForcedTransactionQueued' AND args->>'forcedId' ~ '^[0-9]+$' THEN (args->>'forcedId')::numeric END)::text AS forced_queued_max,
           max(CASE WHEN event_name='ForcedOutcomeRecorded' AND args->>'forcedId' ~ '^[0-9]+$' THEN (args->>'forcedId')::numeric END)::text AS forced_outcome_max,
           max(CASE WHEN event_name='L1StateInputPublished' AND args->>'importId' ~ '^[0-9]+$' THEN (args->>'importId')::numeric END)::text AS import_max,
           max(CASE WHEN event_name='BatchAccepted' AND args->>'batchIndex' ~ '^[0-9]+$' THEN (args->>'batchIndex')::numeric END)::text AS batch_max,
           max(CASE WHEN event_name='WithdrawalRootPublished' AND args->>'outboxEpoch' ~ '^[0-9]+$' THEN (args->>'outboxEpoch')::numeric END)::text AS withdrawal_root_max,
           max(CASE WHEN event_name='WithdrawalClaimed' AND args->>'outboxEpoch' ~ '^[0-9]+$' THEN (args->>'outboxEpoch')::numeric END)::text AS withdrawal_claim_max
         FROM semantic`,[chainId,roomId,throughBlock,semanticEvents],
      ),
      this.pool.query<{ error:string }>(
        `SELECT 'fact ' || fact_id::text || ' has field-level provenance drift' AS error
         FROM hosted_indexer_facts
         WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
           AND (
             payload #>> '{provenance,eventName}' IS NULL
             OR payload #>> '{provenance,chainId}' <> chain_id::text
             OR payload #>> '{provenance,blockNumber}' <> block_number::text
             OR lower(COALESCE(payload #>> '{provenance,blockHash}','')) <> lower(block_hash)
             OR payload #>> '{args,roomId}' <> room_id::text
             OR COALESCE(payload #>> '{provenance,transactionHash}','') !~ '^0x[0-9a-f]{64}$'
             OR CASE WHEN jsonb_typeof(payload #> '{provenance,verifiedSources}')='array'
                  THEN jsonb_array_length(payload #> '{provenance,verifiedSources}')<2 ELSE true END
           )
         ORDER BY fact_id LIMIT 100`,[chainId,roomId,throughBlock],
      ),
      this.pool.query<{ error:string }>(
        `WITH semantic AS (
           SELECT payload #>> '{provenance,eventName}' AS event_name,payload->'args' AS args,
             CASE payload #>> '{provenance,eventName}'
               WHEN 'AdmissionRecorded' THEN payload #>> '{args,admissionId}'
               WHEN 'DepositQueued' THEN payload #>> '{args,inboxId}'
               WHEN 'DepositRefunded' THEN payload #>> '{args,inboxId}'
               WHEN 'ForcedTransactionQueued' THEN payload #>> '{args,forcedId}'
               WHEN 'ForcedOutcomeRecorded' THEN payload #>> '{args,forcedId}'
               WHEN 'L1StateInputPublished' THEN payload #>> '{args,importId}'
               WHEN 'BatchAccepted' THEN payload #>> '{args,batchIndex}'
               WHEN 'WithdrawalRootPublished' THEN payload #>> '{args,outboxEpoch}'
               WHEN 'WithdrawalClaimed' THEN concat(payload #>> '{args,outboxEpoch}',':',payload #>> '{args,index}')
               WHEN 'AggregateMemberOutcome' THEN concat(payload #>> '{args,aggregateHash}',':',payload #>> '{args,memberIndex}')
               WHEN 'OmissionChallengeOpened' THEN payload #>> '{args,admissionId}'
               WHEN 'OmissionChallengeRepaired' THEN payload #>> '{args,admissionId}'
               WHEN 'OmissionChallengeSettled' THEN payload #>> '{args,receiptHash}'
               WHEN 'ChallengePayoutClaimed' THEN concat(payload #>> '{args,payee}',':',payload #>> '{args,amount}')
               WHEN 'RoomClosedByRecovery' THEN 'room'
               WHEN 'DataAvailabilityConfigured' THEN 'room'
               WHEN 'DataAvailabilityAccepted' THEN payload #>> '{args,batchIndex}'
               WHEN 'RoomOwnershipAssigned' THEN 'room'
               WHEN 'AllocationUsed' THEN payload #>> '{args,allocationId}'
               WHEN 'AllocationRenewed' THEN payload #>> '{args,newAllocationId}'
               WHEN 'AllocationDisposed' THEN payload #>> '{args,allocationId}'
               WHEN 'ServiceBondFunded' THEN payload #>> '{args,bondEpoch}'
               WHEN 'ServiceBondWithdrawn' THEN 'room'
             END AS identity
           FROM hosted_indexer_facts
           WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
             AND payload #>> '{provenance,eventName}'=ANY($4::text[])
         )
         SELECT event_name || ' identity ' || identity || ' has conflicting canonical payloads' AS error
         FROM semantic WHERE identity IS NOT NULL
         GROUP BY event_name,identity HAVING count(DISTINCT args::text)>1
         ORDER BY event_name,identity LIMIT 100`,[chainId,roomId,throughBlock,semanticEvents],
      ),
      this.pool.query<{ error:string }>(
        `WITH facts AS (
           SELECT payload #>> '{provenance,eventName}' AS event_name,payload->'args' AS args,
                  payload #>> '{provenance,transactionHash}' AS transaction_hash
           FROM hosted_indexer_facts
           WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
         )
         SELECT 'DepositRefunded inboxId ' || (refund.args->>'inboxId') || ' has no canonical DepositQueued fact' AS error
         FROM facts AS refund WHERE refund.event_name='DepositRefunded' AND NOT EXISTS (
           SELECT 1 FROM facts AS queued WHERE queued.event_name='DepositQueued'
             AND (queued.args->>'inboxId')=(refund.args->>'inboxId'))
         UNION ALL
         SELECT 'ForcedOutcomeRecorded forcedId ' || (outcome.args->>'forcedId') || ' does not match its canonical queue fact'
         FROM facts AS outcome WHERE outcome.event_name='ForcedOutcomeRecorded' AND NOT EXISTS (
           SELECT 1 FROM facts AS queued WHERE queued.event_name='ForcedTransactionQueued'
             AND (queued.args->>'forcedId')=(outcome.args->>'forcedId')
             AND lower(queued.args->>'transactionHash')=lower(outcome.args->>'transactionHash'))
         UNION ALL
         SELECT 'WithdrawalClaimed epoch ' || (claim.args->>'outboxEpoch') || ' has no canonical root fact'
         FROM facts AS claim WHERE claim.event_name='WithdrawalClaimed' AND NOT EXISTS (
           SELECT 1 FROM facts AS root WHERE root.event_name='WithdrawalRootPublished'
             AND (root.args->>'outboxEpoch')=(claim.args->>'outboxEpoch'))
         UNION ALL
         SELECT 'applied AggregateMemberOutcome lacks same-transaction BatchAccepted room/batch parity'
         FROM facts AS outcome WHERE outcome.event_name='AggregateMemberOutcome'
           AND outcome.args->>'applied'='true' AND NOT EXISTS (
             SELECT 1 FROM facts AS batch WHERE batch.event_name='BatchAccepted'
               AND batch.transaction_hash=outcome.transaction_hash
               AND batch.args->>'batchIndex'=outcome.args->>'batchIndex')
         UNION ALL
         SELECT 'failed AggregateMemberOutcome conflicts with a same-transaction BatchAccepted fact'
         FROM facts AS outcome WHERE outcome.event_name='AggregateMemberOutcome'
           AND outcome.args->>'applied'='false' AND EXISTS (
             SELECT 1 FROM facts AS batch WHERE batch.event_name='BatchAccepted'
               AND batch.transaction_hash=outcome.transaction_hash
               AND batch.args->>'batchIndex'=outcome.args->>'batchIndex')
         LIMIT 100`,[chainId,roomId,throughBlock],
      ),
      this.pool.query<{ error:string }>(
        `SELECT error FROM (
           SELECT 'AdmissionRecorded fact is missing an exact ACKED admission WAL row' AS error
           WHERE EXISTS (
             SELECT 1 FROM hosted_indexer_facts AS fact
             LEFT JOIN admission_wal AS wal ON wal.room_id=fact.room_id
               AND wal.admission_id=CASE WHEN fact.payload #>> '{args,admissionId}' ~ '^[0-9]+$'
                 THEN (fact.payload #>> '{args,admissionId}')::numeric END
             WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.canonical AND fact.block_number<=$3
               AND fact.payload #>> '{provenance,eventName}'='AdmissionRecorded'
               AND (wal.room_id IS NULL OR wal.status<>'ACKED'
                 OR lower(wal.transaction_hash)<>lower(fact.payload #>> '{args,transactionHash}')))
           UNION ALL
           SELECT 'sponsorship counters or reservation tenant/unit/allocation binding drifted'
           WHERE EXISTS (
             SELECT 1 FROM hosted_sponsorships AS sponsor
             JOIN LATERAL (
               SELECT COALESCE(sum(res.quantity) FILTER (WHERE res.status='RESERVED'),0) AS reserved,
                      COALESCE(sum(res.quantity) FILTER (WHERE res.status='CONSUMED'),0) AS consumed,
                      bool_or(res.unit<>sponsor.unit OR res.tenant_id<>sponsor.beneficiary_tenant_id
                        OR (sponsor.allocation_id IS NOT NULL AND res.allocation_id IS DISTINCT FROM sponsor.allocation_id)) AS mismatch,
                       bool_or(job.room_id=$2) AS touches_room
               FROM hosted_sponsorship_reservations AS res
               LEFT JOIN hosted_prove_jobs AS job ON job.job_id=res.job_id
               WHERE res.sponsorship_id=sponsor.sponsorship_id
             ) AS totals ON totals.touches_room
             WHERE totals.mismatch OR totals.reserved<>sponsor.reserved_quantity
               OR totals.consumed<>sponsor.consumed_quantity
               OR sponsor.reserved_quantity+sponsor.consumed_quantity>sponsor.maximum_quantity)
           UNION ALL
           SELECT 'aggregate manifest member count or canonical allocation binding drifted'
           WHERE EXISTS (
             SELECT 1 FROM hosted_aggregate_billing_manifests AS manifest
             JOIN hosted_aggregate_billing_members AS member
               ON member.chain_id=manifest.chain_id AND member.aggregate_hash=manifest.aggregate_hash
             LEFT JOIN hosted_indexer_facts AS allocation ON allocation.fact_id=member.allocation_fact_id
             WHERE member.chain_id=$1 AND member.room_id=$2
             GROUP BY manifest.chain_id,manifest.aggregate_hash,manifest.member_count
             HAVING count(*)<>manifest.member_count OR bool_or(
               member.allocation_id IS NOT NULL AND (
                 allocation.fact_id IS NULL OR NOT allocation.canonical OR allocation.chain_id<>member.chain_id
                 OR allocation.room_id<>member.room_id
                 OR lower(allocation.block_hash)<>lower(member.allocation_fact_block_hash)
                 OR lower(COALESCE(allocation.payload #>> '{args,allocationId}',allocation.payload #>> '{args,newAllocationId}',''))<>lower(member.allocation_id))))
           UNION ALL
           SELECT 'finalized aggregate outcome lacks success-only billing/sponsorship projection'
           WHERE EXISTS (
             SELECT 1 FROM hosted_aggregate_outcome_receipts AS receipt
             JOIN hosted_aggregate_billing_members AS member ON member.chain_id=receipt.chain_id
               AND member.aggregate_hash=receipt.aggregate_hash AND member.member_index=receipt.member_index
             JOIN hosted_indexer_facts AS fact ON fact.fact_id=receipt.source_fact_id AND fact.canonical
             JOIN hosted_canonical_floors AS floor ON floor.chain_id=fact.chain_id AND fact.block_number<=floor.block_number
             LEFT JOIN hosted_aggregate_outcome_retractions AS retraction ON retraction.receipt_id=receipt.receipt_id
             WHERE member.chain_id=$1 AND member.room_id=$2 AND retraction.receipt_id IS NULL AND (
               (receipt.applied AND NOT EXISTS (
                 SELECT 1 FROM hosted_billing_ledger AS ledger WHERE ledger.source_fact_id=fact.fact_id
                   AND ledger.job_id=member.job_id AND ledger.entry_kind='CHARGE'))
               OR (receipt.applied AND member.allocation_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM hosted_billing_ledger AS ledger WHERE ledger.source_fact_id=fact.fact_id
                   AND ledger.job_id=member.job_id AND ledger.entry_kind='L1_ALLOCATION_CHARGE'))
               OR (receipt.applied AND member.sponsorship_id IS NOT NULL AND receipt.sponsorship_effect<>'CONSUMED')
               OR (NOT receipt.applied AND receipt.sponsorship_effect NOT IN ('NONE','RELEASED'))))
           UNION ALL
           SELECT 'finalized withdrawal root projection does not match canonical indexed provenance'
           WHERE EXISTS (
             SELECT 1 FROM hosted_withdrawal_epochs AS epoch
             WHERE epoch.chain_id=$1 AND epoch.room_id=$2 AND epoch.status='FINALIZED'
               AND NOT EXISTS (
                 SELECT 1 FROM hosted_indexer_facts AS fact WHERE fact.chain_id=epoch.chain_id
                   AND fact.room_id=epoch.room_id AND fact.canonical
                   AND fact.payload #>> '{provenance,eventName}'='WithdrawalRootPublished'
                   AND fact.payload #>> '{args,outboxEpoch}'=epoch.epoch::text
                   AND lower(fact.payload #>> '{args,withdrawalRoot}')=lower(epoch.withdrawal_root)
                   AND lower(fact.payload #>> '{provenance,transactionHash}')=lower(epoch.source_transaction_hash)
                   AND fact.block_number=epoch.finalized_block AND lower(fact.block_hash)=lower(epoch.finalized_hash)))
           UNION ALL
           SELECT 'claimed withdrawal projection has no canonical WithdrawalClaimed fact'
           WHERE EXISTS (
             SELECT 1 FROM hosted_withdrawals AS withdrawal
             WHERE withdrawal.chain_id=$1 AND withdrawal.room_id=$2 AND withdrawal.status='CLAIMED'
               AND NOT EXISTS (
                 SELECT 1 FROM hosted_indexer_facts AS fact WHERE fact.chain_id=withdrawal.chain_id
                   AND fact.room_id=withdrawal.room_id AND fact.canonical
                   AND fact.payload #>> '{provenance,eventName}'='WithdrawalClaimed'
                   AND fact.payload #>> '{args,outboxEpoch}'=withdrawal.epoch::text
                   AND fact.payload #>> '{args,index}'=withdrawal.withdrawal_index::text))
           UNION ALL
           SELECT 'blob-backed data-availability fact is not durably archived and verified'
           WHERE EXISTS (
             SELECT 1 FROM hosted_indexer_facts AS fact
             LEFT JOIN hosted_blob_requirements AS requirement ON requirement.chain_id=fact.chain_id
               AND requirement.room_id=fact.room_id
               AND requirement.batch_index=CASE WHEN fact.payload #>> '{args,batchIndex}' ~ '^[0-9]+$'
                 THEN (fact.payload #>> '{args,batchIndex}')::numeric END
               AND lower(requirement.transaction_hash)=lower(fact.payload #>> '{provenance,transactionHash}')
               AND lower(requirement.block_hash)=lower(fact.block_hash)
             WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.canonical AND fact.block_number<=$3
               AND fact.payload #>> '{provenance,eventName}'='DataAvailabilityAccepted'
               AND fact.payload #>> '{args,usedBlob}'='true'
               AND (requirement.requirement_id IS NULL OR NOT requirement.canonical OR requirement.status<>'VERIFIED'))
           UNION ALL
           SELECT 'challenge/bond custody event contains a malformed zero or negative amount'
           WHERE EXISTS (
             SELECT 1 FROM hosted_indexer_facts AS fact
             WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.canonical AND fact.block_number<=$3
               AND fact.payload #>> '{provenance,eventName}'=ANY(ARRAY[
                 'OmissionChallengeOpened','OmissionChallengeSettled','ChallengePayoutClaimed',
                 'ServiceBondFunded','ServiceBondWithdrawn']::text[])
               AND CASE fact.payload #>> '{provenance,eventName}'
                 WHEN 'OmissionChallengeOpened' THEN fact.payload #>> '{args,penalty}'
                 WHEN 'OmissionChallengeSettled' THEN fact.payload #>> '{args,penalty}'
                 ELSE fact.payload #>> '{args,amount}' END !~ '^[1-9][0-9]*$')
         ) AS failures`,[chainId,roomId,throughBlock],
      ),
      this.pool.query<{
        event_name:string;args:Record<string,unknown>;calldata:Record<string,unknown>|null;
        transaction_hash:`0x${string}`;
        block_number:string;block_hash:`0x${string}`
      }>(
         `SELECT DISTINCT ON (payload #>> '{provenance,eventName}')
                 payload #>> '{provenance,eventName}' AS event_name,payload->'args' AS args,
                 payload->'calldata' AS calldata,
                lower(payload #>> '{provenance,transactionHash}') AS transaction_hash,
                block_number::text,lower(block_hash) AS block_hash
         FROM hosted_indexer_facts
         WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
           AND payload #>> '{provenance,eventName}'=ANY($4::text[])
         ORDER BY payload #>> '{provenance,eventName}',block_number DESC,fact_id DESC`,
        [chainId,roomId,throughBlock,[
          'AdmissionRecorded','DepositQueued','DepositRefunded','ForcedTransactionQueued',
          'ForcedOutcomeRecorded','WithdrawalRootPublished','WithdrawalClaimed',
          'RoomClosedByRecovery','DataAvailabilityConfigured','DataAvailabilityAccepted',
           'RoomOwnershipAssigned','AllocationUsed','AllocationRenewed','AllocationDisposed',
           'OmissionChallengeRepaired','OmissionChallengeSettled','ChallengePayoutClaimed',
           'OmissionChallengeOpened','ServiceBondFunded','ServiceBondWithdrawn',
        ]],
      ),
    ])
    const summary=summaryResult.rows[0]
    return {
      errors:[...driftResult.rows,...conflictResult.rows,...referenceResult.rows,...sideResult.rows]
        .map((row) => row.error),
      cursors:{
        admissionMax:summary?.admission_max ?? null,
        depositQueuedMax:summary?.deposit_queued_max ?? null,
        depositRefundedMax:summary?.deposit_refunded_max ?? null,
        forcedQueuedMax:summary?.forced_queued_max ?? null,
        forcedOutcomeMax:summary?.forced_outcome_max ?? null,
        importMax:summary?.import_max ?? null,batchMax:summary?.batch_max ?? null,
        withdrawalRootMax:summary?.withdrawal_root_max ?? null,
        withdrawalClaimMax:summary?.withdrawal_claim_max ?? null,
      },
      latestFacts:latestResult.rows.map((row) => ({
        eventName:row.event_name,args:row.args,calldata:row.calldata ?? null,
        transactionHash:row.transaction_hash,
        blockNumber:row.block_number,blockHash:row.block_hash,
      })),
    }
  }

  async systemSemanticProjection(
    chainId:number,throughBlock:string,
  ):Promise<HostedSystemSemanticProjection> {
    const failures=await this.pool.query<{ error:string }>(
      `WITH facts AS (
         SELECT fact_id,block_number,block_hash,payload->'args' AS args,
                payload #>> '{provenance,eventName}' AS event_name,
                payload #>> '{provenance,transactionHash}' AS transaction_hash
         FROM hosted_indexer_facts
         WHERE chain_id=$1 AND canonical AND block_number<=$2
       )
       SELECT error FROM (
         SELECT 'NodeStatusChanged contains an invalid status/observedBlock' AS error
         WHERE EXISTS (
           SELECT 1 FROM facts WHERE event_name='NodeStatusChanged' AND (
             args->>'status' !~ '^[0-7]$'
             OR CASE WHEN args->>'observedBlock' ~ '^[0-9]+$'
               THEN (args->>'observedBlock')::numeric>block_number ELSE true END))
         UNION ALL
         SELECT 'NodeRetired has no prior canonical NodeDrainStarted transition'
         WHERE EXISTS (
           SELECT 1 FROM facts AS retired WHERE retired.event_name='NodeRetired' AND NOT EXISTS (
             SELECT 1 FROM facts AS drain WHERE drain.event_name='NodeDrainStarted'
               AND drain.args->>'nodeId'=retired.args->>'nodeId' AND drain.block_number<=retired.block_number))
         UNION ALL
         SELECT 'retired node has a later non-retired canonical status transition'
         WHERE EXISTS (
           SELECT 1 FROM facts AS retired JOIN facts AS later
             ON later.args->>'nodeId'=retired.args->>'nodeId' AND later.block_number>retired.block_number
           WHERE retired.event_name='NodeRetired' AND later.event_name='NodeStatusChanged'
             AND later.args->>'status'<>'6')
         UNION ALL
         SELECT 'draining node has a non-terminal canonical status transition'
         WHERE EXISTS (
           SELECT 1 FROM facts AS drain JOIN facts AS later
             ON later.args->>'nodeId'=drain.args->>'nodeId' AND later.block_number>drain.block_number
           WHERE drain.event_name='NodeDrainStarted' AND later.event_name='NodeStatusChanged'
             AND later.args->>'status' NOT IN ('6','7'))
         UNION ALL
         SELECT 'CapacityProfileConfirmed lacks an exact canonical requested profile/nonce'
         WHERE EXISTS (
           SELECT 1 FROM facts AS confirmed WHERE confirmed.event_name='CapacityProfileConfirmed'
             AND NOT EXISTS (
               SELECT 1 FROM facts AS requested WHERE requested.event_name='CapacityProfileRequested'
                 AND requested.args->>'nodeId'=confirmed.args->>'nodeId'
                 AND requested.args->>'profileHash'=confirmed.args->>'profileHash'
                 AND requested.args->>'profileNonce'=confirmed.args->>'profileNonce'
                 AND requested.block_number<=confirmed.block_number))
         UNION ALL
         SELECT 'node lifecycle operation is not bound to its exact canonical transition fact'
         WHERE EXISTS (
           SELECT 1 FROM hosted_node_lifecycle_operations AS operation
           LEFT JOIN hosted_indexer_facts AS fact ON fact.fact_id=operation.canonical_fact_id
           WHERE operation.status='APPLIED' AND (
             fact.fact_id IS NULL OR NOT fact.canonical OR fact.chain_id<>$1
             OR lower(fact.block_hash)<>lower(operation.canonical_fact_block_hash)
             OR fact.payload #>> '{args,nodeId}'<>operation.onchain_node_id
             OR fact.payload #>> '{provenance,eventName}'<>CASE operation.desired_state
               WHEN 'DRAINING' THEN 'NodeDrainStarted' ELSE 'NodeRetired' END))
         UNION ALL
         SELECT 'provider remains assignment-eligible after drain/retire was requested'
         WHERE EXISTS (
           SELECT 1 FROM hosted_node_lifecycle_operations AS operation
           JOIN hosted_provider_nodes AS provider ON provider.principal_id=operation.principal_id
           WHERE operation.status IN ('PENDING','LEASED','RETRY','VERIFYING','APPLIED','RECOVERY_REQUIRED')
             AND provider.active)
         UNION ALL
         SELECT 'node lifecycle requires operator recovery before readiness'
         WHERE EXISTS (SELECT 1 FROM hosted_node_lifecycle_operations WHERE status='RECOVERY_REQUIRED')
       ) AS semantic_failures`,[chainId,throughBlock],
    )
    const latest=await this.pool.query<{
      event_name:string;args:Record<string,unknown>;transaction_hash:`0x${string}`;
      block_number:string;block_hash:`0x${string}`
    }>(
      `WITH ranked AS (
         SELECT payload #>> '{provenance,eventName}' AS event_name,payload->'args' AS args,
                lower(payload #>> '{provenance,transactionHash}') AS transaction_hash,
                block_number::text,lower(block_hash) AS block_hash,
                row_number() OVER (
                  PARTITION BY payload #>> '{args,nodeId}',payload #>> '{provenance,eventName}'
                  ORDER BY block_number DESC,fact_id DESC
                ) AS rank
         FROM hosted_indexer_facts
         WHERE chain_id=$1 AND canonical AND block_number<=$2
           AND payload #>> '{provenance,eventName}'=ANY($3::text[])
           AND payload #>> '{args,nodeId}' ~ '^0x[0-9a-f]{64}$'
       )
       SELECT event_name,args,transaction_hash,block_number,block_hash
       FROM ranked WHERE rank=1 ORDER BY args->>'nodeId',event_name LIMIT 6001`,
      [chainId,throughBlock,[
        'NodeRegistered','NodeStatusChanged','NodeDrainStarted','NodeRetired',
        'CapacityProfileRequested','CapacityProfileConfirmed',
      ]],
    )
    const errors=failures.rows.map((row) => row.error)
    if (latest.rows.length>6_000) errors.push('node semantic reconciliation exceeds the 1000-node bounded profile')
    return {
      errors,
      latestNodeFacts:latest.rows.slice(0,6_000).map((row) => ({
        eventName:row.event_name,args:row.args,transactionHash:row.transaction_hash,
        blockNumber:row.block_number,blockHash:row.block_hash,
      })),
    }
  }

  async roomObservation(chainId: number, roomId: string, tenantId: string | null): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT chain_id::text AS "chainId",room_id::text AS "roomId",tenant_id AS "tenantId",
              schema_version AS "schemaVersion",head_block::text AS "headBlock",head_hash AS "headHash",
              document,reconciled,reconciliation_errors AS "reconciliationErrors",updated_at::text AS "updatedAt"
       FROM hosted_room_observations
       WHERE chain_id=$1 AND room_id=$2
         AND ($3::text IS NULL OR tenant_id IS NULL OR tenant_id=$3)`,
      [chainId, roomId, tenantId],
    )
    return result.rows[0] ?? null
  }

  /**
   * Persist the exact structured preimage of the immutable on-chain policy
   * hash. The caller supplies bytes, not authority: registration succeeds only
   * against a reconciled canonical room observation carrying the same hash.
   */
  async registerRoomProvingPolicy(
    fence: CoordinatorFence,
    input: {
      chainId: number
      roomId: string
      tenantId: string
      principalId: string
      policyHash: `0x${string}`
      policy: Record<string,unknown>
      objectKey: string
      objectDigest: string
      idempotencyKey: string
    },
  ): Promise<{ created: boolean; boundBlock: string; boundHash: string }> {
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const observation=await client.query<{
        tenant_id:string | null; head_block:string; head_hash:string; document:Record<string,unknown>;
        schema_version:number; reconciled:boolean; reconciliation_errors:unknown
      }>(
        `SELECT observation.tenant_id,observation.head_block::text,lower(observation.head_hash) AS head_hash,
                observation.document,observation.schema_version,observation.reconciled,
                observation.reconciliation_errors
         FROM hosted_room_observations AS observation
         JOIN canonical_l1_blocks AS block ON block.chain_id=observation.chain_id
           AND block.block_number=observation.head_block
           AND lower(block.block_hash)=lower(observation.head_hash) AND block.canonical
         WHERE observation.chain_id=$1 AND observation.room_id=$2 FOR SHARE`,
        [input.chainId,input.roomId],
      )
      const observed=observation.rows[0]
      if (!observed || observed.tenant_id!==input.tenantId) {
        throw new HostedAuthError('room policy binding is unavailable')
      }
      if (
        observed.schema_version!==2 || !observed.reconciled
        || !Array.isArray(observed.reconciliation_errors) || observed.reconciliation_errors.length!==0
      ) throw new Error('room policy binding requires a schema-current reconciled observation')
      const state=observed.document.roomState
      const onchainHash=state && typeof state==='object' && !Array.isArray(state)
        ? String((state as Record<string,unknown>).policyHash ?? '').toLowerCase()
        : ''
      if (onchainHash!==input.policyHash.toLowerCase()) {
        throw new Error('execution policy preimage does not match the canonical room policyHash')
      }
      const inserted=await client.query(
        `INSERT INTO hosted_room_proving_policies(
           chain_id,room_id,tenant_id,policy_hash,policy,object_key,object_digest,
           bound_block,bound_hash,principal_id,idempotency_key
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [input.chainId,input.roomId,input.tenantId,input.policyHash.toLowerCase(),JSON.stringify(input.policy),
          input.objectKey,input.objectDigest,observed.head_block,observed.head_hash,
          input.principalId,input.idempotencyKey],
      )
      if (inserted.rowCount===0) {
        const existing=await client.query<{
          chain_id:string;room_id:string;tenant_id:string;policy_hash:string;policy:Record<string,unknown>;
          object_key:string;object_digest:string;principal_id:string;idempotency_key:string;
          bound_block:string;bound_hash:string
        }>(
          `SELECT chain_id::text,room_id::text,tenant_id,policy_hash,policy,object_key,object_digest,
                  principal_id,idempotency_key,bound_block::text,bound_hash
           FROM hosted_room_proving_policies
           WHERE idempotency_key=$1 OR (chain_id=$2 AND room_id=$3) FOR SHARE`,
          [input.idempotencyKey,input.chainId,input.roomId],
        )
        if (existing.rows.length!==1) throw new Error('proving policy conflict is ambiguous')
        const prior=existing.rows[0]!
        if (
          prior.chain_id!==String(input.chainId) || prior.room_id!==input.roomId
          || prior.tenant_id!==input.tenantId || prior.policy_hash!==input.policyHash.toLowerCase()
          || prior.object_key!==input.objectKey || prior.object_digest!==input.objectDigest
          || prior.principal_id!==input.principalId || prior.idempotency_key!==input.idempotencyKey
        ) throw new Error('proving policy idempotency key or room is bound to different immutable content')
        return { created:false,boundBlock:prior.bound_block,boundHash:prior.bound_hash }
      }
      await client.query(
        `INSERT INTO hosted_audit_records(tenant_id,principal_id,action,target,idempotency_key,details)
         VALUES ($1,$2,'room.proving-policy.bind',$3,$4,$5::jsonb)`,
        [input.tenantId,input.principalId,`${input.chainId}:${input.roomId}`,input.idempotencyKey,
          JSON.stringify({ policyHash:input.policyHash,objectDigest:input.objectDigest,
            boundBlock:observed.head_block,boundHash:observed.head_hash })],
      )
      await this.outbox(client,input.tenantId,'room.proving-policy',input.roomId,{
        chainId:input.chainId,roomId:input.roomId,policyHash:input.policyHash,
        objectDigest:input.objectDigest,boundBlock:observed.head_block,boundHash:observed.head_hash,
      })
      return { created:true,boundBlock:observed.head_block,boundHash:observed.head_hash }
    })
  }

  async roomProvingContext(
    chainId:number,roomId:string,tenantId:string,
  ): Promise<Record<string,unknown> | null> {
    const result=await this.pool.query(
      `SELECT observation.chain_id::text AS "chainId",observation.room_id::text AS "roomId",
              observation.tenant_id AS "tenantId",observation.schema_version AS "schemaVersion",
              observation.head_block::text AS "headBlock",lower(observation.head_hash) AS "headHash",
              observation.document,observation.reconciled,
              observation.reconciliation_errors AS "reconciliationErrors",
              policy.policy_hash AS "policyHash",policy.policy,
              policy.object_key AS "policyObjectKey",policy.object_digest AS "policyObjectDigest"
       FROM hosted_room_observations AS observation
       JOIN canonical_l1_blocks AS block ON block.chain_id=observation.chain_id
         AND block.block_number=observation.head_block
         AND lower(block.block_hash)=lower(observation.head_hash) AND block.canonical
       JOIN hosted_room_proving_policies AS policy ON policy.chain_id=observation.chain_id
         AND policy.room_id=observation.room_id AND policy.tenant_id=observation.tenant_id
       WHERE observation.chain_id=$1 AND observation.room_id=$2 AND observation.tenant_id=$3`,
      [chainId,roomId,tenantId],
    )
    return result.rows[0] ?? null
  }

  /**
   * The ordered still-unsequenced forced-transaction queue for one room. The
   * raw signed bytes exist ONLY in the ForcedTransactionQueued event (the
   * contract stores just hash+deadline), so the live composer reads them from
   * canonical indexed facts rather than any L1 view.
   */
  async roomPendingForcedTransactions(
    chainId:number,roomId:string,throughBlock:string,forcedCursor:string,
  ):Promise<Array<{
    forcedId:string
    transactionHash:string
    deadlineBlock:string
    rawSignedTransaction:string
  }>> {
    const result=await this.pool.query<{
      forced_id:string;transaction_hash:string;deadline_block:string;raw_signed_transaction:string
    }>(
      `SELECT payload #>> '{args,forcedId}' AS forced_id,
              lower(payload #>> '{args,transactionHash}') AS transaction_hash,
              payload #>> '{args,deadlineBlock}' AS deadline_block,
              lower(payload #>> '{args,rawSignedTransaction}') AS raw_signed_transaction
       FROM hosted_indexer_facts
       WHERE chain_id=$1 AND room_id=$2 AND canonical AND block_number<=$3
         AND payload #>> '{provenance,eventName}'='ForcedTransactionQueued'
         AND payload #>> '{args,forcedId}' ~ '^[0-9]+$'
         AND (payload #>> '{args,forcedId}')::numeric > $4::numeric
       ORDER BY (payload #>> '{args,forcedId}')::numeric
       LIMIT 256`,
      [chainId,roomId,throughBlock,forcedCursor],
    )
    return result.rows.map((row) => ({
      forcedId:row.forced_id,
      transactionHash:row.transaction_hash,
      deadlineBlock:row.deadline_block,
      rawSignedTransaction:row.raw_signed_transaction,
    }))
  }

  async roomReconciliationStatus(
    chainId: number,
    roomId: string,
    tenantId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT queue.chain_id::text AS "chainId",queue.room_id::text AS "roomId",
              queue.dirty,queue.priority,queue.attempts,
              queue.last_attempt_at::text AS "lastAttemptAt",
              queue.last_success_at::text AS "lastSuccessAt",
              queue.last_success_block::text AS "lastSuccessBlock",
              queue.last_success_hash AS "lastSuccessHash",queue.last_error AS "lastError",
              queue.next_retry_at::text AS "nextRetryAt",queue.updated_at::text AS "updatedAt"
       FROM hosted_room_reconciliation_queue AS queue
       LEFT JOIN hosted_room_observations AS observation
         ON observation.chain_id=queue.chain_id AND observation.room_id=queue.room_id
       WHERE queue.chain_id=$1 AND queue.room_id=$2
         AND ($3::text IS NULL OR observation.tenant_id IS NULL OR observation.tenant_id=$3)`,
      [chainId, roomId, tenantId],
    )
    return result.rows[0] ?? null
  }

  /**
   * Bind a complete, locally root-checked prover witness to the independently
   * indexed WithdrawalRootPublished fact. Caller input is data, never trust:
   * the event must already be canonical and below the finalized/archive floor.
   */
  async indexFinalizedWithdrawalEpoch(
    fence: CoordinatorFence,
    input: FinalizedWithdrawalEpochInput,
  ): Promise<{ created: boolean; tenantId: string | null; finalizedBlock: string; finalizedHash: string }> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const facts = await client.query<{
        tenant_id: string | null
        block_number: string
        block_hash: string
        withdrawal_root: string
        transaction_hash: string
      }>(
        `SELECT fact.tenant_id,fact.block_number::text,fact.block_hash,
                lower(fact.payload #>> '{args,withdrawalRoot}') AS withdrawal_root,
                lower(fact.payload #>> '{provenance,transactionHash}') AS transaction_hash
         FROM hosted_indexer_facts AS fact
         JOIN hosted_canonical_floors AS floor ON floor.chain_id=fact.chain_id
         WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.fact_kind='withdrawal'
           AND fact.canonical AND fact.block_number <= floor.block_number
           AND fact.payload #>> '{provenance,eventName}'='WithdrawalRootPublished'
           AND fact.payload #>> '{args,outboxEpoch}'=$3
         ORDER BY fact.block_number,fact.fact_id FOR SHARE`,
        [input.chainId, input.roomId, input.epoch],
      )
      if (facts.rowCount !== 1) {
        throw new Error('exactly one finalized canonical WithdrawalRootPublished fact is required')
      }
      const fact = facts.rows[0]!
      if (
        fact.withdrawal_root !== input.withdrawalRoot.toLowerCase()
        || !/^0x[0-9a-f]{64}$/.test(fact.transaction_hash)
      ) throw new Error('computed withdrawal root does not match the finalized canonical fact')

      const observedTenant = await client.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM hosted_room_observations
         WHERE chain_id=$1 AND room_id=$2 FOR SHARE`, [input.chainId, input.roomId],
      )
      const tenantId = fact.tenant_id ?? observedTenant.rows[0]?.tenant_id ?? null
      const inserted = await client.query(
        `INSERT INTO hosted_withdrawal_epochs(
           chain_id,room_id,epoch,tenant_id,deployment_domain,capacity,withdrawal_root,
           source_object_key,source_transaction_hash,finalized_block,finalized_hash,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'FINALIZED')
         ON CONFLICT (chain_id,room_id,epoch) DO NOTHING`,
        [
          input.chainId, input.roomId, input.epoch, tenantId,
          input.deploymentDomain.toLowerCase(), input.capacity, input.withdrawalRoot.toLowerCase(),
          input.sourceObjectKey, fact.transaction_hash, fact.block_number, fact.block_hash.toLowerCase(),
        ],
      )
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          tenant_id: string | null
          deployment_domain: string
          capacity: number
          withdrawal_root: string
          source_object_key: string
          source_transaction_hash: string
          finalized_block: string
          finalized_hash: string
        }>(
          `SELECT tenant_id,deployment_domain,capacity,withdrawal_root,source_object_key,
                  source_transaction_hash,finalized_block::text,finalized_hash
           FROM hosted_withdrawal_epochs
           WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 FOR UPDATE`,
          [input.chainId, input.roomId, input.epoch],
        )
        const row = existing.rows[0]
        if (
          !row || row.tenant_id !== tenantId
          || row.deployment_domain !== input.deploymentDomain.toLowerCase()
          || row.capacity !== input.capacity
          || row.withdrawal_root !== input.withdrawalRoot.toLowerCase()
          || row.source_object_key !== input.sourceObjectKey
          || row.source_transaction_hash !== fact.transaction_hash
          || row.finalized_block !== fact.block_number
          || row.finalized_hash !== fact.block_hash.toLowerCase()
        ) throw new Error('withdrawal epoch is already bound to different immutable witness bytes')
      }

      for (const record of input.records) {
        const row = await client.query(
          `INSERT INTO hosted_withdrawals(
             chain_id,room_id,epoch,withdrawal_index,tenant_id,approver_epoch,
             recipient,asset,amount,withdrawal_root,leaf_hash,positional_proof,
             finalized_block,finalized_hash,status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,'FINALIZED')
           ON CONFLICT (chain_id,room_id,epoch,withdrawal_index) DO NOTHING`,
          [
            input.chainId, input.roomId, input.epoch, record.index, tenantId,
            record.approverEpoch, record.recipient.toLowerCase(), record.asset.toLowerCase(),
            record.amount, input.withdrawalRoot.toLowerCase(), record.leafHash.toLowerCase(),
            JSON.stringify(record.positionalProof.map((item) => item.toLowerCase())),
            fact.block_number, fact.block_hash.toLowerCase(),
          ],
        )
        if (row.rowCount === 0) {
          const existing = await client.query<{
            tenant_id: string | null
            approver_epoch: string
            recipient: string
            asset: string
            amount: string
            withdrawal_root: string
            leaf_hash: string
            positional_proof: string[]
            finalized_block: string
            finalized_hash: string
          }>(
            `SELECT tenant_id,approver_epoch::text,recipient,asset,amount::text,
                    withdrawal_root,leaf_hash,positional_proof,finalized_block::text,finalized_hash
             FROM hosted_withdrawals
             WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4 FOR UPDATE`,
            [input.chainId, input.roomId, input.epoch, record.index],
          )
          const found = existing.rows[0]
          if (
            !found || found.tenant_id !== tenantId || found.approver_epoch !== record.approverEpoch
            || found.recipient !== record.recipient.toLowerCase()
            || found.asset !== record.asset.toLowerCase() || found.amount !== record.amount
            || found.withdrawal_root !== input.withdrawalRoot.toLowerCase()
            || found.leaf_hash !== record.leafHash.toLowerCase()
            || canonicalJson(found.positional_proof) !== canonicalJson(record.positionalProof.map((item) => item.toLowerCase()))
            || found.finalized_block !== fact.block_number
            || found.finalized_hash !== fact.block_hash.toLowerCase()
          ) throw new Error('withdrawal leaf is already bound to different immutable witness bytes')
        }
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM hosted_withdrawals
         WHERE chain_id=$1 AND room_id=$2 AND epoch=$3`,
        [input.chainId, input.roomId, input.epoch],
      )
      if (BigInt(count.rows[0]?.count ?? '-1') !== BigInt(input.records.length)) {
        throw new Error('withdrawal epoch contains leaves outside the complete witness')
      }
      if (inserted.rowCount === 1) {
        await this.outbox(client, tenantId, 'withdrawal.proofs-finalized', `${input.chainId}:${input.roomId}:${input.epoch}`, {
          chainId: input.chainId, roomId: input.roomId, epoch: input.epoch,
          withdrawalRoot: input.withdrawalRoot.toLowerCase(), withdrawals: input.records.length,
          finalizedBlock: fact.block_number, finalizedHash: fact.block_hash.toLowerCase(),
        }, tenantId ? 'tenant' : 'admin-internal')
      }
      return {
        created: inserted.rowCount === 1,
        tenantId,
        finalizedBlock: fact.block_number,
        finalizedHash: fact.block_hash.toLowerCase(),
      }
    })
  }

  async listWithdrawals(input: {
    chainId: number
    tenantId: string | null
    roomId?: string | null
    status?: string | null
    limit?: number
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT chain_id::text AS "chainId",room_id::text AS "roomId",epoch::text,
              withdrawal_index::text AS "withdrawalIndex",tenant_id AS "tenantId",
              approver_epoch::text AS "approverEpoch",recipient,asset,amount::text,
              withdrawal_root AS "withdrawalRoot",leaf_hash AS "leafHash",
              finalized_block::text AS "finalizedBlock",finalized_hash AS "finalizedHash",
              status,previous_status AS "previousStatus",retraction_reason AS "retractionReason",
              updated_at::text AS "updatedAt"
       FROM hosted_withdrawals
       WHERE chain_id=$1
         AND ($2::text IS NULL OR tenant_id=$2)
         AND ($3::numeric IS NULL OR room_id=$3)
         AND ($4::text IS NULL OR status=$4)
       ORDER BY finalized_block DESC,room_id,epoch,withdrawal_index LIMIT $5`,
      [
        input.chainId, input.tenantId, input.roomId ?? null, input.status ?? null,
        Math.max(1, Math.min(input.limit ?? 200, 1_000)),
      ],
    )
    return result.rows
  }

  async withdrawalProof(input: {
    chainId: number
    tenantId: string | null
    roomId: string
    epoch: string
    withdrawalIndex: string
  }): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT chain_id::text AS "chainId",room_id::text AS "roomId",epoch::text,
              withdrawal_index::text AS "withdrawalIndex",tenant_id AS "tenantId",
              approver_epoch::text AS "approverEpoch",recipient,asset,amount::text,
              withdrawal_root AS "withdrawalRoot",leaf_hash AS "leafHash",
              positional_proof AS "positionalProof",finalized_block::text AS "finalizedBlock",
              finalized_hash AS "finalizedHash",status
       FROM hosted_withdrawals
       WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4
         AND status IN ('FINALIZED','CLAIM_PENDING','CLAIMED')
         AND ($5::text IS NULL OR tenant_id=$5)`,
      [input.chainId, input.roomId, input.epoch, input.withdrawalIndex, input.tenantId],
    )
    return result.rows[0] ?? null
  }

  async requestWithdrawalClaim(
    fence: CoordinatorFence,
    input: {
      chainId: number
      tenantId: string
      roomId: string
      epoch: string
      withdrawalIndex: string
      idempotencyKey: string
    },
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const withdrawal = await client.query<{ status: string }>(
        `SELECT status FROM hosted_withdrawals
         WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4
           AND tenant_id=$5 FOR UPDATE`,
        [input.chainId, input.roomId, input.epoch, input.withdrawalIndex, input.tenantId],
      )
      const source = withdrawal.rows[0]
      if (!source || !['FINALIZED', 'CLAIM_PENDING'].includes(source.status)) {
        throw new HostedAuthError('finalized tenant withdrawal was not found or is not claimable')
      }
      const inserted = await client.query<{ claim_id: string; status: string }>(
        `INSERT INTO hosted_withdrawal_claims(
           chain_id,room_id,epoch,withdrawal_index,tenant_id,idempotency_key,status
         ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING claim_id::text,status`,
        [input.chainId, input.roomId, input.epoch, input.withdrawalIndex, input.tenantId, input.idempotencyKey],
      )
      let row = inserted.rows[0]
      if (!row) {
        const existing = await client.query<{
          claim_id: string; chain_id: string; room_id: string; epoch: string
          withdrawal_index: string; tenant_id: string; status: string
        }>(
          `SELECT claim_id::text,chain_id::text,room_id::text,epoch::text,
                  withdrawal_index::text,tenant_id,status
           FROM hosted_withdrawal_claims WHERE idempotency_key=$1`,
          [input.idempotencyKey],
        )
        const found = existing.rows[0]
        if (
          !found || Number(found.chain_id) !== input.chainId || found.room_id !== input.roomId
          || found.epoch !== input.epoch || found.withdrawal_index !== input.withdrawalIndex
          || found.tenant_id !== input.tenantId
        ) throw new Error('withdrawal claim idempotency key is bound to another request')
        row = found
      } else {
        await client.query(
          `UPDATE hosted_withdrawals SET status='CLAIM_PENDING',updated_at=clock_timestamp()
           WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4`,
          [input.chainId, input.roomId, input.epoch, input.withdrawalIndex],
        )
        await this.outbox(client, input.tenantId, 'withdrawal.claim-requested', row.claim_id, {
          chainId: input.chainId, roomId: input.roomId, epoch: input.epoch,
          withdrawalIndex: input.withdrawalIndex,
        })
      }
      return { claimId: row.claim_id, status: row.status }
    })
  }

  async withdrawalClaim(claimId: string, tenantId: string | null = null): Promise<HostedWithdrawalClaim | null> {
    const result = await this.pool.query<HostedWithdrawalClaimRow>(
      `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
       WHERE claim_id=$1 AND ($2::text IS NULL OR tenant_id=$2)`, [claimId, tenantId],
    )
    return result.rows[0] ? hostedWithdrawalClaim(result.rows[0]) : null
  }

  async withdrawalClaimByOperationId(operationId: string): Promise<HostedWithdrawalClaim | null> {
    const result = await this.pool.query<HostedWithdrawalClaimRow>(
      `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
       WHERE operation_id=$1`, [operationId],
    )
    return result.rows[0] ? hostedWithdrawalClaim(result.rows[0]) : null
  }

  async withdrawalClaimProof(claimId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT claim.claim_id::text AS "claimId",claim.chain_id::text AS "chainId",
              claim.room_id::text AS "roomId",claim.epoch::text,
              claim.withdrawal_index::text AS "withdrawalIndex",claim.tenant_id AS "tenantId",
              withdrawal.approver_epoch::text AS "approverEpoch",withdrawal.recipient,
              withdrawal.asset,withdrawal.amount::text,withdrawal.withdrawal_root AS "withdrawalRoot",
              withdrawal.leaf_hash AS "leafHash",withdrawal.positional_proof AS "positionalProof",
              epoch.deployment_domain AS "deploymentDomain",epoch.capacity,
              withdrawal.finalized_block::text AS "finalizedBlock",
              withdrawal.finalized_hash AS "finalizedHash",claim.status,
              claim.operation_id AS "operationId",claim.transaction_hash AS "transactionHash"
       FROM hosted_withdrawal_claims AS claim
       JOIN hosted_withdrawals AS withdrawal
         ON withdrawal.chain_id=claim.chain_id AND withdrawal.room_id=claim.room_id
        AND withdrawal.epoch=claim.epoch AND withdrawal.withdrawal_index=claim.withdrawal_index
       JOIN hosted_withdrawal_epochs AS epoch
         ON epoch.chain_id=claim.chain_id AND epoch.room_id=claim.room_id AND epoch.epoch=claim.epoch
       WHERE claim.claim_id=$1 AND withdrawal.status IN ('FINALIZED','CLAIM_PENDING','CLAIMED')
         AND epoch.status='FINALIZED'`, [claimId],
    )
    return result.rows[0] ?? null
  }

  async leaseWithdrawalClaims(
    fence: CoordinatorFence,
    chainId: number,
    workerId: string,
    limit = 25,
    leaseMs = 60_000,
  ): Promise<HostedWithdrawalClaim[]> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(workerId)) throw new Error('withdrawal worker id is invalid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('withdrawal claim lease limit is invalid')
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000) throw new Error('withdrawal claim lease TTL is invalid')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<HostedWithdrawalClaimRow>(
        `WITH picked AS (
           SELECT claim_id AS picked_claim_id FROM hosted_withdrawal_claims
           WHERE chain_id=$1 AND status='PENDING' AND operation_id IS NULL
             AND next_attempt_at <= clock_timestamp()
             AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
           ORDER BY claim_id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE hosted_withdrawal_claims AS claim SET
           lease_owner=$3,
           lease_expires_at=clock_timestamp() + ($4::bigint * interval '1 millisecond'),
           attempts=attempts+1,updated_at=clock_timestamp()
         FROM picked WHERE claim.claim_id=picked.picked_claim_id
         RETURNING ${HOSTED_WITHDRAWAL_CLAIM_SELECT}`,
        [chainId, limit, workerId, leaseMs],
      )
      return result.rows.map(hostedWithdrawalClaim)
    })
  }

  async attachWithdrawalClaimOperation(
    fence: CoordinatorFence,
    claimId: string,
    workerId: string,
    operationId: string,
    transactionHash: `0x${string}`,
  ): Promise<HostedWithdrawalClaim> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<HostedWithdrawalClaimRow>(
        `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
         WHERE claim_id=$1 FOR UPDATE`, [claimId],
      )
      const row = current.rows[0]
      if (!row) throw new Error('withdrawal claim was not found')
      if (row.operation_id) {
        if (row.operation_id !== operationId || row.transaction_hash !== transactionHash.toLowerCase()) {
          throw new Error('withdrawal claim is already bound to another L1 operation')
        }
        return hostedWithdrawalClaim(row)
      }
      if (
        row.status !== 'PENDING' || row.lease_owner !== workerId || !row.lease_expires_at
      ) throw new HostedFenceError('withdrawal claim lease is absent or expired')
      const updated = await client.query<HostedWithdrawalClaimRow>(
        `UPDATE hosted_withdrawal_claims SET operation_id=$3,transaction_hash=$4,status='SUBMITTED',
           lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,
           next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE claim_id=$1 AND lease_owner=$2 AND lease_expires_at > clock_timestamp()
         RETURNING ${HOSTED_WITHDRAWAL_CLAIM_SELECT}`,
        [claimId, workerId, operationId, transactionHash.toLowerCase()],
      )
      if (!updated.rows[0]) throw new HostedFenceError('withdrawal claim lease was lost')
      await this.outbox(client, row.tenant_id, 'withdrawal.claim-submitted', claimId, {
        claimId, operationId, transactionHash: transactionHash.toLowerCase(),
      })
      return hostedWithdrawalClaim(updated.rows[0])
    })
  }

  async releaseWithdrawalClaimLease(
    fence: CoordinatorFence,
    claimId: string,
    workerId: string,
    error: string,
    backoffMs: number,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query(
        `UPDATE hosted_withdrawal_claims SET lease_owner=NULL,lease_expires_at=NULL,
           error_code='RETRYABLE',error_message=$3,
           next_attempt_at=clock_timestamp() + ($4::double precision * interval '1 millisecond'),
           updated_at=clock_timestamp()
         WHERE claim_id=$1 AND lease_owner=$2 AND status='PENDING' AND operation_id IS NULL`,
        [claimId, workerId, error.slice(0, 500), Math.max(250, Math.min(backoffMs, 300_000))],
      )
      if (result.rowCount !== 1) throw new HostedFenceError('withdrawal claim retry lease was lost')
    })
  }

  /**
   * Complete a permissionless claim race only from a finalized canonical
   * WithdrawalClaimed fact. The live eth_call is never sufficient evidence by
   * itself, and the tenant claim lease is checked with database time.
   */
  async confirmExternallyClaimedWithdrawal(
    fence: CoordinatorFence,
    claimId: string,
    workerId: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<HostedWithdrawalClaimRow>(
        `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
         WHERE claim_id=$1 FOR UPDATE`, [claimId],
      )
      const claim = current.rows[0]
      if (!claim) throw new Error('withdrawal claim was not found')
      if (claim.status === 'CONFIRMED') return true
      if (claim.status !== 'PENDING' || claim.operation_id !== null || claim.lease_owner !== workerId) {
        throw new HostedFenceError('external withdrawal confirmation lease was lost')
      }
      const fact = await client.query<{ transaction_hash: string }>(
        `SELECT lower(fact.payload #>> '{provenance,transactionHash}') AS transaction_hash
         FROM hosted_indexer_facts AS fact
         JOIN hosted_canonical_floors AS floor ON floor.chain_id=fact.chain_id
         WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.fact_kind='withdrawal'
           AND fact.canonical AND fact.block_number <= floor.block_number
           AND fact.payload #>> '{provenance,eventName}'='WithdrawalClaimed'
           AND fact.payload #>> '{args,outboxEpoch}'=$3
           AND fact.payload #>> '{args,index}'=$4
         ORDER BY fact.block_number,fact.fact_id LIMIT 1 FOR SHARE`,
        [Number(claim.chain_id), claim.room_id, claim.epoch, claim.withdrawal_index],
      )
      const transactionHash = fact.rows[0]?.transaction_hash
      if (!transactionHash || !/^0x[0-9a-f]{64}$/.test(transactionHash)) return false
      const updated = await client.query(
        `UPDATE hosted_withdrawal_claims SET status='CONFIRMED',transaction_hash=$3,
           lease_owner=NULL,lease_expires_at=NULL,error_code='CANONICAL_EXTERNAL_CLAIM',
           error_message='a permissionless relayer claimed this withdrawal first',
           updated_at=clock_timestamp()
         WHERE claim_id=$1 AND lease_owner=$2 AND lease_expires_at > clock_timestamp()
           AND status='PENDING' AND operation_id IS NULL`,
        [claimId, workerId, transactionHash],
      )
      if (updated.rowCount !== 1) throw new HostedFenceError('external withdrawal confirmation lease expired')
      await client.query(
        `UPDATE hosted_withdrawals SET previous_status=status,status='CLAIMED',
           retraction_reason=NULL,updated_at=clock_timestamp()
         WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4
           AND status IN ('FINALIZED','CLAIM_PENDING')`,
        [claim.chain_id, claim.room_id, claim.epoch, claim.withdrawal_index],
      )
      await this.outbox(client, claim.tenant_id, 'withdrawal.claim-confirmed', claimId, {
        claimId, operationId: null, transactionHash, externalPermissionlessClaim: true,
      })
      return true
    })
  }

  async withdrawalClaimsForProcessing(chainId: number, limit = 100): Promise<HostedWithdrawalClaim[]> {
    const result = await this.pool.query<HostedWithdrawalClaimRow>(
      `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
       WHERE chain_id=$1 AND operation_id IS NOT NULL
         AND status IN ('SUBMITTED','CONFIRMED')
       ORDER BY claim_id LIMIT $2`, [chainId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map(hostedWithdrawalClaim)
  }

  async setWithdrawalClaimStatus(
    fence: CoordinatorFence,
    claimId: string,
    status: 'CONFIRMED' | 'FAILED' | 'RETRACTED',
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): Promise<HostedWithdrawalClaim> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<HostedWithdrawalClaimRow>(
        `SELECT ${HOSTED_WITHDRAWAL_CLAIM_SELECT} FROM hosted_withdrawal_claims
         WHERE claim_id=$1 FOR UPDATE`, [claimId],
      )
      const row = current.rows[0]
      if (!row || !row.operation_id) throw new Error('withdrawal claim has no L1 operation')
      if (row.status === status) return hostedWithdrawalClaim(row)
      if (
        (status === 'CONFIRMED' && row.status !== 'SUBMITTED')
        || (status === 'FAILED' && !['PENDING', 'SUBMITTED'].includes(row.status))
        || (status === 'RETRACTED' && row.status !== 'CONFIRMED')
      ) throw new Error(`withdrawal claim cannot transition from ${row.status} to ${status}`)
      const updated = await client.query<HostedWithdrawalClaimRow>(
        `UPDATE hosted_withdrawal_claims SET status=$2,error_code=$3,error_message=$4,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE claim_id=$1 RETURNING ${HOSTED_WITHDRAWAL_CLAIM_SELECT}`,
        [claimId, status, errorCode, errorMessage?.slice(0, 500) ?? null],
      )
      const withdrawalStatus = status === 'CONFIRMED'
        ? 'CLAIMED'
        : status === 'RETRACTED' ? 'RETRACTED' : 'FINALIZED'
      await client.query(
        `UPDATE hosted_withdrawals SET previous_status=status,status=$5,
           retraction_reason=$6,updated_at=clock_timestamp()
         WHERE chain_id=$1 AND room_id=$2 AND epoch=$3 AND withdrawal_index=$4`,
        [row.chain_id, row.room_id, row.epoch, row.withdrawal_index, withdrawalStatus, errorMessage],
      )
      await this.outbox(client, row.tenant_id, `withdrawal.claim-${status.toLowerCase()}`, claimId, {
        claimId, operationId: row.operation_id, transactionHash: row.transaction_hash,
        ...(errorCode ? { errorCode, errorMessage } : {}),
      })
      return hostedWithdrawalClaim(updated.rows[0]!)
    })
  }

  async createEntitlement(fence: CoordinatorFence, input: {
    entitlementId: string
    tenantId: string
    allocationId: string | null
    unit: string
    quantity: string
    startsAt: string
    expiresAt: string | null
    metadata: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const values = [
        input.entitlementId, input.tenantId, input.allocationId, input.unit,
        input.quantity, input.startsAt, input.expiresAt, JSON.stringify(input.metadata),
      ] as const
      const inserted = await client.query(
        `INSERT INTO hosted_entitlements(
           entitlement_id,tenant_id,allocation_id,unit,quantity,starts_at,expires_at,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (entitlement_id) DO NOTHING`, values,
      )
      const existing = await client.query<{
        tenant_id: string; allocation_id: string | null; unit: string; quantity: string
        starts_at: string | Date; expires_at: string | Date | null; metadata: Record<string, unknown>
      }>(
        `SELECT tenant_id,allocation_id,unit,quantity::text,starts_at,expires_at,metadata
         FROM hosted_entitlements WHERE entitlement_id=$1`, [input.entitlementId],
      )
      const row = existing.rows[0]
      if (
        !row || row.tenant_id !== input.tenantId || row.allocation_id !== input.allocationId
        || row.unit !== input.unit || canonicalDecimal(row.quantity) !== canonicalDecimal(input.quantity)
        || canonicalTimestamp(row.starts_at) !== canonicalTimestamp(input.startsAt)
        || (row.expires_at === null ? null : canonicalTimestamp(row.expires_at))
          !== (input.expiresAt === null ? null : canonicalTimestamp(input.expiresAt))
        || canonicalJson(row.metadata) !== canonicalJson(input.metadata)
      ) throw new Error('entitlement id is bound to different immutable terms')
      if (inserted.rowCount === 1) {
        await this.outbox(client, input.tenantId, 'entitlement.created', input.entitlementId, {
          allocationId: input.allocationId, unit: input.unit, quantity: input.quantity,
        })
      }
      return { entitlementId: input.entitlementId, created: inserted.rowCount === 1 }
    })
  }

  async listEntitlements(tenantId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT entitlement_id AS "entitlementId",tenant_id AS "tenantId",
              allocation_id AS "allocationId",unit,quantity::text,consumed::text,
              starts_at::text AS "startsAt",expires_at::text AS "expiresAt",active,metadata,
              updated_at::text AS "updatedAt"
       FROM hosted_entitlements WHERE tenant_id=$1
       ORDER BY starts_at DESC,entitlement_id LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows
  }

  async createSponsorship(fence: CoordinatorFence, input: {
    sponsorshipId: string
    sponsorTenantId: string
    beneficiaryTenantId: string
    allocationId: string | null
    maximumQuantity: string
    unit: string
    expiresAt: string | null
    metadata: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const inserted = await client.query(
        `INSERT INTO hosted_sponsorships(
           sponsorship_id,sponsor_tenant_id,beneficiary_tenant_id,allocation_id,
           maximum_quantity,unit,expires_at,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (sponsorship_id) DO NOTHING`,
        [
          input.sponsorshipId, input.sponsorTenantId, input.beneficiaryTenantId,
          input.allocationId, input.maximumQuantity, input.unit, input.expiresAt,
          JSON.stringify(input.metadata),
        ],
      )
      const existing = await client.query<{
        sponsor_tenant_id: string; beneficiary_tenant_id: string; allocation_id: string | null
        maximum_quantity: string; unit: string; expires_at: string | Date | null
        metadata: Record<string, unknown>
      }>(
        `SELECT sponsor_tenant_id,beneficiary_tenant_id,allocation_id,
                maximum_quantity::text,unit,expires_at,metadata
         FROM hosted_sponsorships WHERE sponsorship_id=$1`, [input.sponsorshipId],
      )
      const row = existing.rows[0]
      if (
        !row || row.sponsor_tenant_id !== input.sponsorTenantId
        || row.beneficiary_tenant_id !== input.beneficiaryTenantId
        || row.allocation_id !== input.allocationId || row.unit !== input.unit
        || canonicalDecimal(row.maximum_quantity) !== canonicalDecimal(input.maximumQuantity)
        || (row.expires_at === null ? null : canonicalTimestamp(row.expires_at))
          !== (input.expiresAt === null ? null : canonicalTimestamp(input.expiresAt))
        || canonicalJson(row.metadata) !== canonicalJson(input.metadata)
      ) throw new Error('sponsorship id is bound to different immutable terms')
      if (inserted.rowCount === 1) {
        await this.outbox(client, input.sponsorTenantId, 'sponsorship.created', input.sponsorshipId, {
          beneficiaryTenantId: input.beneficiaryTenantId, allocationId: input.allocationId,
          maximumQuantity: input.maximumQuantity, unit: input.unit,
        })
        if (input.beneficiaryTenantId !== input.sponsorTenantId) {
          await this.outbox(client, input.beneficiaryTenantId, 'sponsorship.received', input.sponsorshipId, {
            sponsorTenantId: input.sponsorTenantId, allocationId: input.allocationId,
            maximumQuantity: input.maximumQuantity, unit: input.unit,
          })
        }
      }
      return { sponsorshipId: input.sponsorshipId, created: inserted.rowCount === 1 }
    })
  }

  async listSponsorships(tenantId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT sponsorship_id AS "sponsorshipId",sponsor_tenant_id AS "sponsorTenantId",
              beneficiary_tenant_id AS "beneficiaryTenantId",allocation_id AS "allocationId",
              maximum_quantity::text AS "maximumQuantity",consumed_quantity::text AS "consumedQuantity",
              reserved_quantity::text AS "reservedQuantity",unit,active,
              expires_at::text AS "expiresAt",metadata,updated_at::text AS "updatedAt"
       FROM hosted_sponsorships
       WHERE sponsor_tenant_id=$1 OR beneficiary_tenant_id=$1
       ORDER BY updated_at DESC,sponsorship_id LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows
  }

  /**
   * Immutable sponsor terms for exact managed L1 sponsor-mutation binding.
   * Read-only: the route layer compares every field against the principal's
   * scoped binding and the caller-supplied request before any signing.
   */
  async sponsorshipAuthority(sponsorshipId: string): Promise<HostedSponsorshipAuthority | null> {
    const result = await this.pool.query<{
      sponsorship_id: string; sponsor_tenant_id: string; beneficiary_tenant_id: string
      allocation_id: string | null; unit: string; active: boolean; expires_at: string | null
    }>(
      `SELECT sponsorship_id,sponsor_tenant_id,beneficiary_tenant_id,allocation_id,unit,active,
              expires_at::text
       FROM hosted_sponsorships WHERE sponsorship_id=$1`, [sponsorshipId],
    )
    const row = result.rows[0]
    return row ? {
      sponsorshipId: row.sponsorship_id, sponsorTenantId: row.sponsor_tenant_id,
      beneficiaryTenantId: row.beneficiary_tenant_id, allocationId: row.allocation_id,
      unit: row.unit, active: row.active, expiresAt: row.expires_at,
    } : null
  }

  private async reconcileAggregateBillingTx(client: SqlClient, chainId: number): Promise<{
    charged: number
    retryable: number
    corrected: number
  }> {
    const outcomes = await client.query<{
      fact_id: string
      fact_key: string
      block_number: string
      block_hash: string
      event_time: string
      aggregate_hash: `0x${string}`
      member_index: number
      applied: boolean
      failure_selector: string
      job_id: string
      tenant_id: string
      payer_tenant_id: string
      room_id: string
      batch_index: string
      allocation_id: string | null
      allocation_fact_id: string | null
      allocation_fact_block_hash: string | null
      sponsorship_id: string | null
      billable_unit: string
      billable_quantity: string
      result_digest: string
      price_id: string
      unit_price: string
      currency: string
      price_effective_from: string
      quote_accepted_at: string
      maximum_charge_amount: string
      maximum_charge_currency: string
      sla_policy_id: string | null
      sla_effective_from: string | null
      service_class: HostedProveJob['serviceClass']
      actual_queue_ms: string | null
      actual_proof_ms: string | null
      transaction_hash: `0x${string}`
      destination_address: `0x${string}`
      operation_id: string
      gas_used: string | null
      effective_gas_price: string | null
      blob_gas_used: string | null
      blob_gas_price: string | null
      transaction_cost_wei: string | null
      member_count: number
      canonical_outcome_count: string
      applied_member_count: string
      applied_member_rank: string
      batch_accept_count: string
      allocation_link_count: string
    }>(
      `SELECT fact.fact_id::text,fact.fact_key,fact.block_number::text,fact.block_hash,
              event_block.observed_at::text AS event_time,
              member.aggregate_hash,member.member_index,
              (fact.payload #> '{args,applied}' = 'true'::jsonb) AS applied,
              COALESCE(fact.payload #>> '{args,failureSelector}','0x00000000') AS failure_selector,
              member.job_id,member.tenant_id,member.payer_tenant_id,
              member.room_id::text,member.batch_index::text,
              member.allocation_id,member.allocation_fact_id::text,member.allocation_fact_block_hash,
              member.sponsorship_id,member.billable_unit,
              member.billable_quantity::text,member.result_digest,member.price_id::text,member.unit_price::text,
              member.currency,member.price_effective_from::text,member.quote_accepted_at::text,
              member.maximum_charge_amount::text,member.maximum_charge_currency,
              member.sla_policy_id::text,member.sla_effective_from::text,job.service_class,
              job.actual_queue_ms::text,job.actual_proof_ms::text,
              manifest.transaction_hash,manifest.destination_address,manifest.operation_id,
              operation.gas_used::text,operation.effective_gas_price::text,
              operation.blob_gas_used::text,operation.blob_gas_price::text,
              CASE WHEN operation.gas_used IS NULL OR operation.effective_gas_price IS NULL THEN NULL
                   ELSE (operation.gas_used*operation.effective_gas_price
                     + COALESCE(operation.blob_gas_used,0)*COALESCE(operation.blob_gas_price,0))::text
              END AS transaction_cost_wei,
              manifest.member_count,
              (SELECT count(DISTINCT observed.payload #>> '{args,memberIndex}')::text
               FROM hosted_indexer_facts AS observed
               WHERE observed.chain_id=fact.chain_id AND observed.canonical
                 AND observed.payload #>> '{provenance,eventName}'='AggregateMemberOutcome'
                 AND lower(observed.payload #>> '{provenance,transactionHash}')=manifest.transaction_hash
                 AND lower(observed.payload #>> '{provenance,address}')=manifest.destination_address
                 AND lower(observed.payload #>> '{args,aggregateHash}')=member.aggregate_hash
              ) AS canonical_outcome_count,
              (SELECT count(*)::text FROM hosted_indexer_facts AS observed
               WHERE observed.chain_id=fact.chain_id AND observed.canonical
                 AND observed.payload #>> '{provenance,eventName}'='AggregateMemberOutcome'
                 AND lower(observed.payload #>> '{provenance,transactionHash}')=manifest.transaction_hash
                 AND lower(observed.payload #>> '{provenance,address}')=manifest.destination_address
                 AND lower(observed.payload #>> '{args,aggregateHash}')=member.aggregate_hash
                 AND observed.payload #> '{args,applied}'='true'::jsonb
              ) AS applied_member_count,
              (SELECT count(*)::text FROM hosted_indexer_facts AS observed
               WHERE observed.chain_id=fact.chain_id AND observed.canonical
                 AND observed.payload #>> '{provenance,eventName}'='AggregateMemberOutcome'
                 AND lower(observed.payload #>> '{provenance,transactionHash}')=manifest.transaction_hash
                 AND lower(observed.payload #>> '{provenance,address}')=manifest.destination_address
                 AND lower(observed.payload #>> '{args,aggregateHash}')=member.aggregate_hash
                 AND observed.payload #> '{args,applied}'='true'::jsonb
                 AND (observed.payload #>> '{args,memberIndex}')::integer < member.member_index
              ) AS applied_member_rank,
              (SELECT count(*)::text FROM hosted_indexer_facts AS accepted
               WHERE accepted.chain_id=fact.chain_id AND accepted.canonical
                 AND accepted.block_hash=fact.block_hash
                 AND accepted.payload #>> '{provenance,eventName}'='BatchAccepted'
                 AND lower(accepted.payload #>> '{provenance,transactionHash}')=manifest.transaction_hash
                 AND lower(accepted.payload #>> '{provenance,address}')=manifest.destination_address
                 AND accepted.payload #>> '{args,roomId}'=member.room_id::text
                 AND accepted.payload #>> '{args,batchIndex}'=member.batch_index::text
              ) AS batch_accept_count,
              (SELECT count(*)::text FROM hosted_indexer_facts AS allocation
               WHERE member.allocation_id IS NOT NULL AND allocation.fact_id=member.allocation_fact_id
                 AND allocation.chain_id=fact.chain_id AND allocation.canonical
                 AND allocation.block_hash=member.allocation_fact_block_hash
                 AND allocation.block_number <= fact.block_number
                 AND allocation.payload #>> '{provenance,eventName}' IN ('AllocationUsed','AllocationRenewed')
                 AND allocation.payload #>> '{args,roomId}'=member.room_id::text
                 AND lower(COALESCE(allocation.payload #>> '{args,allocationId}',
                                    allocation.payload #>> '{args,newAllocationId}'))=lower(member.allocation_id)
              ) AS allocation_link_count
       FROM hosted_aggregate_billing_members AS member
       JOIN hosted_aggregate_billing_manifests AS manifest
         ON manifest.chain_id=member.chain_id AND manifest.aggregate_hash=member.aggregate_hash
       JOIN hosted_l1_transactions AS operation
         ON operation.operation_id=manifest.operation_id
        AND operation.transaction_hash=manifest.transaction_hash
       JOIN hosted_prove_jobs AS job ON job.job_id=member.job_id AND job.status='DONE'
       JOIN hosted_canonical_floors AS floor ON floor.chain_id=member.chain_id
       JOIN hosted_indexer_facts AS fact
         ON fact.chain_id=member.chain_id AND fact.canonical
        AND fact.fact_kind='aggregate'
        AND fact.block_number <= floor.block_number
        AND fact.payload #>> '{provenance,eventName}'='AggregateMemberOutcome'
        AND lower(fact.payload #>> '{args,aggregateHash}')=member.aggregate_hash
        AND fact.payload #>> '{args,memberIndex}'=member.member_index::text
        AND fact.payload #>> '{args,roomId}'=member.room_id::text
        AND fact.payload #>> '{args,batchIndex}'=member.batch_index::text
        AND lower(fact.payload #>> '{provenance,transactionHash}')=manifest.transaction_hash
        AND lower(fact.payload #>> '{provenance,address}')=manifest.destination_address
       JOIN canonical_l1_blocks AS event_block
         ON event_block.chain_id=fact.chain_id AND event_block.block_number=fact.block_number
        AND event_block.block_hash=fact.block_hash AND event_block.canonical
       LEFT JOIN hosted_aggregate_outcome_receipts AS receipt ON receipt.source_fact_id=fact.fact_id
       WHERE member.chain_id=$1 AND receipt.receipt_id IS NULL
       ORDER BY fact.block_number,fact.fact_id
       FOR UPDATE OF fact,job`,
      [chainId],
    )
    let charged = 0
    let retryable = 0
    for (const outcome of outcomes.rows) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`aggregate-billing:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}`],
      )
      const active = await client.query<{ source_fact_id: string; source_canonical: boolean }>(
        `SELECT receipt.source_fact_id::text,fact.canonical AS source_canonical
         FROM hosted_aggregate_outcome_receipts AS receipt
         JOIN hosted_indexer_facts AS fact ON fact.fact_id=receipt.source_fact_id
         LEFT JOIN hosted_aggregate_outcome_retractions AS retraction
           ON retraction.receipt_id=receipt.receipt_id
         WHERE receipt.chain_id=$1 AND receipt.aggregate_hash=$2 AND receipt.member_index=$3
           AND retraction.retraction_id IS NULL FOR SHARE OF receipt`,
        [chainId,outcome.aggregate_hash,outcome.member_index],
      )
      if (active.rows[0]) {
        if (active.rows[0].source_fact_id === outcome.fact_id) continue
        if (!active.rows[0].source_canonical) continue
        throw new Error('multiple canonical outcomes exist for one aggregate member')
      }
      if ((outcome.applied && outcome.batch_accept_count !== '1')
        || (!outcome.applied && outcome.batch_accept_count !== '0')) {
        throw new Error('AggregateMemberOutcome does not have exact canonical BatchAccepted success parity')
      }
      if (outcome.allocation_id !== null && outcome.allocation_link_count !== '1') {
        throw new Error('aggregate member allocation lacks its exact canonical AllocationUsed/AllocationRenewed fact')
      }
      if (outcome.canonical_outcome_count !== String(outcome.member_count)) {
        throw new Error('aggregate billing waits for one canonical outcome for every immutable member')
      }
      if (outcome.applied && outcome.allocation_id !== null && outcome.transaction_cost_wei === null) {
        throw new Error('allocated aggregate member lacks independently agreed L1 receipt cost evidence')
      }
      if (
        outcome.maximum_charge_currency !== outcome.currency
        || Date.parse(outcome.price_effective_from) > Date.parse(outcome.quote_accepted_at)
        || Date.parse(outcome.quote_accepted_at) > Date.parse(outcome.event_time)
      ) throw new Error('aggregate member commercial quote is not effective for the canonical event time')
      const quoted = await client.query<{ amount: string; allowed: boolean }>(
        `SELECT ($1::numeric*$2::numeric)::text AS amount,
                $1::numeric*$2::numeric <= $3::numeric AS allowed`,
        [outcome.billable_quantity,outcome.unit_price,outcome.maximum_charge_amount],
      )
      if (!quoted.rows[0]!.allowed) throw new Error('final aggregate member charge exceeds its immutable accepted maximum')
      const amount = quoted.rows[0]!.amount
      let sponsorshipEffect: 'NONE' | 'CONSUMED' | 'RELEASED' = 'NONE'
      if (outcome.applied && outcome.sponsorship_id) {
        let consumed = await client.query<{ quantity: string }>(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity=sponsorship.reserved_quantity-reservation.quantity,
             consumed_quantity=sponsorship.consumed_quantity+reservation.quantity,
             updated_at=clock_timestamp()
           FROM hosted_sponsorship_reservations AS reservation
           WHERE reservation.job_id=$1 AND reservation.status='RESERVED'
             AND reservation.sponsorship_id=$2
             AND sponsorship.sponsorship_id=reservation.sponsorship_id
             AND sponsorship.beneficiary_tenant_id=$3
             AND sponsorship.sponsor_tenant_id=$4
             AND sponsorship.unit=reservation.unit AND reservation.unit=$5
             AND sponsorship.allocation_id IS NOT DISTINCT FROM reservation.allocation_id
             AND reservation.allocation_id IS NOT DISTINCT FROM $6::text
           RETURNING reservation.quantity::text`,
          [
            outcome.job_id,outcome.sponsorship_id,outcome.tenant_id,outcome.payer_tenant_id,
            outcome.billable_unit,outcome.allocation_id,
          ],
        )
        if (consumed.rowCount !== 1) {
          // A prior canonical failure may have released this exact immutable
          // reservation. After that failure was retracted, a replacement
          // canonical success may consume it directly, but only if doing so
          // still fits the sponsor maximum (a separate retry may have used it).
          consumed = await client.query<{ quantity: string }>(
            `UPDATE hosted_sponsorships AS sponsorship SET
               consumed_quantity=sponsorship.consumed_quantity+reservation.quantity,
               updated_at=clock_timestamp()
             FROM hosted_sponsorship_reservations AS reservation
             WHERE reservation.job_id=$1 AND reservation.status='RELEASED'
               AND reservation.sponsorship_id=$2
               AND sponsorship.sponsorship_id=reservation.sponsorship_id
               AND sponsorship.beneficiary_tenant_id=$3 AND sponsorship.sponsor_tenant_id=$4
               AND sponsorship.unit=reservation.unit AND reservation.unit=$5
               AND reservation.allocation_id IS NOT DISTINCT FROM $6::text
               AND sponsorship.consumed_quantity+sponsorship.reserved_quantity+reservation.quantity
                   <= sponsorship.maximum_quantity
               AND EXISTS (
                 SELECT 1 FROM hosted_aggregate_outcome_receipts AS prior
                 JOIN hosted_aggregate_outcome_retractions AS retraction
                   ON retraction.receipt_id=prior.receipt_id
                 WHERE prior.chain_id=$7 AND prior.aggregate_hash=$8 AND prior.member_index=$9
                   AND prior.sponsorship_effect='RELEASED'
               )
             RETURNING reservation.quantity::text`,
            [
              outcome.job_id,outcome.sponsorship_id,outcome.tenant_id,outcome.payer_tenant_id,
              outcome.billable_unit,outcome.allocation_id,chainId,outcome.aggregate_hash,outcome.member_index,
            ],
          )
        }
        if (consumed.rowCount !== 1) {
          throw new Error('finalized aggregate member lacks available durable sponsorship capacity')
        }
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status='CONSUMED',updated_at=clock_timestamp()
           WHERE job_id=$1 AND status IN ('RESERVED','RELEASED')`,
          [outcome.job_id],
        )
        await client.query(
          `INSERT INTO hosted_sponsorship_charges(
             sponsorship_id,job_id,tenant_id,quantity,idempotency_key,status
           ) VALUES ($1,$2,$3,$4,$5,'SUCCEEDED')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            outcome.sponsorship_id, outcome.job_id, outcome.payer_tenant_id,
            consumed.rows[0]!.quantity,
            `aggregate:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}:${outcome.fact_id}:sponsor`,
          ],
        )
        const exactCharge = await client.query<{
          sponsorship_id: string;job_id: string;tenant_id: string;quantity: string
        }>(
          `SELECT sponsorship_id,job_id,tenant_id,quantity::text
           FROM hosted_sponsorship_charges WHERE idempotency_key=$1 FOR SHARE`,
          [`aggregate:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}:${outcome.fact_id}:sponsor`],
        )
        if (
          exactCharge.rows[0]?.sponsorship_id !== outcome.sponsorship_id
          || exactCharge.rows[0]?.job_id !== outcome.job_id
          || exactCharge.rows[0]?.tenant_id !== outcome.payer_tenant_id
          || canonicalDecimal(exactCharge.rows[0]?.quantity ?? '-1')
            !== canonicalDecimal(consumed.rows[0]!.quantity)
        ) throw new Error('sponsorship charge idempotency key conflicts with immutable terms')
        sponsorshipEffect = 'CONSUMED'
      } else if (!outcome.applied && outcome.sponsorship_id) {
        const released = await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity=sponsorship.reserved_quantity-reservation.quantity,
             updated_at=clock_timestamp()
           FROM hosted_sponsorship_reservations AS reservation
           WHERE reservation.job_id=$1 AND reservation.status='RESERVED'
             AND reservation.sponsorship_id=$2
             AND sponsorship.sponsorship_id=reservation.sponsorship_id
             AND sponsorship.beneficiary_tenant_id=$3 AND sponsorship.sponsor_tenant_id=$4
             AND sponsorship.unit=reservation.unit AND reservation.unit=$5
             AND sponsorship.allocation_id IS NOT DISTINCT FROM reservation.allocation_id
             AND reservation.allocation_id IS NOT DISTINCT FROM $6::text`,
          [
            outcome.job_id,outcome.sponsorship_id,outcome.tenant_id,outcome.payer_tenant_id,
            outcome.billable_unit,outcome.allocation_id,
          ],
        )
        if (released.rowCount !== 1) {
          const alreadyReleased = await client.query(
            `SELECT 1 FROM hosted_sponsorship_reservations
             WHERE job_id=$1 AND sponsorship_id=$2 AND status='RELEASED' FOR SHARE`,
            [outcome.job_id,outcome.sponsorship_id],
          )
          if (alreadyReleased.rowCount !== 1) {
            throw new Error('failed aggregate member lacks its durable sponsorship reservation')
          }
        }
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status='RELEASED',updated_at=clock_timestamp()
           WHERE job_id=$1 AND status='RESERVED'`,
          [outcome.job_id],
        )
        sponsorshipEffect = 'RELEASED'
      }

      if (outcome.applied) {
        const charge = await client.query<BillingLedgerRow>(
          `INSERT INTO hosted_billing_ledger(
             tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
             aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
             price_id,price_effective_from,sla_policy_id,sla_effective_from,
             source_fact_id,idempotency_key,metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CHARGE',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${BILLING_LEDGER_SELECT}`,
          [
            outcome.payer_tenant_id,outcome.tenant_id,outcome.sponsorship_id,
            outcome.allocation_id,outcome.job_id,outcome.room_id,outcome.aggregate_hash,
            outcome.member_index,outcome.billable_unit,outcome.billable_quantity,
            outcome.currency,amount,outcome.price_id,outcome.price_effective_from,
            outcome.sla_policy_id,outcome.sla_effective_from,outcome.fact_id,
            `aggregate:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}:${outcome.fact_id}:charge`,
            JSON.stringify({
              factKey: outcome.fact_key,
              blockNumber: outcome.block_number,
              blockHash: outcome.block_hash,
              batchIndex: outcome.batch_index,
              finality: 'INDEPENDENTLY_AGREED_ARCHIVE_FLOOR',
              resultDigest: outcome.result_digest,
              quoteAcceptedAt: outcome.quote_accepted_at,
              eventTime: outcome.event_time,
            }),
          ],
        )
        const chargeRow = charge.rows[0]
        if (!chargeRow) throw new Error('aggregate billing charge idempotency conflict')
        charged += 1

        if (outcome.allocation_id !== null && outcome.transaction_cost_wei !== null) {
          const appliedCount = BigInt(outcome.applied_member_count)
          const appliedRank = BigInt(outcome.applied_member_rank)
          const totalCost = BigInt(outcome.transaction_cost_wei)
          if (appliedCount < 1n || appliedRank >= appliedCount) {
            throw new Error('canonical aggregate outcome ranks are inconsistent')
          }
          const quotient = totalCost / appliedCount
          const remainder = totalCost % appliedCount
          const memberCost = quotient + (appliedRank < remainder ? 1n : 0n)
          if (memberCost > 0n) {
            const l1Charge = await client.query<{ entry_id: string }>(
              `INSERT INTO hosted_billing_ledger(
                 tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
                 aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
                 price_id,price_effective_from,sla_policy_id,sla_effective_from,
                 source_fact_id,reverses_entry_id,idempotency_key,metadata
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'L1_ALLOCATION_CHARGE',
                 'l1-transaction-wei',$9,'WEI',$9,NULL,NULL,NULL,NULL,$10,NULL,$11,$12::jsonb)
               ON CONFLICT (idempotency_key) DO NOTHING RETURNING entry_id::text`,
              [
                outcome.payer_tenant_id,outcome.tenant_id,outcome.sponsorship_id,
                outcome.allocation_id,outcome.job_id,outcome.room_id,outcome.aggregate_hash,
                outcome.member_index,memberCost.toString(),outcome.fact_id,
                `aggregate:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}:${outcome.fact_id}:l1-allocation`,
                JSON.stringify({
                  operationId: outcome.operation_id,
                  transactionHash: outcome.transaction_hash,
                  allocationFactId: outcome.allocation_fact_id,
                  allocationFactBlockHash: outcome.allocation_fact_block_hash,
                  gasUsed: outcome.gas_used,
                  effectiveGasPrice: outcome.effective_gas_price,
                  blobGasUsed: outcome.blob_gas_used,
                  blobGasPrice: outcome.blob_gas_price,
                  transactionCostWei: outcome.transaction_cost_wei,
                  allocationScheme: 'EQUAL_APPLIED_MEMBER_INTEGER_REMAINDER_BY_INDEX',
                  appliedMemberCount: outcome.applied_member_count,
                  appliedMemberRank: outcome.applied_member_rank,
                }),
              ],
            )
            if (l1Charge.rowCount !== 1) throw new Error('aggregate L1 allocation charge idempotency conflict')
          }
        }

        const policy = outcome.sla_policy_id ? await client.query<{
          maximum_queue_ms: string
          maximum_proof_ms: string
          credit_basis_points: number
          effective_from: string
        }>(
          `SELECT maximum_queue_ms::text,maximum_proof_ms::text,credit_basis_points,effective_from::text
           FROM hosted_sla_policies
           WHERE policy_id=$1 AND tenant_id=$2 AND service_class=$3 FOR SHARE`,
          [outcome.sla_policy_id,outcome.payer_tenant_id,outcome.service_class],
        ) : { rows: [] as Array<{ maximum_queue_ms: string;maximum_proof_ms: string;credit_basis_points: number;effective_from: string }> }
        const sla = policy.rows[0]
        if (sla && (outcome.actual_queue_ms === null || outcome.actual_proof_ms === null)) {
          throw new Error('SLA-bound aggregate member lacks complete durable timing evidence')
        }
        if (sla && canonicalTimestamp(sla.effective_from) !== canonicalTimestamp(outcome.sla_effective_from!)) {
          throw new Error('aggregate member SLA policy identity conflicts with its immutable quote')
        }
        const queueBreach = sla && BigInt(outcome.actual_queue_ms!) > BigInt(sla.maximum_queue_ms)
        const proofBreach = sla && BigInt(outcome.actual_proof_ms!) > BigInt(sla.maximum_proof_ms)
        if (sla && sla.credit_basis_points > 0 && (queueBreach || proofBreach)) {
          const credit = await client.query<{ quantity: string; amount: string | null }>(
            `SELECT
               (-$1::numeric * $2::numeric / 10000)::text AS quantity,
               CASE WHEN $3::numeric IS NULL THEN NULL
                    ELSE (-$3::numeric * $2::numeric / 10000)::text END AS amount`,
            [outcome.billable_quantity, sla.credit_basis_points, amount],
          )
          await client.query(
            `INSERT INTO hosted_billing_ledger(
               tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
               aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
               price_id,price_effective_from,sla_policy_id,sla_effective_from,
               source_fact_id,reverses_entry_id,idempotency_key,metadata
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SLA_CREDIT',$9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20::jsonb)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [
              outcome.payer_tenant_id,outcome.tenant_id,outcome.sponsorship_id,
              outcome.allocation_id,outcome.job_id,outcome.room_id,outcome.aggregate_hash,
              outcome.member_index,outcome.billable_unit,credit.rows[0]!.quantity,
              outcome.currency,credit.rows[0]!.amount,outcome.price_id,outcome.price_effective_from,
              outcome.sla_policy_id,outcome.sla_effective_from,outcome.fact_id,chargeRow.entry_id,
              `aggregate:${chainId}:${outcome.aggregate_hash}:${outcome.member_index}:${outcome.fact_id}:sla`,
              JSON.stringify({
                serviceClass: outcome.service_class,
                maximumQueueMs: sla.maximum_queue_ms,
                maximumProofMs: sla.maximum_proof_ms,
                actualQueueMs: outcome.actual_queue_ms,
                actualProofMs: outcome.actual_proof_ms,
                creditBasisPoints: sla.credit_basis_points,
                queueBreach: Boolean(queueBreach),
                proofBreach: Boolean(proofBreach),
              }),
            ],
          )
        }
      } else {
        retryable += 1
      }
      const receipt = await client.query(
        `INSERT INTO hosted_aggregate_outcome_receipts(
           chain_id,aggregate_hash,member_index,source_fact_id,applied,
           failure_selector,sponsorship_effect
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (source_fact_id) DO NOTHING RETURNING receipt_id::text`,
        [
          chainId, outcome.aggregate_hash, outcome.member_index, outcome.fact_id,
          outcome.applied, outcome.failure_selector, sponsorshipEffect,
        ],
      )
      if (receipt.rowCount !== 1) throw new Error('aggregate outcome receipt idempotency conflict')
      await this.outbox(client, outcome.payer_tenant_id, 'billing.aggregate-member-finalized',
        `${chainId}:${outcome.aggregate_hash}:${outcome.member_index}`, {
          aggregateHash: outcome.aggregate_hash,
          memberIndex: outcome.member_index,
          roomId: outcome.room_id,
          batchIndex: outcome.batch_index,
          applied: outcome.applied,
          failureSelector: outcome.failure_selector,
          billingState: outcome.applied ? 'CHARGED' : 'UNCHARGED_RETRYABLE',
        })
    }

    const retracted = await client.query<{
      receipt_id: string
      applied: boolean
      sponsorship_effect: 'NONE' | 'CONSUMED' | 'RELEASED'
      entry_id: string | null
      tenant_id: string
      beneficiary_tenant_id: string
      allocation_id: string | null
      job_id: string
      room_id: string
      aggregate_hash: `0x${string}`
      member_index: number
      unit: string
      source_fact_id: string
      sponsorship_id: string | null
      reservation_quantity: string | null
      price_id: string | null
      price_effective_from: string | null
      sla_policy_id: string | null
      sla_effective_from: string | null
      net_quantity: string
      currency: string | null
      net_amount: string | null
    }>(
      `SELECT receipt.receipt_id::text,receipt.applied,receipt.sponsorship_effect,
              charge.entry_id::text,member.payer_tenant_id AS tenant_id,
              member.tenant_id AS beneficiary_tenant_id,member.allocation_id,
              member.job_id,member.room_id::text,member.aggregate_hash,member.member_index,
              member.billable_unit AS unit,receipt.source_fact_id::text,member.sponsorship_id,
              reservation.quantity::text AS reservation_quantity,
              charge.price_id::text,charge.price_effective_from::text,
              charge.sla_policy_id::text,charge.sla_effective_from::text,
              COALESCE((charge.quantity + adjustment.quantity)::text,'0') AS net_quantity,
              charge.currency,
              CASE WHEN charge.amount IS NULL THEN NULL
                   ELSE (charge.amount + adjustment.amount)::text END AS net_amount
       FROM hosted_aggregate_outcome_receipts AS receipt
       JOIN hosted_indexer_facts AS fact ON fact.fact_id=receipt.source_fact_id
       JOIN hosted_aggregate_billing_members AS member
         ON member.chain_id=receipt.chain_id AND member.aggregate_hash=receipt.aggregate_hash
        AND member.member_index=receipt.member_index
       LEFT JOIN hosted_indexer_facts AS allocation_fact
         ON allocation_fact.fact_id=member.allocation_fact_id
       LEFT JOIN hosted_aggregate_outcome_retractions AS processed ON processed.receipt_id=receipt.receipt_id
       LEFT JOIN hosted_sponsorship_reservations AS reservation ON reservation.job_id=member.job_id
       LEFT JOIN hosted_billing_ledger AS charge
         ON charge.source_fact_id=receipt.source_fact_id AND charge.entry_kind='CHARGE'
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(entry.quantity),0) AS quantity,COALESCE(sum(entry.amount),0) AS amount
         FROM hosted_billing_ledger AS entry
         WHERE entry.reverses_entry_id=charge.entry_id
           AND entry.entry_kind IN ('SLA_CREDIT','REFUND')
       ) AS adjustment ON true
       WHERE receipt.chain_id=$1 AND processed.retraction_id IS NULL
         AND (NOT fact.canonical OR (member.allocation_id IS NOT NULL AND NOT allocation_fact.canonical))
       ORDER BY receipt.receipt_id FOR UPDATE OF receipt`,
      [chainId],
    )
    let corrected = 0
    for (const row of retracted.rows) {
      let correctionEntryId: string | null = null
      if (row.entry_id && Number(row.net_quantity) > 0) {
        const correction = await client.query<{ entry_id: string }>(
          `INSERT INTO hosted_billing_ledger(
             tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
             aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
             price_id,price_effective_from,sla_policy_id,sla_effective_from,
             source_fact_id,reverses_entry_id,idempotency_key,metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REORG_CREDIT',$9,-$10::numeric,$11,
             CASE WHEN $12::numeric IS NULL THEN NULL ELSE -$12::numeric END,
             $13,$14,$15,$16,$17,$18,$19,$20::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING entry_id::text`,
          [
            row.tenant_id,row.beneficiary_tenant_id,row.sponsorship_id,row.allocation_id,
            row.job_id,row.room_id,row.aggregate_hash,row.member_index,row.unit,row.net_quantity,
            row.currency,row.net_amount,row.price_id,row.price_effective_from,row.sla_policy_id,
            row.sla_effective_from,row.source_fact_id,row.entry_id,
            `billing:${row.entry_id}:reorg-credit`,
            JSON.stringify({ reason: 'CANONICAL_AGGREGATE_OUTCOME_RETRACTED' }),
          ],
        )
        if (correction.rowCount !== 1) throw new Error('aggregate reorg correction idempotency conflict')
        correctionEntryId = correction.rows[0]!.entry_id
      }
      const l1Charge = await client.query<{
        entry_id: string
        tenant_id: string
        beneficiary_tenant_id: string | null
        sponsorship_id: string | null
        allocation_id: string | null
        job_id: string | null
        room_id: string | null
        aggregate_hash: `0x${string}` | null
        member_index: number | null
        unit: string
        quantity: string
        currency: string
        amount: string
      }>(
        `SELECT entry_id::text,tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,
                job_id,room_id::text,aggregate_hash,member_index,unit,quantity::text,
                currency,amount::text
         FROM hosted_billing_ledger
         WHERE source_fact_id=$1 AND entry_kind='L1_ALLOCATION_CHARGE' FOR SHARE`,
        [row.source_fact_id],
      )
      if (l1Charge.rowCount === 1) {
        const l1 = l1Charge.rows[0]!
        const reversed = await client.query(
          `INSERT INTO hosted_billing_ledger(
             tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
             aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
             price_id,price_effective_from,sla_policy_id,sla_effective_from,
             source_fact_id,reverses_entry_id,idempotency_key,metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REORG_CREDIT',$9,-$10::numeric,
             $11,-$12::numeric,NULL,NULL,NULL,NULL,$13,$14,$15,$16::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING entry_id::text`,
          [
            l1.tenant_id,l1.beneficiary_tenant_id,l1.sponsorship_id,l1.allocation_id,
            l1.job_id,l1.room_id,l1.aggregate_hash,l1.member_index,l1.unit,l1.quantity,
            l1.currency,l1.amount,row.source_fact_id,l1.entry_id,
            `billing:${l1.entry_id}:reorg-credit`,
            JSON.stringify({ reason: 'CANONICAL_AGGREGATE_ALLOCATION_OUTCOME_RETRACTED' }),
          ],
        )
        if (reversed.rowCount !== 1) throw new Error('aggregate L1 allocation reorg correction idempotency conflict')
      } else if (l1Charge.rowCount !== 0) {
        throw new Error('aggregate member has multiple L1 allocation charges')
      }
      if (row.sponsorship_id && row.reservation_quantity && row.sponsorship_effect === 'CONSUMED') {
        const restored = await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             consumed_quantity=sponsorship.consumed_quantity-reservation.quantity,
             reserved_quantity=sponsorship.reserved_quantity+reservation.quantity,
             updated_at=clock_timestamp()
           FROM hosted_sponsorship_reservations AS reservation
           WHERE reservation.job_id=$1 AND reservation.status='CONSUMED'
             AND sponsorship.sponsorship_id=reservation.sponsorship_id
             AND sponsorship.sponsorship_id=$2 AND sponsorship.consumed_quantity >= reservation.quantity`,
          [row.job_id, row.sponsorship_id],
        )
        if (restored.rowCount !== 1) throw new Error('retracted member sponsorship charge cannot be restored')
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status='RESERVED',updated_at=clock_timestamp()
           WHERE job_id=$1 AND status='CONSUMED'`, [row.job_id],
        )
        await client.query(
          `INSERT INTO hosted_refunds(
             tenant_id,sponsorship_id,billing_entry_id,quantity,unit,reason,idempotency_key,status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'SUCCEEDED')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
             row.tenant_id, row.sponsorship_id, correctionEntryId,
            row.reservation_quantity, row.unit,
            'canonical aggregate member outcome was retracted',
            `billing:${row.entry_id}:sponsorship-reorg-refund`,
          ],
        )
        const exactRefund = await client.query<{ tenant_id: string;sponsorship_id: string;quantity: string }>(
          `SELECT tenant_id,sponsorship_id,quantity::text FROM hosted_refunds
           WHERE idempotency_key=$1 FOR SHARE`, [`billing:${row.entry_id}:sponsorship-reorg-refund`],
        )
        if (
          exactRefund.rows[0]?.tenant_id !== row.tenant_id
          || exactRefund.rows[0]?.sponsorship_id !== row.sponsorship_id
          || canonicalDecimal(exactRefund.rows[0]?.quantity ?? '-1') !== canonicalDecimal(row.reservation_quantity)
        ) throw new Error('sponsorship reorg refund idempotency key conflicts with immutable terms')
      } else if (row.sponsorship_id && row.reservation_quantity && row.sponsorship_effect === 'RELEASED') {
        const deferredAggregateId = `${chainId}:${row.aggregate_hash}:${row.member_index}`
        const retry = await client.query<{ job_id: string }>(
          `SELECT retry.job_id
           FROM hosted_prove_jobs AS retry
           JOIN hosted_sponsorship_reservations AS retry_reservation
             ON retry_reservation.job_id=retry.job_id
           WHERE retry.retry_of_job_id=$1
             AND retry.tenant_id=$2
             AND retry.room_id=$3::numeric
             AND retry.allocation_id IS NOT DISTINCT FROM $4::text
             AND retry.sponsorship_id=$5
             AND retry_reservation.sponsorship_id=$5
             AND retry_reservation.tenant_id=$2
             AND retry_reservation.allocation_id IS NOT DISTINCT FROM $4::text
             AND retry_reservation.unit=$6
             AND retry_reservation.quantity=$7::numeric
             AND retry_reservation.status IN ('RESERVED','CONSUMED')
           FOR UPDATE OF retry,retry_reservation`,
          [
            row.job_id,row.beneficiary_tenant_id,row.room_id,row.allocation_id,
            row.sponsorship_id,row.unit,row.reservation_quantity,
          ],
        )
        if (retry.rowCount === 1) {
          const transferred = await client.query(
            `UPDATE hosted_sponsorship_reservations SET
               status='TRANSFERRED',transferred_to_job_id=$2,updated_at=clock_timestamp()
             WHERE job_id=$1 AND status='RELEASED' AND transferred_to_job_id IS NULL`,
            [row.job_id,retry.rows[0]!.job_id],
          )
          if (transferred.rowCount !== 1) {
            throw new Error('failed-member sponsorship retry transfer lost its immutable source')
          }
          await this.outbox(client,row.tenant_id,'billing.sponsorship-effect-transferred',
            deferredAggregateId,{
              aggregateHash: row.aggregate_hash,memberIndex: row.member_index,
              failedJobId: row.job_id,retryJobId: retry.rows[0]!.job_id,
              sponsorshipId: row.sponsorship_id,quantity: row.reservation_quantity,unit: row.unit,
            })
          await client.query(
            `UPDATE hosted_outbox SET resolved_at=COALESCE(resolved_at,clock_timestamp())
             WHERE topic='billing.aggregate-member-retraction-deferred'
               AND aggregate_id=$1 AND resolved_at IS NULL`, [deferredAggregateId],
          )
        } else if (retry.rowCount !== 0) {
          throw new Error('failed member has multiple sponsorship retry effects')
        } else {
          const restored = await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity=sponsorship.reserved_quantity+reservation.quantity,
             updated_at=clock_timestamp()
           FROM hosted_sponsorship_reservations AS reservation
           WHERE reservation.job_id=$1 AND reservation.status='RELEASED'
             AND sponsorship.sponsorship_id=reservation.sponsorship_id
             AND sponsorship.sponsorship_id=$2
             AND sponsorship.consumed_quantity+sponsorship.reserved_quantity+reservation.quantity
                 <= sponsorship.maximum_quantity`, [row.job_id,row.sponsorship_id],
        )
          if (restored.rowCount === 1) {
            await client.query(
              `UPDATE hosted_sponsorship_reservations SET status='RESERVED',updated_at=clock_timestamp()
               WHERE job_id=$1 AND status='RELEASED'`, [row.job_id],
            )
            await client.query(
              `UPDATE hosted_outbox SET resolved_at=COALESCE(resolved_at,clock_timestamp())
               WHERE topic='billing.aggregate-member-retraction-deferred'
                 AND aggregate_id=$1 AND resolved_at IS NULL`, [deferredAggregateId],
            )
          } else {
            // Unlinked later work may occupy the released capacity. Do not
            // mark the retraction processed: only an explicit retryOfJobId
            // can authorize automatic commercial-effect transfer.
            await client.query(
              `INSERT INTO hosted_outbox(
                 tenant_id,audience,topic,aggregate_id,payload,retention_class
               ) SELECT $1,'tenant','billing.aggregate-member-retraction-deferred',$2,$3::jsonb,'safety'
               WHERE NOT EXISTS (
                 SELECT 1 FROM hosted_outbox
                 WHERE topic='billing.aggregate-member-retraction-deferred'
                   AND aggregate_id=$2 AND resolved_at IS NULL
               )`,
              [row.tenant_id,deferredAggregateId,JSON.stringify({
                aggregateHash: row.aggregate_hash,
                memberIndex: row.member_index,
                jobId: row.job_id,
                sponsorshipId: row.sponsorship_id,
                reason: 'SPONSORSHIP_CAPACITY_OCCUPIED_BY_UNLINKED_LATER_WORK',
                resolution: 'submit an exact retry link, release capacity, or increase sponsor capacity; then rerun fenced billing reconciliation',
              })],
            )
            continue
          }
        }
      }
      await client.query(
        `INSERT INTO hosted_aggregate_outcome_retractions(
           receipt_id,source_fact_id,correction_entry_id,reason
         ) VALUES ($1,$2,$3,'CANONICAL_AGGREGATE_OUTCOME_RETRACTED')`,
        [row.receipt_id,row.source_fact_id,correctionEntryId],
      )
      await this.outbox(client, row.tenant_id, 'billing.aggregate-member-retracted',
        `${chainId}:${row.aggregate_hash}:${row.member_index}`, {
          previousState: {
            aggregateHash: row.aggregate_hash,
            memberIndex: row.member_index,
            billingEntryId: row.entry_id,
            billingState: row.applied ? 'CHARGED' : 'UNCHARGED_RETRYABLE',
          },
          reason: { code: 'CANONICAL_AGGREGATE_OUTCOME_RETRACTED' },
          correctionEntryId,
        })
      corrected += 1
    }
    return { charged, retryable, corrected }
  }

  async registerAggregateBillingManifest(
    fence: CoordinatorFence,
    input: {
      chainId: number
      aggregateHash: `0x${string}`
      operationId: string
      idempotencyKey: string
      members: AggregateBillingMember[]
    },
  ): Promise<{ created: boolean; charged: number; retryable: number; corrected: number }> {
    if (!/^0x[0-9a-f]{64}$/.test(input.aggregateHash)) throw new Error('aggregateHash must be lowercase 32-byte hex')
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.operationId)) throw new Error('aggregate L1 operation id is invalid')
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new Error('invalid aggregate manifest idempotency key')
    if (input.members.length < 1 || input.members.length > 8) throw new Error('aggregate manifest must contain 1 through 8 members')
    const members = [...input.members].sort((left, right) => left.memberIndex - right.memberIndex)
    for (const [index, member] of members.entries()) {
      if (member.memberIndex !== index) throw new Error('aggregate member indices must be unique and contiguous from zero')
      if (!/^pj-[0-9a-f]{10,64}$/.test(member.jobId)) throw new Error('aggregate member job id is invalid')
      if (!/^\d+$/.test(member.roomId) || !/^\d+$/.test(member.batchIndex)) {
        throw new Error('aggregate member room and batch ids must be unsigned decimals')
      }
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const operation = await client.query<HostedL1TransactionRow>(
        `SELECT ${HOSTED_L1_TRANSACTION_SELECT} FROM hosted_l1_transactions
         WHERE operation_id=$1 FOR UPDATE`, [input.operationId],
      )
      const l1 = operation.rows[0]
      if (
        !l1 || Number(l1.chain_id) !== input.chainId || l1.operation !== 'publish-aggregate'
        || l1.status !== 'SIGNED' || !l1.transaction_hash || !l1.destination_address
      ) throw new Error('aggregate manifest requires its exact signed, not-yet-broadcast durable L1 operation')
      if (!this.aggregateAbi) throw new Error('aggregate ABI is required to verify publish-aggregate calldata')
      const calldataMembers = decodedAggregateMemberKeys(this.aggregateAbi, l1.calldata)
      if (
        calldataMembers.length !== members.length
        || calldataMembers.some((member, index) => (
          member.roomId !== members[index]!.roomId
          || member.batchIndex !== members[index]!.batchIndex
        ))
      ) throw new Error('aggregate billing members conflict with decoded submitAggregate calldata')

      type BoundJob = {
        tenant_id: string; room_id: string | null; allocation_id: string | null
        allocation_fact_id: string | null; allocation_fact_block_hash: string | null
        sponsorship_id: string | null; estimated_work: string; status: string
        result_object_key: string | null; result_digest: string | null
        payer_tenant_id: string | null; quote_price_id: string | null
        quote_unit_price: string | null; quote_currency: string | null
        quote_effective_from: string | null; quote_accepted_at: string | null
        maximum_charge_amount: string | null; maximum_charge_currency: string | null
        quote_sla_policy_id: string | null; quote_sla_effective_from: string | null
      }
      const boundJobs: BoundJob[] = []
      for (const member of members) {
        const job = await client.query<BoundJob>(
          `SELECT tenant_id,room_id::text,allocation_id,sponsorship_id,
                  estimated_work::text,status,result_object_key,result_digest,payer_tenant_id,
                  quote_price_id::text,quote_unit_price::text,quote_currency,
                  quote_effective_from::text,quote_accepted_at::text,
                  maximum_charge_amount::text,maximum_charge_currency,
                  quote_sla_policy_id::text,quote_sla_effective_from::text
           FROM hosted_prove_jobs WHERE job_id=$1 FOR SHARE`, [member.jobId],
        )
        const row = job.rows[0]
        if (!row || row.status !== 'DONE') throw new Error('aggregate billing member requires a completed durable proof job')
        if (row.room_id !== member.roomId) throw new Error('aggregate billing member room conflicts with its proof job')
        if (
          !row.result_object_key || !row.result_digest || !row.payer_tenant_id
          || !row.quote_price_id || !row.quote_unit_price || !row.quote_currency
          || !row.quote_effective_from || !row.quote_accepted_at
          || !row.maximum_charge_amount || !row.maximum_charge_currency
        ) throw new Error('aggregate billing member requires an immutable accepted quote and result digest')
        if (row.allocation_id !== null) {
          const allocation = await client.query<{
            fact_id: string
            block_hash: string
            allocation_id: string | null
          }>(
            `SELECT fact_id::text,block_hash,
                    lower(COALESCE(payload #>> '{args,allocationId}',payload #>> '{args,newAllocationId}')) AS allocation_id
             FROM hosted_indexer_facts
             WHERE chain_id=$1 AND canonical
               AND payload #>> '{provenance,eventName}' IN ('AllocationUsed','AllocationRenewed')
               AND payload #>> '{args,roomId}'=$2
             ORDER BY block_number DESC,fact_id DESC LIMIT 1 FOR SHARE`,
            [input.chainId,member.roomId],
          )
          const binding = allocation.rows[0]
          if (!binding || binding.allocation_id !== row.allocation_id.toLowerCase()) {
            throw new Error('aggregate billing member allocation is not the latest canonical room allocation')
          }
          row.allocation_fact_id = binding.fact_id
          row.allocation_fact_block_hash = binding.block_hash
        } else {
          row.allocation_fact_id = null
          row.allocation_fact_block_hash = null
        }
        boundJobs.push(row)
      }
      const expectedRequestHash = aggregateBillingRequestHash({
        chainId: input.chainId,
        aggregateHash: input.aggregateHash,
        destinationAddress: l1.destination_address,
        calldata: l1.calldata,
        members: members.map((member, index) => ({
          ...member,
          resultObjectKey: boundJobs[index]!.result_object_key!,
          resultDigest: boundJobs[index]!.result_digest!,
        })),
      })
      if (
        l1.request_hash !== expectedRequestHash
        || !l1.request_object_key.toLowerCase().endsWith(expectedRequestHash)
      ) throw new Error('aggregate L1 request object is not bound to calldata, members, and proof-result digests')
      const calldataHash = createHash('sha256').update(l1.calldata).digest('hex')
      const inserted = await client.query(
        `INSERT INTO hosted_aggregate_billing_manifests(
           chain_id,aggregate_hash,operation_id,transaction_hash,destination_address,
           request_hash,calldata_hash,idempotency_key,member_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [
          input.chainId,input.aggregateHash,l1.operation_id,l1.transaction_hash,
          l1.destination_address,l1.request_hash,calldataHash,input.idempotencyKey,members.length,
        ],
      )
      const manifest = await client.query<{
        chain_id: string; aggregate_hash: string; operation_id: string; transaction_hash: string
        destination_address: string; request_hash: string; calldata_hash: string
        idempotency_key: string; member_count: number
      }>(
        `SELECT chain_id::text,aggregate_hash,operation_id,transaction_hash,destination_address,
                request_hash,calldata_hash,idempotency_key,member_count
         FROM hosted_aggregate_billing_manifests
         WHERE (chain_id=$1 AND aggregate_hash=$2) OR operation_id=$3 OR idempotency_key=$4 FOR SHARE`,
        [input.chainId, input.aggregateHash,input.operationId,input.idempotencyKey],
      )
      if (
        manifest.rows.length !== 1 || Number(manifest.rows[0]!.chain_id) !== input.chainId
        || manifest.rows[0]!.aggregate_hash !== input.aggregateHash
        || manifest.rows[0]!.operation_id !== input.operationId
        || manifest.rows[0]!.transaction_hash !== l1.transaction_hash
        || manifest.rows[0]!.destination_address !== l1.destination_address
        || manifest.rows[0]!.request_hash !== l1.request_hash
        || manifest.rows[0]!.calldata_hash !== calldataHash
        || manifest.rows[0]!.idempotency_key !== input.idempotencyKey
        || manifest.rows[0]!.member_count !== members.length
      ) throw new Error('aggregate billing manifest identity or idempotency key conflicts')
      for (const [index, member] of members.entries()) {
        const row = boundJobs[index]!
        await client.query(
          `INSERT INTO hosted_aggregate_billing_members(
             chain_id,aggregate_hash,member_index,job_id,tenant_id,room_id,batch_index,
             allocation_id,allocation_fact_id,allocation_fact_block_hash,
             sponsorship_id,result_object_key,result_digest,billable_unit,billable_quantity,
             payer_tenant_id,price_id,unit_price,currency,price_effective_from,quote_accepted_at,
             maximum_charge_amount,maximum_charge_currency,sla_policy_id,sla_effective_from
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'proof-work',$14,
             $15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (chain_id,aggregate_hash,member_index) DO NOTHING`,
          [
            input.chainId, input.aggregateHash, member.memberIndex, member.jobId,
            row.tenant_id, member.roomId, member.batchIndex, row.allocation_id,
            row.allocation_fact_id,row.allocation_fact_block_hash,
            row.sponsorship_id,row.result_object_key,row.result_digest,row.estimated_work,
            row.payer_tenant_id,row.quote_price_id,row.quote_unit_price,row.quote_currency,
            row.quote_effective_from,row.quote_accepted_at,row.maximum_charge_amount,
            row.maximum_charge_currency,row.quote_sla_policy_id,row.quote_sla_effective_from,
          ],
        )
        const exact = await client.query<{
          job_id: string; tenant_id: string; room_id: string; batch_index: string
          allocation_id: string | null; allocation_fact_id: string | null
          allocation_fact_block_hash: string | null; sponsorship_id: string | null; billable_quantity: string
          result_digest: string; payer_tenant_id: string;price_id: string;unit_price: string
          currency: string;maximum_charge_amount: string;maximum_charge_currency: string
        }>(
          `SELECT job_id,tenant_id,room_id::text,batch_index::text,allocation_id,
                  allocation_fact_id::text,allocation_fact_block_hash,
                  sponsorship_id,billable_quantity::text,result_digest,payer_tenant_id,
                  price_id::text,unit_price::text,currency,maximum_charge_amount::text,
                  maximum_charge_currency
           FROM hosted_aggregate_billing_members
           WHERE chain_id=$1 AND aggregate_hash=$2 AND member_index=$3`,
          [input.chainId, input.aggregateHash, member.memberIndex],
        )
        const bound = exact.rows[0]
        if (
          !bound || bound.job_id !== member.jobId || bound.tenant_id !== row.tenant_id
          || bound.room_id !== member.roomId || bound.batch_index !== member.batchIndex
          || bound.allocation_id !== row.allocation_id || bound.sponsorship_id !== row.sponsorship_id
          || bound.allocation_fact_id !== row.allocation_fact_id
          || bound.allocation_fact_block_hash !== row.allocation_fact_block_hash
          || canonicalDecimal(bound.billable_quantity) !== canonicalDecimal(row.estimated_work)
          || bound.result_digest !== row.result_digest || bound.payer_tenant_id !== row.payer_tenant_id
          || bound.price_id !== row.quote_price_id
          || canonicalDecimal(bound.unit_price) !== canonicalDecimal(row.quote_unit_price!)
          || bound.currency !== row.quote_currency
          || canonicalDecimal(bound.maximum_charge_amount) !== canonicalDecimal(row.maximum_charge_amount!)
          || bound.maximum_charge_currency !== row.maximum_charge_currency
        ) throw new Error('aggregate billing member conflicts with immutable manifest binding')
      }
      const result = await this.reconcileAggregateBillingTx(client, input.chainId)
      if (inserted.rowCount === 1) {
        await this.outbox(client, null, 'billing.aggregate-manifest-registered', input.aggregateHash, {
          chainId: input.chainId, aggregateHash: input.aggregateHash, members: members.length,
        }, 'admin-internal')
      }
      return { created: inserted.rowCount === 1, ...result }
    })
  }

  async reconcileAggregateBilling(
    fence: CoordinatorFence,
    chainId: number,
  ): Promise<{ charged: number; retryable: number; corrected: number }> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      return this.reconcileAggregateBillingTx(client, chainId)
    })
  }

  async publishBillingPrice(fence: CoordinatorFence, input: {
    tenantId: string
    unit: string
    currency: string
    unitPrice: string
    effectiveFrom: string
    idempotencyKey: string
  }): Promise<{ created: boolean }> {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('billing currency must be three uppercase letters')
    if (Number(input.unitPrice) < 0 || !/^\d+(?:\.\d{1,18})?$/.test(input.unitPrice)) throw new Error('unitPrice must be a non-negative decimal')
    if (!Number.isFinite(Date.parse(input.effectiveFrom))) throw new Error('effectiveFrom must be an ISO timestamp')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const inserted = await client.query(
        `INSERT INTO hosted_billing_prices(
           tenant_id,unit,currency,unit_price,effective_from,idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [input.tenantId, input.unit, input.currency, input.unitPrice, input.effectiveFrom, input.idempotencyKey],
      )
      const replay = await client.query<{
        tenant_id: string; unit: string; currency: string; unit_price: string; effective_from: string | Date
      }>(
        `SELECT tenant_id,unit,currency,unit_price::text,effective_from
         FROM hosted_billing_prices WHERE idempotency_key=$1`, [input.idempotencyKey],
      )
      const row = replay.rows[0]
      if (
        !row || row.tenant_id !== input.tenantId || row.unit !== input.unit
        || row.currency !== input.currency
        || canonicalDecimal(row.unit_price) !== canonicalDecimal(input.unitPrice)
        || canonicalTimestamp(row.effective_from) !== canonicalTimestamp(input.effectiveFrom)
      ) throw new Error('billing price idempotency key is bound to different terms')
      return { created: inserted.rowCount === 1 }
    })
  }

  async publishSlaPolicy(fence: CoordinatorFence, input: {
    tenantId: string
    serviceClass: HostedProveJob['serviceClass']
    maximumQueueMs: number
    maximumProofMs: number
    creditBasisPoints: number
    effectiveFrom: string
    idempotencyKey: string
  }): Promise<{ created: boolean }> {
    if (!Number.isSafeInteger(input.maximumQueueMs) || input.maximumQueueMs < 0) throw new Error('maximumQueueMs must be non-negative')
    if (!Number.isSafeInteger(input.maximumProofMs) || input.maximumProofMs < 0) throw new Error('maximumProofMs must be non-negative')
    if (!Number.isSafeInteger(input.creditBasisPoints) || input.creditBasisPoints < 0 || input.creditBasisPoints > 9_999) {
      throw new Error('creditBasisPoints must be from 0 through 9999')
    }
    if (!Number.isFinite(Date.parse(input.effectiveFrom))) throw new Error('effectiveFrom must be an ISO timestamp')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const inserted = await client.query(
        `INSERT INTO hosted_sla_policies(
           tenant_id,service_class,maximum_queue_ms,maximum_proof_ms,
           credit_basis_points,effective_from,idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          input.tenantId, input.serviceClass, input.maximumQueueMs, input.maximumProofMs,
          input.creditBasisPoints, input.effectiveFrom, input.idempotencyKey,
        ],
      )
      const replay = await client.query<{
        tenant_id: string; service_class: string; maximum_queue_ms: string
        maximum_proof_ms: string; credit_basis_points: number; effective_from: string | Date
      }>(
        `SELECT tenant_id,service_class,maximum_queue_ms::text,maximum_proof_ms::text,
                credit_basis_points,effective_from
         FROM hosted_sla_policies WHERE idempotency_key=$1`, [input.idempotencyKey],
      )
      const row = replay.rows[0]
      if (
        !row || row.tenant_id !== input.tenantId || row.service_class !== input.serviceClass
        || row.maximum_queue_ms !== String(input.maximumQueueMs)
        || row.maximum_proof_ms !== String(input.maximumProofMs)
        || row.credit_basis_points !== input.creditBasisPoints
        || canonicalTimestamp(row.effective_from) !== canonicalTimestamp(input.effectiveFrom)
      ) throw new Error('SLA policy idempotency key is bound to different terms')
      return { created: inserted.rowCount === 1 }
    })
  }

  async listBillingLedger(tenantId: string, afterEntryId = '0', limit = 500): Promise<BillingLedgerEntry[]> {
    const result = await this.pool.query<BillingLedgerRow>(
      `SELECT ${BILLING_LEDGER_SELECT} FROM hosted_billing_ledger
       WHERE tenant_id=$1 AND entry_id>$2
       ORDER BY entry_id LIMIT $3`,
      [tenantId, afterEntryId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map(billingLedgerEntry)
  }

  async createInvoiceExport(fence: CoordinatorFence, input: {
    invoiceId: string
    supersedesInvoiceId?: string | null
    tenantId: string
    periodStart: string
    periodEnd: string
    currency: string
    idempotencyKey: string
  }): Promise<{ invoice: BillingInvoice; created: boolean }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.invoiceId)) throw new Error('invoiceId is invalid')
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('invoice currency must be three uppercase letters')
    const start = Date.parse(input.periodStart)
    const end = Date.parse(input.periodEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invoice period is invalid')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`billing-invoice:${input.tenantId}:${input.currency}`],
      )
      // SHARE conflicts with ledger INSERT's ROW EXCLUSIVE lock. It waits for
      // all earlier entries and freezes the immutable cutoff until commit.
      await client.query('LOCK TABLE hosted_billing_ledger IN SHARE MODE')
      const replay = await client.query<{
        invoice_id: string; supersedes_invoice_id: string | null
        tenant_id: string; period_start: string | Date; period_end: string | Date
        currency: string; ledger_high_water: string; net_amount: string
        line_items: BillingInvoice['lineItems']; created_at: string
      }>(
        `SELECT invoice_id,supersedes_invoice_id,tenant_id,period_start,period_end,currency,
                ledger_high_water::text,net_amount::text,line_items,created_at::text
         FROM hosted_invoice_exports WHERE invoice_id=$1 OR idempotency_key=$2 FOR SHARE`,
        [input.invoiceId, input.idempotencyKey],
      )
      if (replay.rows.length > 0) {
        const row = replay.rows[0]!
        if (
          replay.rows.length !== 1 || row.invoice_id !== input.invoiceId || row.tenant_id !== input.tenantId
          || row.supersedes_invoice_id !== (input.supersedesInvoiceId ?? null)
          || canonicalTimestamp(row.period_start) !== canonicalTimestamp(input.periodStart)
          || canonicalTimestamp(row.period_end) !== canonicalTimestamp(input.periodEnd)
          || row.currency !== input.currency
        ) throw new Error('invoice id or idempotency key is bound to another export')
        return { invoice: {
          invoiceId: row.invoice_id,supersedesInvoiceId: row.supersedes_invoice_id,tenantId: row.tenant_id,
          periodStart: canonicalTimestamp(row.period_start), periodEnd: canonicalTimestamp(row.period_end),
          currency: row.currency, ledgerHighWater: row.ledger_high_water,
          netAmount: row.net_amount, lineItems: row.line_items, createdAt: row.created_at,
        }, created: false }
      }
      const supersedesInvoiceId = input.supersedesInvoiceId ?? null
      if (supersedesInvoiceId) {
        const prior = await client.query<{
          tenant_id: string;period_start: string | Date;period_end: string | Date;currency: string
        }>(
          `SELECT tenant_id,period_start,period_end,currency FROM hosted_invoice_exports
           WHERE invoice_id=$1 FOR SHARE`, [supersedesInvoiceId],
        )
        const old = prior.rows[0]
        if (
          !old || old.tenant_id !== input.tenantId || old.currency !== input.currency
          || canonicalTimestamp(old.period_start) !== canonicalTimestamp(input.periodStart)
          || canonicalTimestamp(old.period_end) !== canonicalTimestamp(input.periodEnd)
        ) throw new Error('superseded invoice must have the exact same tenant, period, and currency')
        const child = await client.query(
          `SELECT 1 FROM hosted_invoice_exports WHERE supersedes_invoice_id=$1 FOR SHARE`, [supersedesInvoiceId],
        )
        if (child.rowCount !== 0) throw new Error('invoice already has an immutable correction revision')
      } else {
        const overlap = await client.query(
          `SELECT 1 FROM hosted_invoice_exports
           WHERE tenant_id=$1 AND currency=$2 AND supersedes_invoice_id IS NULL
             AND period_start < $4 AND period_end > $3 LIMIT 1 FOR SHARE`,
          [input.tenantId,input.currency,input.periodStart,input.periodEnd],
        )
        if (overlap.rowCount !== 0) throw new Error('invoice period overlaps an already closed period')
      }
      const highWaterResult = await client.query<{ high_water: string }>(
        `SELECT COALESCE(max(entry_id),0)::text AS high_water FROM hosted_billing_ledger
         WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,
        [input.tenantId, input.periodStart, input.periodEnd],
      )
      const highWater = highWaterResult.rows[0]!.high_water
      const unpriced = await client.query(
        `SELECT 1 FROM hosted_billing_ledger
         WHERE tenant_id=$1 AND entry_id <= $4 AND created_at >= $2 AND created_at < $3
           AND amount IS NULL LIMIT 1`,
        [input.tenantId, input.periodStart, input.periodEnd, highWater],
      )
      if (unpriced.rowCount !== 0) throw new Error('invoice cannot finalize while billable entries lack an effective price')
      const lines = await client.query<{ unit: string; quantity: string; amount: string }>(
        `SELECT unit,sum(quantity)::text AS quantity,sum(amount)::text AS amount
         FROM hosted_billing_ledger
         WHERE tenant_id=$1 AND entry_id <= $4 AND created_at >= $2 AND created_at < $3
           AND currency=$5
         GROUP BY unit ORDER BY unit`,
        [input.tenantId, input.periodStart, input.periodEnd, highWater, input.currency],
      )
      const net = await client.query<{ amount: string }>(
        `SELECT COALESCE(sum(amount),0)::text AS amount FROM hosted_billing_ledger
         WHERE tenant_id=$1 AND entry_id <= $4 AND created_at >= $2 AND created_at < $3
           AND currency=$5`,
        [input.tenantId, input.periodStart, input.periodEnd, highWater, input.currency],
      )
      const lineItems = lines.rows
      const inserted = await client.query<{
        created_at: string
      }>(
        `INSERT INTO hosted_invoice_exports(
           invoice_id,supersedes_invoice_id,tenant_id,period_start,period_end,currency,ledger_high_water,
           net_amount,line_items,idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT DO NOTHING RETURNING created_at::text`,
        [
          input.invoiceId,supersedesInvoiceId,input.tenantId,input.periodStart,input.periodEnd,
          input.currency,highWater,net.rows[0]!.amount,JSON.stringify(lineItems),input.idempotencyKey,
        ],
      )
      if (inserted.rowCount !== 1) throw new Error('invoice identity, period, revision, or idempotency key conflicts')
      const invoice: BillingInvoice = {
        invoiceId: input.invoiceId,supersedesInvoiceId,tenantId: input.tenantId,
        periodStart: canonicalTimestamp(input.periodStart), periodEnd: canonicalTimestamp(input.periodEnd),
        currency: input.currency, ledgerHighWater: highWater,
        netAmount: net.rows[0]!.amount, lineItems,
        createdAt: inserted.rows[0]!.created_at,
      }
      await this.outbox(client, input.tenantId, 'billing.invoice-finalized', input.invoiceId, invoice)
      return { invoice, created: true }
    })
  }

  async listInvoiceExports(tenantId: string, limit = 200): Promise<BillingInvoice[]> {
    const result = await this.pool.query<{
      invoice_id: string; supersedes_invoice_id: string | null
      tenant_id: string; period_start: string; period_end: string
      currency: string; ledger_high_water: string; net_amount: string
      line_items: BillingInvoice['lineItems']; created_at: string
    }>(
      `SELECT invoice_id,supersedes_invoice_id,tenant_id,period_start::text,period_end::text,currency,
              ledger_high_water::text,net_amount::text,line_items,created_at::text
       FROM hosted_invoice_exports WHERE tenant_id=$1
       ORDER BY period_end DESC,invoice_id LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map((row) => ({
      invoiceId: row.invoice_id,supersedesInvoiceId: row.supersedes_invoice_id,tenantId: row.tenant_id,
      periodStart: row.period_start, periodEnd: row.period_end,
      currency: row.currency, ledgerHighWater: row.ledger_high_water,
      netAmount: row.net_amount, lineItems: row.line_items, createdAt: row.created_at,
    }))
  }

  async issueBillingRefund(fence: CoordinatorFence, input: {
    tenantId: string
    chargeEntryId: string
    quantity: string
    reason: string
    idempotencyKey: string
  }): Promise<{ entry: BillingLedgerEntry; created: boolean }> {
    if (!/^\d+$/.test(input.chargeEntryId)) throw new Error('chargeEntryId must be an unsigned integer')
    if (!/^\d+(?:\.\d{1,18})?$/.test(input.quantity) || Number(input.quantity) <= 0) {
      throw new Error('refund quantity must be a positive decimal')
    }
    if (input.reason.trim().length < 4 || input.reason.length > 500) throw new Error('refund reason must contain 4 through 500 characters')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`billing-refund:${input.idempotencyKey}`],
      )
      const replay = await client.query<BillingLedgerRow>(
        `SELECT ${BILLING_LEDGER_SELECT} FROM hosted_billing_ledger
         WHERE idempotency_key=$1 FOR SHARE`, [`refund:${input.idempotencyKey}`],
      )
      if (replay.rows[0]) {
        const row = replay.rows[0]
        if (
          row.tenant_id !== input.tenantId || row.entry_kind !== 'REFUND'
          || row.reverses_entry_id !== input.chargeEntryId
          || canonicalDecimal(row.quantity) !== canonicalDecimal(`-${input.quantity}`)
          || row.metadata.reason !== input.reason.trim()
        ) throw new Error('refund idempotency key is bound to different immutable terms')
        return { entry: billingLedgerEntry(row), created: false }
      }
      const charge = await client.query<BillingLedgerRow>(
        `SELECT ${BILLING_LEDGER_SELECT} FROM hosted_billing_ledger
         WHERE entry_id=$1 AND tenant_id=$2 AND entry_kind='CHARGE' FOR UPDATE`,
        [input.chargeEntryId, input.tenantId],
      )
      const original = charge.rows[0]
      if (!original) throw new HostedAuthError('billable charge was not found for this tenant')
      if (original.sponsorship_id) {
        throw new Error('sponsored aggregate charges are refunded only by canonical outcome recovery')
      }
      const outstanding = await client.query<{ quantity: string }>(
        `SELECT (charge.quantity + COALESCE(sum(adjustment.quantity),0))::text AS quantity
         FROM hosted_billing_ledger AS charge
         LEFT JOIN hosted_billing_ledger AS adjustment ON adjustment.reverses_entry_id=charge.entry_id
         WHERE charge.entry_id=$1 GROUP BY charge.entry_id`, [input.chargeEntryId],
      )
      const allowed = await client.query<{ allowed: boolean }>(
        `SELECT $1::numeric <= $2::numeric AS allowed`,
        [input.quantity, outstanding.rows[0]!.quantity],
      )
      if (!allowed.rows[0]!.allowed) throw new Error('refund quantity exceeds the unreversed charge balance')
      const refundAmount = original.amount === null
        ? null
        : (await client.query<{ amount: string }>(
            `SELECT (-$1::numeric * $2::numeric / $3::numeric)::text AS amount`,
            [input.quantity, original.amount, original.quantity],
          )).rows[0]!.amount
      const inserted = await client.query<BillingLedgerRow>(
        `INSERT INTO hosted_billing_ledger(
           tenant_id,beneficiary_tenant_id,sponsorship_id,allocation_id,job_id,room_id,
           aggregate_hash,member_index,entry_kind,unit,quantity,currency,amount,
           price_id,price_effective_from,sla_policy_id,sla_effective_from,
           source_fact_id,reverses_entry_id,idempotency_key,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REFUND',$9,-$10::numeric,$11,$12,
           $13,$14,$15,$16,$17,$18,$19,$20::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${BILLING_LEDGER_SELECT}`,
        [
          original.tenant_id,original.beneficiary_tenant_id,original.sponsorship_id,
          original.allocation_id,original.job_id,original.room_id,original.aggregate_hash,
          original.member_index,original.unit,input.quantity,original.currency,refundAmount,
          original.price_id,original.price_effective_from,original.sla_policy_id,
          original.sla_effective_from,original.source_fact_id,original.entry_id,
          `refund:${input.idempotencyKey}`, JSON.stringify({ reason: input.reason.trim() }),
        ],
      )
      const entry = inserted.rows[0]
      if (!entry) throw new Error('refund idempotency key conflicts with another immutable ledger entry')
      await client.query(
        `INSERT INTO hosted_refunds(
           tenant_id,billing_entry_id,quantity,unit,reason,idempotency_key,status
         ) VALUES ($1,$2,$3,$4,$5,$6,'SUCCEEDED')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.tenantId, entry.entry_id, input.quantity, original.unit,
          input.reason.trim(), input.idempotencyKey,
        ],
      )
      const exactRefund = await client.query<{ tenant_id: string;billing_entry_id: string;quantity: string;unit: string;reason: string }>(
        `SELECT tenant_id,billing_entry_id::text,quantity::text,unit,reason
         FROM hosted_refunds WHERE idempotency_key=$1 FOR SHARE`, [input.idempotencyKey],
      )
      if (
        exactRefund.rows[0]?.tenant_id !== input.tenantId
        || exactRefund.rows[0]?.billing_entry_id !== entry.entry_id
        || canonicalDecimal(exactRefund.rows[0]?.quantity ?? '-1') !== canonicalDecimal(input.quantity)
        || exactRefund.rows[0]?.unit !== original.unit
        || exactRefund.rows[0]?.reason !== input.reason.trim()
      ) throw new Error('refund idempotency key conflicts with immutable refund terms')
      await this.outbox(client, input.tenantId, 'billing.refund-finalized', entry.entry_id, {
        chargeEntryId: original.entry_id,
        refundEntryId: entry.entry_id,
        quantity: input.quantity,
        unit: original.unit,
        reason: input.reason.trim(),
      })
      return { entry: billingLedgerEntry(entry), created: true }
    })
  }

  async listBillingRefunds(tenantId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT refund.refund_id::text AS "refundId",refund.tenant_id AS "tenantId",
              refund.sponsorship_id AS "sponsorshipId",
              refund.billing_entry_id::text AS "billingEntryId",
              refund.quantity::text,refund.unit,refund.reason,refund.idempotency_key AS "idempotencyKey",
              refund.status,refund.created_at::text AS "createdAt"
       FROM hosted_refunds AS refund WHERE refund.tenant_id=$1
       ORDER BY refund.refund_id DESC LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows
  }

  async requestNodeLifecycle(
    fence: CoordinatorFence,
    input: {
      principalId: string
      onchainNodeId: `0x${string}`
      desiredState: NodeLifecycleDesiredState
      idempotencyKey: string
      previousIdempotencyKey?: string | null
      maxAttempts?: number
      actorPrincipalId?: string | null
    },
  ): Promise<{ operation: NodeLifecycleOperation; created: boolean }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.principalId)) {
      throw new Error('provider principal id is invalid')
    }
    if (!/^0x[0-9a-f]{64}$/.test(input.onchainNodeId)) throw new Error('onchainNodeId must be lowercase bytes32')
    if (!['DRAINING','RETIRED'].includes(input.desiredState)) throw new Error('invalid node lifecycle state')
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new Error('invalid idempotency key')
    const maxAttempts = input.maxAttempts ?? 12
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error('node lifecycle maxAttempts must be from 1 through 100')
    }
    const previousIdempotencyKey = input.previousIdempotencyKey ?? null
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[
        `node-lifecycle:${input.principalId}`,
      ])
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[
        `node-lifecycle-idem:${input.idempotencyKey}`,
      ])
      const operationId = `node-lifecycle-${createHash('sha256')
        .update(`${input.principalId}\0${input.idempotencyKey}`).digest('hex').slice(0,32)}`
      const replay = await client.query<NodeLifecycleRow>(
        `SELECT ${NODE_LIFECYCLE_SELECT} FROM hosted_node_lifecycle_operations
         WHERE operation_id=$1 OR idempotency_key=$2 FOR SHARE`,
        [operationId,input.idempotencyKey],
      )
      if (replay.rows.length > 0) {
        const row = replay.rows[0]!
        const priorKey = row.prior_operation_id === null ? null : (await client.query<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM hosted_node_lifecycle_operations WHERE operation_id=$1`,
          [row.prior_operation_id],
        )).rows[0]?.idempotency_key ?? null
        if (
          replay.rows.length !== 1 || row.operation_id !== operationId
          || row.principal_id !== input.principalId || row.onchain_node_id !== input.onchainNodeId
          || row.desired_state !== input.desiredState || row.idempotency_key !== input.idempotencyKey
          || priorKey !== previousIdempotencyKey || row.max_attempts !== maxAttempts
        ) throw new Error('node lifecycle idempotency key is bound to different immutable terms')
        return { operation: nodeLifecycleOperation(row),created: false }
      }
      const assignment = await client.query(
        `SELECT 1 FROM hosted_provider_nodes WHERE principal_id=$1 FOR UPDATE`, [input.principalId],
      )
      if (assignment.rowCount !== 1) throw new HostedAuthError('provider node assignment does not exist')
      const retired = await client.query(
        `SELECT 1 FROM hosted_node_lifecycle_operations
         WHERE principal_id=$1 AND desired_state='RETIRED' AND status='APPLIED' FOR SHARE`,
        [input.principalId],
      )
      if (retired.rowCount !== 0) throw new Error('retired node lifecycle is irreversible')
      let priorOperationId: string | null = null
      if (input.desiredState === 'DRAINING') {
        if (previousIdempotencyKey !== null) throw new Error('initial drain cannot name a prior lifecycle operation')
        await client.query(
          `UPDATE hosted_provider_nodes SET active=false,updated_at=clock_timestamp()
           WHERE principal_id=$1`, [input.principalId],
        )
      } else {
        if (previousIdempotencyKey === null) throw new Error('retirement must link the applied drain operation')
        const drain = await client.query<{ operation_id: string }>(
          `SELECT operation.operation_id
           FROM hosted_node_lifecycle_operations AS operation
           JOIN hosted_indexer_facts AS fact
             ON fact.fact_id=operation.canonical_fact_id AND fact.canonical
            AND fact.payload #>> '{provenance,eventName}'='NodeDrainStarted'
            AND lower(fact.payload #>> '{args,nodeId}')=operation.onchain_node_id
           JOIN hosted_canonical_floors AS floor
             ON floor.chain_id=fact.chain_id AND fact.block_number <= floor.block_number
           WHERE operation.principal_id=$1 AND operation.onchain_node_id=$2
             AND operation.desired_state='DRAINING' AND operation.status='APPLIED'
             AND operation.idempotency_key=$3 FOR SHARE OF operation,fact`,
          [input.principalId,input.onchainNodeId,previousIdempotencyKey],
        )
        priorOperationId = drain.rows[0]?.operation_id ?? null
        if (!priorOperationId) throw new Error('retirement requires the exact finalized canonical drain fact')
      }
      const inserted = await client.query<NodeLifecycleRow>(
        `INSERT INTO hosted_node_lifecycle_operations(
           operation_id,principal_id,onchain_node_id,desired_state,idempotency_key,
           prior_operation_id,status,max_attempts
         ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)
         RETURNING ${NODE_LIFECYCLE_SELECT}`,
        [
          operationId,input.principalId,input.onchainNodeId,input.desiredState,
          input.idempotencyKey,priorOperationId,maxAttempts,
        ],
      )
      const operation = nodeLifecycleOperation(inserted.rows[0]!)
      await this.outbox(client,null,'provider-node.lifecycle-requested',operationId,operation,'admin-internal')
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,idempotency_key,details)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          input.actorPrincipalId ?? null,
          input.desiredState === 'DRAINING' ? 'provider-node.drain.request' : 'provider-node.retire.request',
          input.principalId,input.idempotencyKey,JSON.stringify(operation),
        ],
      )
      return { operation,created: true }
    })
  }

  async listNodeLifecycleOperations(principalId: string,limit=100): Promise<NodeLifecycleOperation[]> {
    const result = await this.pool.query<NodeLifecycleRow>(
      `SELECT ${NODE_LIFECYCLE_SELECT} FROM hosted_node_lifecycle_operations
       WHERE principal_id=$1 ORDER BY created_at,operation_id LIMIT $2`,
      [principalId,Math.max(1,Math.min(limit,1000))],
    )
    return result.rows.map(nodeLifecycleOperation)
  }

  async leaseNodeLifecycleExecutions(
    fence: CoordinatorFence,
    workerId: string,
    limit: number,
    leaseTtlMs: number,
  ): Promise<NodeLifecycleExecutionLease[]> {
    if (!workerId || workerId.length > 200) throw new Error('node lifecycle worker id is invalid')
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 5_000 || leaseTtlMs > 3_600_000) {
      throw new Error('node lifecycle lease TTL is invalid')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      await client.query(
        `UPDATE hosted_node_lifecycle_operations SET
           status=CASE WHEN attempts>=max_attempts THEN 'FAILED' ELSE 'RETRY' END,
           next_attempt_at=clock_timestamp(),last_error='provider lease expired',
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE status='LEASED' AND lease_expires_at <= clock_timestamp()`,
      )
      const selected = await client.query<{ operation_id: string }>(
        `SELECT operation_id FROM hosted_node_lifecycle_operations
         WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= clock_timestamp()
         ORDER BY created_at,operation_id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [Math.max(1,Math.min(limit,100))],
      )
      if (selected.rowCount === 0) return []
      const leased = await client.query<NodeLifecycleRow>(
        `UPDATE hosted_node_lifecycle_operations SET
           status='LEASED',attempts=attempts+1,lease_owner=$2,lease_token=attempts+1,
           lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp()
         WHERE operation_id=ANY($1::text[])
         RETURNING ${NODE_LIFECYCLE_SELECT}`,
        [selected.rows.map((row) => row.operation_id),workerId,leaseTtlMs],
      )
      return leased.rows.map(nodeLifecycleOperation) as NodeLifecycleExecutionLease[]
    })
  }

  async completeNodeLifecycleExecution(
    fence: CoordinatorFence,
    lease: NodeLifecycleExecutionLease,
    result: NodeLifecycleProviderResult,
  ): Promise<NodeLifecycleOperation> {
    const expectedSelector = lease.desiredState === 'DRAINING' ? '0xd7ceb78e' : '0x13ca0607'
    const evidence = result.evidence
    if (
      evidence.nodeId !== lease.onchainNodeId || evidence.desiredState !== lease.desiredState
      || evidence.selector !== expectedSelector
      || typeof evidence.transactionHash !== 'string'
      || !/^0x[0-9a-f]{64}$/.test(evidence.transactionHash)
    ) throw new Error('node lifecycle provider evidence is not bound to the exact on-chain operation')
    if (result.state === 'PENDING' && result.retryAfterMs === null) {
      throw new Error('pending node lifecycle result omitted retryAfterMs')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const current = await client.query<NodeLifecycleRow>(
        `SELECT ${NODE_LIFECYCLE_SELECT} FROM hosted_node_lifecycle_operations
         WHERE operation_id=$1 AND status='LEASED' AND lease_owner=$2 AND lease_token=$3
           AND lease_expires_at > clock_timestamp() FOR UPDATE`,
        [lease.operationId,lease.leaseOwner,lease.leaseToken],
      )
      const row = current.rows[0]
      if (!row) throw new HostedFenceError('node lifecycle provider lease expired or was fenced')
      if (row.provider_operation_id && row.provider_operation_id !== result.providerOperationId) {
        throw new Error('node lifecycle provider operation id changed across retries')
      }
      const updated = await client.query<NodeLifecycleRow>(
        `UPDATE hosted_node_lifecycle_operations SET
           status=$2,provider_operation_id=$3,provider_evidence=$4::jsonb,
           next_attempt_at=CASE WHEN $2='RETRY'
             THEN clock_timestamp()+($5::bigint*interval '1 millisecond') ELSE clock_timestamp() END,
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,
           updated_at=clock_timestamp()
         WHERE operation_id=$1 RETURNING ${NODE_LIFECYCLE_SELECT}`,
        [
          lease.operationId,result.state === 'APPLIED' ? 'VERIFYING' : 'RETRY',
          result.providerOperationId,JSON.stringify(evidence),result.retryAfterMs ?? 0,
        ],
      )
      return nodeLifecycleOperation(updated.rows[0]!)
    })
  }

  async failNodeLifecycleExecution(
    fence: CoordinatorFence,
    lease: NodeLifecycleExecutionLease,
    error: string,
    retryAfterMs: number,
    permanent: boolean,
  ): Promise<NodeLifecycleOperation> {
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const updated = await client.query<NodeLifecycleRow>(
        `UPDATE hosted_node_lifecycle_operations SET
           status=CASE WHEN $4 OR attempts>=max_attempts THEN 'FAILED' ELSE 'RETRY' END,
           next_attempt_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=$6,
           updated_at=clock_timestamp()
         WHERE operation_id=$1 AND status='LEASED' AND lease_owner=$2 AND lease_token=$3
           AND lease_expires_at > clock_timestamp()
         RETURNING ${NODE_LIFECYCLE_SELECT}`,
        [lease.operationId,lease.leaseOwner,lease.leaseToken,permanent,retryAfterMs,error.slice(0,1000)],
      )
      if (!updated.rows[0]) throw new HostedFenceError('node lifecycle provider lease expired or was fenced')
      return nodeLifecycleOperation(updated.rows[0])
    })
  }

  async reconcileNodeLifecycleFacts(
    fence: CoordinatorFence,
    chainId: number,
  ): Promise<{ applied: number;recoveryRequired: number }> {
    return this.transaction(async (client) => {
      await this.assertFence(client,fence)
      const rows = await client.query<NodeLifecycleRow>(
        `SELECT ${NODE_LIFECYCLE_SELECT} FROM hosted_node_lifecycle_operations
         WHERE status IN ('VERIFYING','APPLIED','RECOVERY_REQUIRED')
         ORDER BY created_at,operation_id FOR UPDATE`,
      )
      let applied=0
      let recoveryRequired=0
      for (const row of rows.rows) {
        const expectedEvent = row.desired_state === 'DRAINING' ? 'NodeDrainStarted' : 'NodeRetired'
        const transactionHash = row.provider_evidence.transactionHash
        const fact = await client.query<{ fact_id: string;block_hash: `0x${string}` }>(
          `SELECT fact.fact_id::text,fact.block_hash
           FROM hosted_indexer_facts AS fact
           JOIN hosted_canonical_floors AS floor
             ON floor.chain_id=fact.chain_id AND fact.block_number <= floor.block_number
           WHERE fact.chain_id=$1 AND fact.canonical
             AND fact.payload #>> '{provenance,eventName}'=$2
             AND lower(fact.payload #>> '{args,nodeId}')=$3
             AND lower(fact.payload #>> '{provenance,transactionHash}')=$4
           ORDER BY fact.block_number,fact.fact_id FOR SHARE OF fact`,
          [chainId,expectedEvent,row.onchain_node_id,transactionHash],
        )
        if ((fact.rowCount ?? 0) > 1) throw new Error('node lifecycle has multiple canonical finality facts')
        if (fact.rows[0]) {
          if (
            row.status !== 'APPLIED' || row.canonical_fact_id !== fact.rows[0].fact_id
            || row.canonical_fact_block_hash !== fact.rows[0].block_hash
          ) {
            await client.query(
              `UPDATE hosted_node_lifecycle_operations SET
                 status='APPLIED',canonical_fact_id=$2,canonical_fact_block_hash=$3,
                 last_error=NULL,updated_at=clock_timestamp() WHERE operation_id=$1`,
              [row.operation_id,fact.rows[0].fact_id,fact.rows[0].block_hash],
            )
            await this.outbox(client,null,'provider-node.lifecycle-applied',row.operation_id,{
              principalId: row.principal_id,onchainNodeId: row.onchain_node_id,
              desiredState: row.desired_state,canonicalFactId: fact.rows[0].fact_id,
              canonicalFactBlockHash: fact.rows[0].block_hash,
            },'admin-internal')
            applied+=1
          }
        } else if (row.status === 'APPLIED') {
          await client.query(
            `UPDATE hosted_node_lifecycle_operations SET
               status='RECOVERY_REQUIRED',canonical_fact_id=NULL,canonical_fact_block_hash=NULL,
               last_error='canonical node lifecycle fact retracted',updated_at=clock_timestamp()
             WHERE operation_id=$1`, [row.operation_id],
          )
          await this.outbox(client,null,'provider-node.lifecycle-retracted',row.operation_id,{
            previousState: { desiredState: row.desired_state,canonicalFactId: row.canonical_fact_id },
            reason: { code: 'CANONICAL_NODE_LIFECYCLE_FACT_RETRACTED' },
          },'admin-internal')
          recoveryRequired+=1
        }
      }
      return { applied,recoveryRequired }
    })
  }

  async listCapacityIntents(tenantId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT allocation_id AS "allocationId",tenant_id AS "tenantId",room_id::text AS "roomId",
              desired_state AS "desiredState",provider_node_id AS "providerNodeId",
              deadline_at::text AS "deadlineAt",idempotency_key AS "idempotencyKey",
              metadata,execution_status AS "executionStatus",applied_state AS "appliedState",
              provider_operation_id AS "providerOperationId",provider_response AS "providerResponse",
              attempts,max_attempts AS "maxAttempts",next_attempt_at::text AS "nextAttemptAt",
              lease_owner AS "leaseOwner",lease_token::text AS "leaseToken",
              lease_expires_at::text AS "leaseExpiresAt",last_error AS "lastError",
              last_success_at::text AS "lastSuccessAt",alerted_at::text AS "alertedAt",
              updated_at::text AS "updatedAt"
       FROM hosted_capacity_intents WHERE tenant_id=$1
       ORDER BY updated_at DESC,allocation_id LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows
  }

  async listKnownRoomIds(chainId: number, limit = 1_000): Promise<string[]> {
    const result = await this.pool.query<{ room_id: string }>(
      `SELECT room_id::text
       FROM (
         SELECT room_id FROM hosted_room_observations WHERE chain_id=$1
         UNION
         SELECT room_id FROM hosted_indexer_facts
          WHERE chain_id=$1 AND canonical AND room_id IS NOT NULL
       ) AS known_rooms
       ORDER BY room_id
       LIMIT $2`,
      [chainId, Math.max(1, Math.min(limit, 10_000))],
    )
    return result.rows.map((row) => row.room_id)
  }

  async leaseRoomReconciliations(
    fence: CoordinatorFence,
    chainId: number,
    priorityRoomIds: string[],
    limit: number,
  ): Promise<string[]> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      for (const roomId of priorityRoomIds) {
        await client.query(
          `INSERT INTO hosted_room_reconciliation_queue(chain_id,room_id,dirty,priority)
           VALUES ($1,$2,true,1000)
           ON CONFLICT (chain_id,room_id) DO UPDATE SET
             dirty=true,priority=GREATEST(hosted_room_reconciliation_queue.priority,1000),
             next_retry_at=NULL,updated_at=clock_timestamp()`,
          [chainId, roomId],
        )
      }
      const selected = await client.query<{ room_id: string }>(
        `SELECT room_id::text
         FROM hosted_room_reconciliation_queue
         WHERE chain_id=$1 AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
         ORDER BY
           (room_id = ANY($2::numeric[])) DESC,
           dirty DESC,
           priority DESC,
           last_success_at ASC NULLS FIRST,
           room_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $3`,
        [chainId, priorityRoomIds, Math.max(1, Math.min(limit, 10_000))],
      )
      if (selected.rows.length > 0) {
        await client.query(
          `UPDATE hosted_room_reconciliation_queue SET
             attempts=attempts+1,last_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE chain_id=$1 AND room_id=ANY($2::numeric[])`,
          [chainId, selected.rows.map((row) => row.room_id)],
        )
      }
      return selected.rows.map((row) => row.room_id)
    })
  }

  async completeRoomReconciliation(
    fence: CoordinatorFence,
    input: {
      chainId: number
      roomId: string
      headBlock: string
      headHash: `0x${string}`
      error?: string | null
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const failed = Boolean(input.error)
      const result = await client.query(
        `UPDATE hosted_room_reconciliation_queue SET
           dirty=$3,
           priority=CASE WHEN $3 THEN GREATEST(priority,100) ELSE 0 END,
           last_success_at=CASE WHEN $3 THEN last_success_at ELSE clock_timestamp() END,
           last_success_block=CASE WHEN $3 THEN last_success_block ELSE $4 END,
           last_success_hash=CASE WHEN $3 THEN last_success_hash ELSE $5 END,
           last_error=$6,
           next_retry_at=CASE WHEN $3 THEN clock_timestamp() + interval '15 seconds' ELSE NULL END,
           updated_at=clock_timestamp()
         WHERE chain_id=$1 AND room_id=$2`,
        [input.chainId, input.roomId, failed, input.headBlock, input.headHash, input.error ?? null],
      )
      if (result.rowCount !== 1) throw new Error('room reconciliation queue entry disappeared')
    })
  }

  async recordCanonicalBlocks(
    fence: CoordinatorFence,
    blocks: CanonicalBlockInput[],
  ): Promise<{ rolledBackFrom: string | null }> {
    if (blocks.length === 0) throw new Error('canonical block batch cannot be empty')
    const chainId = blocks[0]!.chainId
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<{
        block_number: string
        block_hash: string
        parent_hash: string
      }>(
        `SELECT block_number::text, block_hash, parent_hash
         FROM canonical_l1_blocks
         WHERE chain_id = $1 AND canonical
         ORDER BY block_number FOR UPDATE`,
        [chainId],
      )
      const anchorResult = await client.query<{
        chain_id: string
        block_number: string
        block_hash: string
        verified_sources: string[]
      }>(
        `SELECT chain_id::text, block_number::text, block_hash, verified_sources
         FROM hosted_canonical_floors WHERE chain_id = $1 FOR SHARE`,
        [chainId],
      )
      const anchorRow = anchorResult.rows[0]
      const anchor: CanonicalAnchor | null = anchorRow ? {
        chainId: Number(anchorRow.chain_id),
        number: anchorRow.block_number,
        hash: anchorRow.block_hash,
        verifiedSources: anchorRow.verified_sources,
      } : null
      const plan = planCanonicalIngestion(
        chainId,
        current.rows.map((row) => ({
          number: row.block_number,
          hash: row.block_hash,
          parentHash: row.parent_hash,
        })),
        blocks,
        anchor,
      )
      if (plan.rollbackFrom !== null) {
        await client.query(
          `UPDATE canonical_l1_blocks SET canonical = false
           WHERE chain_id = $1 AND block_number >= $2 AND canonical`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `DELETE FROM hosted_room_observations
           WHERE chain_id = $1 AND head_block >= $2`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `UPDATE hosted_indexer_logs SET canonical = false
           WHERE chain_id = $1 AND block_number >= $2 AND canonical`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `UPDATE hosted_indexer_facts SET canonical = false
           WHERE chain_id = $1 AND block_number >= $2 AND canonical`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `UPDATE hosted_withdrawals SET
             previous_status = status,
             status = 'RETRACTED',
             retraction_reason = 'canonical L1 provenance was removed by a reorganization',
             updated_at = clock_timestamp()
           WHERE chain_id = $1 AND finalized_block >= $2 AND status <> 'RETRACTED'`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `UPDATE hosted_blob_requirements SET
             canonical=false,status='RETRACTED',retracted_at=clock_timestamp(),
             last_error='canonical L1 provenance was removed by a reorganization',
             updated_at=clock_timestamp()
           WHERE chain_id=$1 AND block_number >= $2 AND canonical`,
          [chainId, plan.rollbackFrom],
        )
        await client.query(
          `UPDATE hosted_room_reconciliation_queue AS queue SET
             dirty=true,priority=GREATEST(queue.priority,1000),next_retry_at=NULL,
             last_error='canonical provenance was retracted; reconciliation required',
             updated_at=clock_timestamp()
           WHERE queue.chain_id=$1 AND (
             queue.last_success_block >= $2 OR EXISTS (
               SELECT 1 FROM hosted_indexer_facts AS fact
               WHERE fact.chain_id=$1 AND fact.room_id=queue.room_id AND fact.block_number >= $2
             )
           )`,
          [chainId, plan.rollbackFrom],
        )
        // Normally finalized billing sits below the advance-only floor and is
        // therefore unreachable by an ordinary rollback. Keeping correction
        // generation inside this transaction also covers an explicit
        // post-finality recovery that retracts previously trusted facts.
        await this.reconcileAggregateBillingTx(client, chainId)
        if (plan.commonAncestorNumber === null || plan.commonAncestorHash === null) {
          await client.query('DELETE FROM hosted_indexer_cursors WHERE chain_id = $1', [chainId])
        } else {
          await client.query(
            `UPDATE hosted_indexer_cursors SET block_number = $2, block_hash = $3,
               updated_at = clock_timestamp() WHERE chain_id = $1`,
            [chainId, plan.commonAncestorNumber, plan.commonAncestorHash],
          )
        }
        await this.outbox(client, null, 'indexer.rollback', plan.rollbackFrom, {
          chainId,
          fromBlock: plan.rollbackFrom,
          commonAncestorNumber: plan.commonAncestorNumber,
          commonAncestorHash: plan.commonAncestorHash,
          candidateHeadNumber: blocks.at(-1)!.number,
          candidateHeadHash: blocks.at(-1)!.hash,
        }, 'public-chain')
        await this.outbox(client, null, 'statusRetracted', `${chainId}:${plan.rollbackFrom}`, {
          previousState: {
            canonicalFromBlock: plan.rollbackFrom,
            candidateHeadNumber: blocks.at(-1)!.number,
          },
          reason: {
            code: 'L1_REORGANIZATION',
            commonAncestorNumber: plan.commonAncestorNumber,
            commonAncestorHash: plan.commonAncestorHash,
          },
        }, 'public-chain')
      }
      for (const block of blocks) {
        await client.query(
          `INSERT INTO canonical_l1_blocks(
             chain_id, block_number, block_hash, parent_hash, canonical, observed_at
           ) VALUES ($1,$2,$3,$4,true,$5)
           ON CONFLICT (chain_id, block_number, block_hash) DO UPDATE SET
             canonical = true, parent_hash = EXCLUDED.parent_hash,
             observed_at = EXCLUDED.observed_at`,
          [block.chainId, block.number, block.hash, block.parentHash, block.observedAt],
        )
      }
      return { rolledBackFrom: plan.rollbackFrom }
    })
  }

  async putRoomObservation(
    fence: CoordinatorFence,
    input: {
      chainId: number
      roomId: string
      tenantId: string | null
      schemaVersion: number
      headBlock: string
      headHash: `0x${string}`
      document: Record<string, unknown>
      reconciliationErrors?: string[]
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const canonical = await client.query(
        `SELECT 1 FROM canonical_l1_blocks
         WHERE chain_id = $1 AND block_number = $2
           AND lower(block_hash) = lower($3) AND canonical`,
        [input.chainId, input.headBlock, input.headHash],
      )
      if (canonical.rowCount !== 1) throw new Error('observation head is not in the canonical block journal')
      const errors = input.reconciliationErrors ?? []
      await client.query(
        `INSERT INTO hosted_room_observations(
           room_id, chain_id, tenant_id, schema_version, head_block, head_hash,
           document, reconciled, reconciliation_errors
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
         ON CONFLICT (chain_id, room_id) DO UPDATE SET
           chain_id = EXCLUDED.chain_id,
           tenant_id = EXCLUDED.tenant_id,
           schema_version = EXCLUDED.schema_version,
           head_block = EXCLUDED.head_block,
           head_hash = EXCLUDED.head_hash,
           document = EXCLUDED.document,
           reconciled = EXCLUDED.reconciled,
           reconciliation_errors = EXCLUDED.reconciliation_errors,
           updated_at = clock_timestamp()`,
        [
          input.roomId,
          input.chainId,
          input.tenantId,
          input.schemaVersion,
          input.headBlock,
          input.headHash,
          JSON.stringify(input.document),
          errors.length === 0,
          JSON.stringify(errors),
        ],
      )
      await this.outbox(client, input.tenantId, 'room.observation', input.roomId, {
        chainId: input.chainId,
        schemaVersion: input.schemaVersion,
        headBlock: input.headBlock,
        headHash: input.headHash,
        reconciled: errors.length === 0,
        reconciliationErrors: errors,
      })
    })
  }

  async upsertProofProfile(
    fence: CoordinatorFence,
    profile: HostedProofProfile,
    actor = 'hosting-admin',
  ): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(profile.proofClass)) {
      throw new Error('invalid proof class')
    }
    if (
      profile.endpoint!=='/hosting/v1/rooms/prepare-batch'
      && !/^\/v5\/[a-z0-9/-]+$/.test(profile.endpoint)
    ) throw new Error('invalid prover endpoint')
    if (!/^\d+(?:\.\d+)?$/.test(profile.estimatedWork) || Number(profile.estimatedWork) <= 0) {
      throw new Error('estimated work must be a positive decimal')
    }
    if (!Number.isSafeInteger(profile.estimatedProofTimeMs) || profile.estimatedProofTimeMs < 1_000) {
      throw new Error('estimated proof time must be at least one second')
    }
    if (!Number.isSafeInteger(profile.settlementMarginMs) || profile.settlementMarginMs < 0) {
      throw new Error('settlement margin must be non-negative')
    }
    if (!Number.isFinite(Date.parse(profile.verifiedAt))) throw new Error('verifiedAt must be an ISO timestamp')
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        `INSERT INTO hosted_proof_profiles(
           proof_class, endpoint, needs_gpu, estimated_work,
           estimated_proof_time_ms, settlement_margin_ms, evidence, verified_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (proof_class) DO UPDATE SET
           endpoint = EXCLUDED.endpoint,
           needs_gpu = EXCLUDED.needs_gpu,
           estimated_work = EXCLUDED.estimated_work,
           estimated_proof_time_ms = EXCLUDED.estimated_proof_time_ms,
           settlement_margin_ms = EXCLUDED.settlement_margin_ms,
           evidence = EXCLUDED.evidence,
           verified_at = EXCLUDED.verified_at,
           updated_at = clock_timestamp()`,
        [
          profile.proofClass, profile.endpoint, profile.needsGpu, profile.estimatedWork,
          profile.estimatedProofTimeMs, profile.settlementMarginMs,
          JSON.stringify(profile.evidence), profile.verifiedAt,
        ],
      )
      await client.query(
        `INSERT INTO hosted_audit_records(action,target,details)
         VALUES ('proof-profile.upsert',$1,$2::jsonb)`,
        [profile.proofClass, JSON.stringify({ actor, ...profile })],
      )
      await this.outbox(client, null, 'proof-profile.updated', profile.proofClass, {
        endpoint: profile.endpoint,
        verifiedAt: profile.verifiedAt,
      })
    })
  }

  async assignProviderNode(
    fence: CoordinatorFence,
    assignment: HostedProviderNodeAssignment,
    actor = 'hosting-admin',
  ): Promise<void> {
    const partitions = [...new Set(assignment.partitions)]
    if (
      partitions.length === 0
      || partitions.some((partition) => !['shared', 'reserved', 'dedicated'].includes(partition))
    ) throw new Error('provider assignment has invalid partitions')
    if (!Number.isSafeInteger(assignment.maxConcurrentJobs) || assignment.maxConcurrentJobs < 1 || assignment.maxConcurrentJobs > 64) {
      throw new Error('provider max concurrency must be from 1 through 64')
    }
    if (!Number.isSafeInteger(assignment.leaseTtlMs) || assignment.leaseTtlMs < 5_000 || assignment.leaseTtlMs > 3_600_000) {
      throw new Error('provider lease TTL must be from 5000 through 3600000 milliseconds')
    }
    if (assignment.gpu && (!assignment.gpuResourceId || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(assignment.gpuResourceId))) {
      throw new Error('GPU provider assignment requires a stable gpuResourceId')
    }
    if (!assignment.gpu && assignment.gpuResourceId !== null) {
      throw new Error('CPU-only provider assignment cannot name a GPU resource')
    }
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const principal = await client.query<{ kind: string; roles: string[]; active: boolean }>(
        `SELECT kind, roles, active FROM hosted_principals WHERE principal_id = $1 FOR SHARE`,
        [assignment.principalId],
      )
      const row = principal.rows[0]
      if (!row || row.kind !== 'node' || !row.active || !row.roles.includes('prove-node')) {
        throw new HostedAuthError('provider assignment requires an active prove-node principal')
      }
      const knownProfiles = assignment.proofClasses.length === 0
        ? { rowCount: 0 }
        : await client.query(
            `SELECT proof_class FROM hosted_proof_profiles WHERE proof_class = ANY($1::text[])`,
            [assignment.proofClasses],
          )
      if (knownProfiles.rowCount !== new Set(assignment.proofClasses).size) {
        throw new Error('provider assignment references an unknown proof class')
      }
      await client.query(
        `INSERT INTO hosted_provider_nodes(
           principal_id, provider_id, active, gpu, gpu_resource_id, partitions, tenant_ids,
           allocation_ids, proof_classes, max_concurrent_jobs, lease_ttl_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (principal_id) DO UPDATE SET
           provider_id = EXCLUDED.provider_id,
           active = EXCLUDED.active,
           gpu = EXCLUDED.gpu,
           gpu_resource_id = EXCLUDED.gpu_resource_id,
           partitions = EXCLUDED.partitions,
           tenant_ids = EXCLUDED.tenant_ids,
           allocation_ids = EXCLUDED.allocation_ids,
           proof_classes = EXCLUDED.proof_classes,
           max_concurrent_jobs = EXCLUDED.max_concurrent_jobs,
           lease_ttl_ms = EXCLUDED.lease_ttl_ms,
           updated_at = clock_timestamp()`,
        [
          assignment.principalId, assignment.providerId, assignment.active,
          assignment.gpu, assignment.gpuResourceId, partitions, [...new Set(assignment.tenantIds)],
          [...new Set(assignment.allocationIds)], [...new Set(assignment.proofClasses)],
          assignment.maxConcurrentJobs, assignment.leaseTtlMs,
        ],
      )
      await client.query(
        `INSERT INTO hosted_audit_records(principal_id,action,target,details)
         VALUES ($1,'provider-node.assign',$1,$2::jsonb)`,
        [assignment.principalId, JSON.stringify({ actor, ...assignment, partitions })],
      )
      await this.outbox(client, null, 'provider-node.assigned', assignment.principalId, {
        providerId: assignment.providerId,
        active: assignment.active,
        partitions,
      })
    })
  }

  async providerNode(principalId: string): Promise<HostedProviderNodeAssignment | null> {
    const result = await this.pool.query<{
      principal_id: string
      provider_id: string
      active: boolean
      gpu: boolean
      gpu_resource_id: string | null
      partitions: HostedProviderNodeAssignment['partitions']
      tenant_ids: string[]
      allocation_ids: string[]
      proof_classes: string[]
      max_concurrent_jobs: number
      lease_ttl_ms: string
    }>(
      `SELECT principal_id, provider_id, active, gpu, gpu_resource_id, partitions, tenant_ids,
              allocation_ids, proof_classes, max_concurrent_jobs, lease_ttl_ms::text
       FROM hosted_provider_nodes WHERE principal_id = $1`,
      [principalId],
    )
    const row = result.rows[0]
    return row ? {
      principalId: row.principal_id,
      providerId: row.provider_id,
      active: row.active,
      gpu: row.gpu,
      gpuResourceId: row.gpu_resource_id,
      partitions: row.partitions,
      tenantIds: row.tenant_ids,
      allocationIds: row.allocation_ids,
      proofClasses: row.proof_classes,
      maxConcurrentJobs: row.max_concurrent_jobs,
      leaseTtlMs: Number(row.lease_ttl_ms),
    } : null
  }

  async submitProveJob(
    fence: CoordinatorFence,
    input: {
      jobId: string
      retryOfJobId?: string | null
      chainId: number
      tenantId: string
      roomId: string | null
      allocationId: string | null
      sponsorshipId: string | null
      serviceClass: HostedProveJob['serviceClass']
      correlationId: string | null
      partition: HostedProveJob['partition']
      proofClass: string
      endpoint: string
      idempotencyKey: string
      requestHash: string
      requestObjectKey: string
      requestBytes: number
      deadlineAt: string | null
      priority: number
      maxAttempts?: number
      billingMode: HostedProveJob['billingMode']
      maximumChargeAmount?: string | null
      maximumChargeCurrency?: string | null
    },
  ): Promise<{ job: HostedProveJob; already: boolean }> {
    if (!/^pj-[0-9a-f]{10,64}$/.test(input.jobId)) throw new Error('invalid prove job id')
    const retryOfJobId = input.retryOfJobId ?? null
    if (retryOfJobId !== null && !/^pj-[0-9a-f]{10,64}$/.test(retryOfJobId)) {
      throw new Error('invalid retry-of prove job id')
    }
    if (retryOfJobId === input.jobId) throw new Error('prove job cannot retry itself')
    if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) throw new Error('invalid prove job chain id')
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error('invalid prove request hash')
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('invalid idempotency key')
    if (!Number.isSafeInteger(input.requestBytes) || input.requestBytes < 1) throw new Error('invalid request byte count')
    if (!Number.isSafeInteger(input.priority) || input.priority < -100 || input.priority > 100) {
      throw new Error('priority must be from -100 through 100')
    }
    if (input.deadlineAt !== null && !Number.isFinite(Date.parse(input.deadlineAt))) {
      throw new Error('deadline must be an ISO timestamp')
    }
    const maximumChargeAmount = input.maximumChargeAmount ?? null
    const maximumChargeCurrency = input.maximumChargeCurrency ?? null
    if (!['quoted', 'telemetry-only'].includes(input.billingMode)) {
      throw new Error('billingMode must be quoted or telemetry-only')
    }
    if ((maximumChargeAmount === null) !== (maximumChargeCurrency === null)) {
      throw new Error('maximum charge amount and currency must be supplied together')
    }
    if (input.billingMode === 'quoted' && maximumChargeAmount === null) {
      throw new Error('quoted work requires maximum charge amount and currency')
    }
    if (input.billingMode === 'telemetry-only' && maximumChargeAmount !== null) {
      throw new Error('telemetry-only work cannot carry commercial quote terms')
    }
    if (input.billingMode === 'telemetry-only' && input.sponsorshipId !== null) {
      throw new Error('sponsored work must accept an immutable commercial quote')
    }
    if (
      maximumChargeAmount !== null
      && (!/^\d+(?:\.\d{1,18})?$/.test(maximumChargeAmount) || !/^[A-Z]{3}$/.test(maximumChargeCurrency!))
    ) throw new Error('maximum charge must be a non-negative decimal and uppercase currency')
    const maxAttempts = input.maxAttempts ?? 3
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error('max attempts must be from 1 through 20')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const existing = await client.query<HostedProveJobRow & { request_hash: string }>(
        `SELECT ${PROVE_JOB_COLUMNS}, request_hash FROM hosted_prove_jobs
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        if (
          existingRow.request_hash !== input.requestHash
          || (existingRow.maximum_charge_amount === null
            ? null : canonicalDecimal(existingRow.maximum_charge_amount))
            !== (maximumChargeAmount === null ? null : canonicalDecimal(maximumChargeAmount))
          || existingRow.maximum_charge_currency !== maximumChargeCurrency
          || (existingRow.maximum_charge_amount === null ? 'telemetry-only' : 'quoted') !== input.billingMode
          || existingRow.retry_of_job_id !== retryOfJobId
        ) {
          throw new Error('prove-job idempotency key is bound to different request or quote terms')
        }
        return { job: proveJob(existingRow), already: true }
      }
      // One global serialization point closes the cross-tenant race between
      // the aggregate cap read and insert. Per-tenant row locks alone cannot.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-hosted-prove-queue-capacity'))")
      const tenant = await client.query<{
        limits: TenantLimits
        active: boolean
      }>(
        `SELECT limits, active FROM hosted_tenants
         WHERE tenant_id = $1 FOR UPDATE`,
        [input.tenantId],
      )
      const counts = await client.query<{
        jobs: string
        bytes: string
        global_jobs: string
        global_bytes: string
      }>(
        `SELECT
           count(job_id) FILTER (WHERE tenant_id = $1)::text AS jobs,
           COALESCE(sum(request_bytes) FILTER (WHERE tenant_id = $1),0)::text AS bytes,
           count(job_id)::text AS global_jobs,
           COALESCE(sum(request_bytes),0)::text AS global_bytes
         FROM hosted_prove_jobs WHERE status IN ('QUEUED','LEASED')`,
        [input.tenantId],
      )
      const tenantRow = tenant.rows[0]
      const countRow = counts.rows[0] ?? { jobs: '0', bytes: '0', global_jobs: '0', global_bytes: '0' }
      if (!tenantRow?.active) throw new HostedAuthError('tenant is inactive or unknown')
      if (BigInt(countRow.jobs) >= BigInt(tenantRow.limits.maxQueuedJobs)) {
        throw new Error('tenant queued-job cap reached')
      }
      if (BigInt(countRow.bytes) + BigInt(input.requestBytes) > BigInt(tenantRow.limits.maxQueuedBytes)) {
        throw new Error('tenant queued-byte cap reached')
      }
      if (BigInt(countRow.global_jobs) >= 100_000n || BigInt(countRow.global_bytes) + BigInt(input.requestBytes) > 1_099_511_627_776n) {
        throw new Error('global queue capacity reached')
      }
      const profile = await client.query<{
        needs_gpu: boolean
        estimated_work: string
        estimated_proof_time_ms: string
        settlement_margin_ms: string
      }>(
        `SELECT needs_gpu, estimated_work::text, estimated_proof_time_ms::text,
                settlement_margin_ms::text
         FROM hosted_proof_profiles
         WHERE proof_class = $1 AND endpoint = $2 FOR SHARE`,
        [input.proofClass, input.endpoint],
      )
      const estimate = profile.rows[0]
      if (!estimate) throw new Error('no verified scheduling profile exists for this proof class and endpoint')
      if (retryOfJobId !== null) {
        const prior = await client.query<{
          tenant_id: string;room_id: string | null;allocation_id: string | null
          sponsorship_id: string | null;service_class: string;proof_class: string;endpoint: string
          status: string;canonical_failure: boolean
        }>(
          `SELECT job.tenant_id,job.room_id::text,job.allocation_id,job.sponsorship_id,
                  job.service_class,job.proof_class,job.endpoint,job.status,
                  EXISTS (
                    SELECT 1 FROM hosted_aggregate_billing_members AS member
                    JOIN hosted_aggregate_outcome_receipts AS receipt
                      ON receipt.chain_id=member.chain_id
                     AND receipt.aggregate_hash=member.aggregate_hash
                     AND receipt.member_index=member.member_index
                     AND NOT receipt.applied
                    JOIN hosted_indexer_facts AS fact
                      ON fact.fact_id=receipt.source_fact_id AND fact.canonical
                    JOIN hosted_canonical_floors AS floor
                      ON floor.chain_id=fact.chain_id AND fact.block_number <= floor.block_number
                    LEFT JOIN hosted_aggregate_outcome_retractions AS retraction
                      ON retraction.receipt_id=receipt.receipt_id
                    WHERE member.job_id=job.job_id AND retraction.retraction_id IS NULL
                  ) AS canonical_failure
           FROM hosted_prove_jobs AS job
           WHERE job.job_id=$1 FOR SHARE OF job`,
          [retryOfJobId],
        )
        const previous = prior.rows[0]
        if (
          !previous || previous.tenant_id !== input.tenantId || previous.room_id !== input.roomId
          || previous.allocation_id !== input.allocationId
          || previous.sponsorship_id !== input.sponsorshipId
          || previous.service_class !== input.serviceClass || previous.proof_class !== input.proofClass
          || previous.endpoint !== input.endpoint || previous.status !== 'DONE'
          || !previous.canonical_failure
        ) throw new Error('retryOfJobId is not the exact finalized failed member job')
        if (input.sponsorshipId !== null) {
          const priorReservation = await client.query<{ status: string }>(
            `SELECT status FROM hosted_sponsorship_reservations
             WHERE job_id=$1 AND sponsorship_id=$2 FOR UPDATE`,
            [retryOfJobId,input.sponsorshipId],
          )
          if (priorReservation.rows[0]?.status !== 'RELEASED') {
            throw new Error('retryOfJobId sponsorship effect is not released and retryable')
          }
        }
      }
      let payerTenantId: string | null = null
      let quotePriceId: string | null = null
      let quoteUnitPrice: string | null = null
      let quoteCurrency: string | null = null
      let quoteEffectiveFrom: string | null = null
      let quoteAcceptedAt: string | null = null
      let quoteSlaPolicyId: string | null = null
      let quoteSlaEffectiveFrom: string | null = null

      let sponsorTenantId: string | null = null
      if (input.sponsorshipId) {
        const sponsorship = await client.query<{
          sponsor_tenant_id: string; beneficiary_tenant_id: string; allocation_id: string | null
          unit: string; active: boolean; expired: boolean
          maximum_quantity: string; consumed_quantity: string; reserved_quantity: string
        }>(
          `SELECT sponsor_tenant_id,beneficiary_tenant_id,allocation_id,unit,active,
                  (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS expired,
                  maximum_quantity::text,consumed_quantity::text,reserved_quantity::text
           FROM hosted_sponsorships WHERE sponsorship_id=$1 FOR UPDATE`, [input.sponsorshipId],
        )
        const terms = sponsorship.rows[0]
        if (
          !terms || !terms.active || terms.beneficiary_tenant_id !== input.tenantId
          || terms.unit !== 'proof-work'
          || (terms.allocation_id !== null && terms.allocation_id !== input.allocationId)
          || terms.expired
        ) throw new HostedAuthError('sponsorship unit, allocation, expiry, activity, or beneficiary does not match the job')
        const capacity = await client.query<{ allowed: boolean }>(
          `SELECT $1::numeric + $2::numeric + $3::numeric <= $4::numeric AS allowed`,
          [terms.consumed_quantity, terms.reserved_quantity, estimate.estimated_work, terms.maximum_quantity],
        )
        if (!capacity.rows[0]!.allowed) throw new HostedAuthError('sponsorship is exhausted')
        sponsorTenantId = terms.sponsor_tenant_id
      }

      if (maximumChargeAmount !== null) {
        payerTenantId = sponsorTenantId ?? input.tenantId
        const price = await client.query<{
          price_id: string; unit_price: string; currency: string
          effective_from: string; accepted_at: string
        }>(
          `SELECT price_id::text,unit_price::text,currency,effective_from::text,
                  clock_timestamp()::text AS accepted_at
           FROM hosted_billing_prices
           WHERE tenant_id=$1 AND unit='proof-work' AND effective_from <= clock_timestamp()
           ORDER BY effective_from DESC,price_id DESC LIMIT 1 FOR SHARE`, [payerTenantId],
        )
        const accepted = price.rows[0]
        if (!accepted) throw new Error('billable proof job requires an effective immutable price quote')
        if (accepted.currency !== maximumChargeCurrency) throw new Error('maximum charge currency differs from the effective quote')
        const bounded = await client.query<{ allowed: boolean }>(
          `SELECT $1::numeric * $2::numeric <= $3::numeric AS allowed`,
          [estimate.estimated_work, accepted.unit_price, maximumChargeAmount],
        )
        if (!bounded.rows[0]!.allowed) throw new Error('effective quote exceeds the accepted maximum charge')
        quotePriceId = accepted.price_id
        quoteUnitPrice = accepted.unit_price
        quoteCurrency = accepted.currency
        quoteEffectiveFrom = accepted.effective_from
        quoteAcceptedAt = accepted.accepted_at
        const policy = await client.query<{ policy_id: string; effective_from: string }>(
          `SELECT policy_id::text,effective_from::text FROM hosted_sla_policies
           WHERE tenant_id=$1 AND service_class=$2 AND effective_from <= $3
           ORDER BY effective_from DESC,policy_id DESC LIMIT 1 FOR SHARE`,
          [payerTenantId, input.serviceClass, quoteAcceptedAt],
        )
        quoteSlaPolicyId = policy.rows[0]?.policy_id ?? null
        quoteSlaEffectiveFrom = policy.rows[0]?.effective_from ?? null
      }
      const workWindowMs = BigInt(estimate.estimated_proof_time_ms) + BigInt(estimate.settlement_margin_ms)
      let deadlineAt = input.deadlineAt
      let latestStartAt: string | null = null
      if (deadlineAt !== null) {
        const projected = Date.parse(deadlineAt) - Number(workWindowMs)
        latestStartAt = Number.isFinite(projected) && Math.abs(projected) <= 8_640_000_000_000_000
          ? new Date(projected).toISOString()
          : null
      }
      let deadlineTrusted = false
      let deadlineChainId: string | null = null
      let deadlineBlock: string | null = null
      let latestStartBlock: string | null = null
      let deadlineFactKey: string | null = null
      let deadlineFactBlockHash: string | null = null

      // Global urgency is derived only from an indexed AllocationUsed or
      // AllocationRenewed event belonging to this tenant/room/allocation. A
      // client deadline remains a tenant-local EDF hint and can never set the
      // trusted bit. Row locks bind the fact and canonical timing sample until
      // the job insert commits, closing a rollback/reorg TOCTOU window.
      if (input.roomId !== null && input.allocationId !== null) {
        const canonicalDeadline = await client.query<{
          fact_key: string
          block_hash: string
          deadline_block: string
        }>(
          `SELECT fact.fact_key,fact.block_hash,
                  (fact.payload #>> '{args,proofDeadlineBlock}')::numeric::text AS deadline_block
           FROM hosted_indexer_facts AS fact
           LEFT JOIN hosted_room_observations AS observation
             ON observation.chain_id=fact.chain_id AND observation.room_id=fact.room_id
           WHERE fact.chain_id=$1 AND fact.room_id=$2 AND fact.canonical
             AND COALESCE(fact.tenant_id,observation.tenant_id)=$3
             AND fact.payload #>> '{args,proofDeadlineBlock}' ~ '^[0-9]+$'
             AND (
               (fact.payload #>> '{provenance,eventName}'='AllocationUsed'
                 AND lower(fact.payload #>> '{args,allocationId}')=lower($4))
               OR
               (fact.payload #>> '{provenance,eventName}'='AllocationRenewed'
                 AND lower(fact.payload #>> '{args,newAllocationId}')=lower($4))
             )
           ORDER BY fact.block_number DESC,fact.fact_id DESC
           LIMIT 1 FOR SHARE OF fact`,
          [input.chainId, input.roomId, input.tenantId, input.allocationId],
        )
        const source = canonicalDeadline.rows[0]
        if (source) {
          const timing = await client.query<{ block_number: string; observed_at: string }>(
            `SELECT block_number::text,observed_at::text
             FROM canonical_l1_blocks
             WHERE chain_id=$1 AND canonical
             ORDER BY block_number DESC LIMIT 64 FOR SHARE`,
            [input.chainId],
          )
          let elapsedMs = 0
          let elapsedBlocks = 0n
          for (let index = 0; index + 1 < timing.rows.length; index += 1) {
            const newer = timing.rows[index]!
            const older = timing.rows[index + 1]!
            const blockDelta = BigInt(newer.block_number) - BigInt(older.block_number)
            const timeDelta = Date.parse(newer.observed_at) - Date.parse(older.observed_at)
            if (blockDelta > 0n && timeDelta > 0 && Number.isFinite(timeDelta)) {
              elapsedBlocks += blockDelta
              elapsedMs += timeDelta
            }
          }
          const head = timing.rows[0]
          if (head && elapsedBlocks > 0n && elapsedMs > 0) {
            const measured = Math.ceil(elapsedMs / Number(elapsedBlocks))
            const blockTimeMs = BigInt(Math.max(1_000, Math.min(60_000, measured)))
            const canonicalDeadlineBlock = BigInt(source.deadline_block)
            const headBlock = BigInt(head.block_number)
            const remaining = canonicalDeadlineBlock - headBlock
            if (remaining >= -1_000_000n && remaining <= 10_000_000n) {
              const projectedDeadlineMs = BigInt(Date.parse(head.observed_at)) + remaining * blockTimeMs
              const projectedLatestStartMs = projectedDeadlineMs - workWindowMs
              const deadlineMs = Number(projectedDeadlineMs)
              const latestMs = Number(projectedLatestStartMs)
              if (
                Number.isSafeInteger(deadlineMs) && Number.isSafeInteger(latestMs)
                && Math.abs(deadlineMs) <= 8_640_000_000_000_000
                && Math.abs(latestMs) <= 8_640_000_000_000_000
              ) {
                const requiredBlocks = (workWindowMs + blockTimeMs - 1n) / blockTimeMs
                deadlineAt = new Date(deadlineMs).toISOString()
                latestStartAt = new Date(latestMs).toISOString()
                deadlineTrusted = true
                deadlineChainId = String(input.chainId)
                deadlineBlock = canonicalDeadlineBlock.toString()
                latestStartBlock = canonicalDeadlineBlock > requiredBlocks
                  ? (canonicalDeadlineBlock - requiredBlocks).toString()
                  : '0'
                deadlineFactKey = source.fact_key
                deadlineFactBlockHash = source.block_hash.toLowerCase()
              }
            }
          }
        }
      }
      if (input.partition === 'reserved') {
        const capacity = await client.query(
          `SELECT 1 FROM hosted_capacity_intents
           WHERE allocation_id = $1 AND tenant_id = $2
             AND desired_state IN ('RESERVED','ACTIVE','RENEW','HANDOFF')`,
          [input.allocationId, input.tenantId],
        )
        if (!input.allocationId || capacity.rowCount !== 1) throw new HostedAuthError('reserved job lacks an active tenant allocation')
      }
      if (input.sponsorshipId) {
        const sponsorship = await client.query(
          `UPDATE hosted_sponsorships SET reserved_quantity=reserved_quantity+$2::numeric,
             updated_at=clock_timestamp()
           WHERE sponsorship_id=$1
             AND consumed_quantity+reserved_quantity+$2::numeric <= maximum_quantity`,
          [input.sponsorshipId, estimate.estimated_work],
        )
        if (sponsorship.rowCount !== 1) throw new HostedAuthError('sponsorship capacity changed before reservation')
      }
      const inserted = await client.query<HostedProveJobRow>(
        `INSERT INTO hosted_prove_jobs(
           job_id, tenant_id, room_id, allocation_id, sponsorship_id,
           service_class, correlation_id, partition, proof_class, endpoint,
           needs_gpu, idempotency_key, request_hash, request_object_key,
           request_bytes, estimated_work, estimated_proof_time_ms, deadline_at,
           payer_tenant_id,quote_price_id,quote_unit_price,quote_currency,
           quote_effective_from,quote_accepted_at,maximum_charge_amount,maximum_charge_currency,
           quote_sla_policy_id,quote_sla_effective_from,
           latest_start_at, deadline_trusted, deadline_chain_id,deadline_block,
           latest_start_block,deadline_fact_key,deadline_fact_block_hash,
           settlement_margin_ms, priority, tenant_weight, max_attempts, status,retry_of_job_id
           ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
           $37,$38,$39,'QUEUED',$40
         ) RETURNING ${PROVE_JOB_COLUMNS}`,
        [
          input.jobId, input.tenantId, input.roomId, input.allocationId,
          input.sponsorshipId, input.serviceClass, input.correlationId,
          input.partition, input.proofClass, input.endpoint, estimate.needs_gpu,
          input.idempotencyKey, input.requestHash, input.requestObjectKey,
          input.requestBytes, estimate.estimated_work, estimate.estimated_proof_time_ms,
          deadlineAt,payerTenantId,quotePriceId,quoteUnitPrice,quoteCurrency,
          quoteEffectiveFrom,quoteAcceptedAt,maximumChargeAmount,maximumChargeCurrency,
          quoteSlaPolicyId,quoteSlaEffectiveFrom,
          latestStartAt, deadlineTrusted, deadlineChainId, deadlineBlock,
          latestStartBlock, deadlineFactKey, deadlineFactBlockHash,
          estimate.settlement_margin_ms, input.priority, tenantRow.limits.queueWeight, maxAttempts,
          retryOfJobId,
        ],
      )
      if (input.sponsorshipId) {
        await client.query(
          `INSERT INTO hosted_sponsorship_reservations(
             job_id, sponsorship_id, tenant_id,allocation_id,unit,quantity,status
           ) VALUES ($1,$2,$3,$4,'proof-work',$5,'RESERVED')`,
          [input.jobId, input.sponsorshipId, input.tenantId,input.allocationId,estimate.estimated_work],
        )
      }
      await this.outbox(client, input.tenantId, 'prove-job.queued', input.jobId, {
        roomId: input.roomId,
        allocationId: input.allocationId,
        sponsorshipId: input.sponsorshipId,
        retryOfJobId,
        proofClass: input.proofClass,
        partition: input.partition,
      })
      return { job: proveJob(inserted.rows[0]!), already: false }
    })
  }

  async getProveJob(jobId: string, tenantId?: string): Promise<HostedProveJob | null> {
    const result = await this.pool.query<HostedProveJobRow>(
      `SELECT ${PROVE_JOB_COLUMNS} FROM hosted_prove_jobs
       WHERE job_id = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
      [jobId, tenantId ?? null],
    )
    return result.rows[0] ? proveJob(result.rows[0]) : null
  }

  async listProveJobs(tenantId: string, limit = 200): Promise<HostedProveJob[]> {
    const result = await this.pool.query<HostedProveJobRow>(
      `SELECT ${PROVE_JOB_COLUMNS} FROM hosted_prove_jobs
       WHERE tenant_id = $1 ORDER BY enqueued_at DESC LIMIT $2`,
      [tenantId, Math.max(1, Math.min(limit, 1_000))],
    )
    return result.rows.map(proveJob)
  }

  async leaseProveJob(
    fence: CoordinatorFence,
    principalId: string,
  ): Promise<HostedProveJob | null> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const assignmentResult = await client.query<{
        active: boolean
        gpu: boolean
        gpu_resource_id: string | null
        partitions: string[]
        tenant_ids: string[]
        allocation_ids: string[]
        proof_classes: string[]
        max_concurrent_jobs: number
        lease_ttl_ms: string
      }>(
        `SELECT active, gpu, gpu_resource_id, partitions, tenant_ids, allocation_ids, proof_classes,
                max_concurrent_jobs, lease_ttl_ms::text
         FROM hosted_provider_nodes WHERE principal_id = $1 FOR UPDATE`,
        [principalId],
      )
      const assignment = assignmentResult.rows[0]
      if (!assignment?.active) throw new HostedAuthError('node has no active server-side provider assignment')
      const reclaimed = await client.query<{
        job_id: string
        status: HostedProveJob['status']
        sponsorship_id: string | null
      }>(
        `UPDATE hosted_prove_jobs SET
           status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
           error_code = CASE WHEN attempts >= max_attempts THEN 'LEASE_EXHAUSTED' ELSE 'LEASE_EXPIRED' END,
           lease_owner = NULL, lease_expires_at = NULL, fence_token = NULL,
           updated_at = clock_timestamp()
         WHERE status = 'LEASED'
           AND (lease_expires_at <= clock_timestamp() OR fence_token <> $1)
         RETURNING job_id, status, sponsorship_id`,
        [fence.token.toString()],
      )
      if (reclaimed.rows.length > 0) {
        await client.query(
          'DELETE FROM hosted_gpu_resource_leases WHERE job_id = ANY($1::text[])',
          [reclaimed.rows.map((row) => row.job_id)],
        )
      }
      for (const expired of reclaimed.rows) {
        if (expired.status !== 'FAILED' || !expired.sponsorship_id) continue
        await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity = sponsorship.reserved_quantity - reserved.quantity,
             updated_at = clock_timestamp()
           FROM hosted_sponsorship_reservations AS reserved
           WHERE reserved.job_id = $1 AND reserved.status = 'RESERVED'
             AND sponsorship.sponsorship_id = reserved.sponsorship_id`,
          [expired.job_id],
        )
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status = 'RELEASED',
             updated_at = clock_timestamp() WHERE job_id = $1 AND status = 'RESERVED'`,
          [expired.job_id],
        )
      }
      if (assignment.gpu_resource_id) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-gpu:' || $1))", [assignment.gpu_resource_id])
      }
      await client.query('DELETE FROM hosted_gpu_resource_leases WHERE expires_at <= clock_timestamp()')
      const active = await client.query<{ total: string; gpu: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE needs_gpu)::text AS gpu
         FROM hosted_prove_jobs WHERE status = 'LEASED' AND lease_owner = $1`,
        [principalId],
      )
      if (Number(active.rows[0]?.total ?? '0') >= assignment.max_concurrent_jobs) return null
      const resourceBusy = assignment.gpu_resource_id
        ? await client.query(
            'SELECT 1 FROM hosted_gpu_resource_leases WHERE resource_id = $1',
            [assignment.gpu_resource_id],
          )
        : { rowCount: 0 }
      const canTakeGpu = assignment.gpu
        && assignment.gpu_resource_id !== null
        && active.rows[0]?.gpu === '0'
        && resourceBusy.rowCount === 0
      const selected = await client.query<HostedProveJobRow>(
        `WITH eligible AS (
           SELECT job.job_id,job.tenant_id,job.deadline_at,job.latest_start_at,
                  job.deadline_trusted,job.aging_started_at,job.priority,
                  job.deadline_block,job.latest_start_block,
                  job.estimated_work,job.tenant_weight,job.enqueued_at,
                  (
                    job.deadline_trusted
                    AND EXISTS (
                      SELECT 1 FROM hosted_indexer_facts AS fact
                      WHERE fact.chain_id=job.deadline_chain_id
                        AND fact.fact_key=job.deadline_fact_key
                        AND lower(fact.block_hash)=lower(job.deadline_fact_block_hash)
                        AND fact.canonical AND fact.room_id=job.room_id
                        AND COALESCE(
                          fact.tenant_id,
                          (SELECT observation.tenant_id FROM hosted_room_observations AS observation
                           WHERE observation.chain_id=fact.chain_id AND observation.room_id=fact.room_id)
                        )=job.tenant_id
                        AND fact.payload #>> '{args,proofDeadlineBlock}'=job.deadline_block::text
                        AND (
                          (fact.payload #>> '{provenance,eventName}'='AllocationUsed'
                            AND lower(fact.payload #>> '{args,allocationId}')=lower(job.allocation_id))
                          OR
                          (fact.payload #>> '{provenance,eventName}'='AllocationRenewed'
                            AND lower(fact.payload #>> '{args,newAllocationId}')=lower(job.allocation_id))
                        )
                    )
                    AND EXISTS (
                      SELECT 1 FROM canonical_l1_blocks AS head
                      WHERE head.chain_id=job.deadline_chain_id AND head.canonical
                        AND head.block_number >= job.latest_start_block
                    )
                  ) AS canonical_deadline_urgent,
                  row_number() OVER (
                    PARTITION BY job.tenant_id
                    ORDER BY job.deadline_at ASC NULLS LAST,
                             job.priority DESC,job.enqueued_at ASC,job.job_id ASC
                  ) AS tenant_deadline_rank
           FROM hosted_prove_jobs AS job
           WHERE job.status = 'QUEUED'
             AND job.partition = ANY($2::text[])
             AND job.proof_class = ANY($3::text[])
             AND (NOT job.needs_gpu OR $4::boolean)
             AND (
               job.partition = 'shared'
               OR (job.partition = 'reserved' AND job.allocation_id = ANY($5::text[]))
               OR (job.partition = 'dedicated' AND job.tenant_id = ANY($6::text[]))
             )
         ), tenant_heads AS (
           SELECT * FROM eligible WHERE tenant_deadline_rank=1
         ), candidate AS (
           SELECT job.job_id
           FROM tenant_heads AS head
           JOIN hosted_prove_jobs AS job ON job.job_id=head.job_id
           LEFT JOIN hosted_tenant_scheduler_state AS state ON state.tenant_id=head.tenant_id
           CROSS JOIN hosted_scheduler_global_state AS global_state
           ORDER BY
             head.canonical_deadline_urgent DESC,
             CASE WHEN head.canonical_deadline_urgent THEN head.deadline_block END ASC NULLS LAST,
             (clock_timestamp() - head.aging_started_at >= interval '15 minutes') DESC,
             (GREATEST(COALESCE(state.virtual_service, global_state.virtual_time), global_state.virtual_time)
               + head.estimated_work / head.tenant_weight) ASC,
             (head.priority + LEAST(100, floor(extract(epoch FROM (clock_timestamp() - head.aging_started_at)) / 60)::integer)) DESC,
             head.deadline_at ASC NULLS LAST,
             head.enqueued_at ASC,head.job_id ASC
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         )
         UPDATE hosted_prove_jobs AS job SET
           status = 'LEASED', lease_owner = $1,
           lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
           leased_at = clock_timestamp(),
           actual_queue_ms = floor(extract(epoch FROM (clock_timestamp() - enqueued_at)) * 1000)::bigint,
           fence_token = $8, attempts = attempts + 1, updated_at = clock_timestamp()
         FROM candidate WHERE job.job_id = candidate.job_id
         RETURNING job.*`,
        [
          principalId, assignment.partitions, assignment.proof_classes,
          canTakeGpu, assignment.allocation_ids, assignment.tenant_ids,
          assignment.lease_ttl_ms, fence.token.toString(),
        ],
      )
      const row = selected.rows[0]
      if (!row) return null
      if (row.needs_gpu) {
        await client.query(
          `INSERT INTO hosted_gpu_resource_leases(
             resource_id, principal_id, job_id, expires_at, fence_token
           ) VALUES ($1,$2,$3,$4,$5)`,
          [assignment.gpu_resource_id, principalId, row.job_id, row.lease_expires_at, fence.token.toString()],
        )
      }
      await client.query(
        `INSERT INTO hosted_tenant_scheduler_state(tenant_id, virtual_service)
         SELECT $1, GREATEST(COALESCE(state.virtual_service, global_state.virtual_time), global_state.virtual_time)
                    + $2::numeric / $3::numeric
         FROM hosted_scheduler_global_state AS global_state
         LEFT JOIN hosted_tenant_scheduler_state AS state ON state.tenant_id = $1
         ON CONFLICT (tenant_id) DO UPDATE SET
           virtual_service = EXCLUDED.virtual_service,
           updated_at = clock_timestamp()`,
        [row.tenant_id, row.estimated_work, row.tenant_weight],
      )
      await client.query(
        `UPDATE hosted_scheduler_global_state SET
           virtual_time = GREATEST(virtual_time, (
             SELECT min(virtual_service) FROM hosted_tenant_scheduler_state
           )), updated_at = clock_timestamp()
         WHERE singleton`,
      )
      await this.outbox(client, row.tenant_id, 'prove-job.leased', row.job_id, {
        nodeId: principalId,
        leaseExpiresAt: proveJob(row).leaseExpiresAt,
        attempts: row.attempts,
      })
      return proveJob(row)
    })
  }

  async heartbeatProveJob(
    fence: CoordinatorFence,
    jobId: string,
    principalId: string,
  ): Promise<HostedProveJob> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<HostedProveJobRow>(
        `UPDATE hosted_prove_jobs AS job SET
           lease_expires_at = clock_timestamp() + (assignment.lease_ttl_ms * interval '1 millisecond'),
           updated_at = clock_timestamp()
         FROM hosted_provider_nodes AS assignment
         WHERE job.job_id = $1 AND job.status = 'LEASED'
           AND job.lease_owner = $2 AND job.lease_expires_at > clock_timestamp()
           AND job.fence_token = $3
           AND assignment.principal_id = $2 AND assignment.active
         RETURNING ${PROVE_JOB_COLUMNS}`,
        [jobId, principalId, fence.token.toString()],
      )
      if (!result.rows[0]) throw new HostedAuthError('job is not actively leased by this node')
      if (result.rows[0].needs_gpu) {
        const resource = await client.query(
          `UPDATE hosted_gpu_resource_leases SET expires_at = $4, updated_at = clock_timestamp()
           WHERE job_id = $1 AND principal_id = $2 AND fence_token = $3`,
          [jobId, principalId, fence.token.toString(), result.rows[0].lease_expires_at],
        )
        if (resource.rowCount !== 1) throw new HostedAuthError('GPU resource lease is missing or fenced')
      }
      return proveJob(result.rows[0])
    })
  }

  async completeProveJob(
    fence: CoordinatorFence,
    jobId: string,
    principalId: string,
    resultObjectKey: string,
    resultSha256: string,
  ): Promise<{ job: HostedProveJob; already: boolean }> {
    if (!/^[0-9a-f]{64}$/.test(resultSha256) || !resultObjectKey.endsWith(resultSha256)) {
      throw new Error('result object key is not bound to its content digest')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const locked = await client.query<HostedProveJobRow>(
        `SELECT ${PROVE_JOB_COLUMNS} FROM hosted_prove_jobs WHERE job_id = $1 FOR UPDATE`,
        [jobId],
      )
      const current = locked.rows[0]
      if (!current) throw new HostedAuthError('prove job not found')
      if (current.status === 'DONE') {
        if (current.result_object_key !== resultObjectKey || current.result_digest !== resultSha256) {
          throw new Error('completed job result is immutable')
        }
        return { job: proveJob(current), already: true }
      }
      const updated = await client.query<HostedProveJobRow & {
        actual_queue_ms: string | null
        actual_proof_ms: string | null
      }>(
        `UPDATE hosted_prove_jobs SET status = 'DONE', result_object_key = $4,result_digest=$5,
           finished_at = clock_timestamp(),
           actual_proof_ms = COALESCE(actual_proof_ms,0)
             + GREATEST(0,floor(extract(epoch FROM (clock_timestamp() - leased_at)) * 1000)::bigint),
           leased_at = NULL, lease_owner = NULL, lease_expires_at = NULL, fence_token = NULL,
           error_code = NULL, updated_at = clock_timestamp()
         WHERE job_id = $1 AND status = 'LEASED' AND lease_owner = $2
           AND lease_expires_at > clock_timestamp() AND fence_token = $3
         RETURNING *`,
        [jobId, principalId, fence.token.toString(), resultObjectKey,resultSha256],
      )
      const completed = updated.rows[0]
      if (!completed) throw new HostedAuthError('job lease expired, changed owner, or was fenced')
      // Proof completion is resource telemetry, not settlement success. Keep
      // any sponsorship quantity RESERVED until the owner indexer observes a
      // canonical AggregateMemberOutcome(applied=true) below the independently
      // agreed finalized/archive floor. This closes the stale/closed-member
      // overcharge bug for partially applied aggregates.
      await client.query(
        `INSERT INTO hosted_usage_ledger(
           tenant_id, allocation_id, job_id, room_id, unit, quantity,
           observed_at, idempotency_key, metadata
         ) VALUES
           ($1,$2,$3,$4,'telemetry.proof-work',$5,clock_timestamp(),$6,$9::jsonb),
           ($1,$2,$3,$4,'telemetry.queue-second',$7::numeric / 1000,clock_timestamp(),$10,$9::jsonb),
           ($1,$2,$3,$4,'telemetry.proof-second',$8::numeric / 1000,clock_timestamp(),$11,$9::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          current.tenant_id, current.allocation_id, current.job_id, current.room_id,
          current.estimated_work, `prove:${current.job_id}:success`,
          completed.actual_queue_ms ?? '0', completed.actual_proof_ms ?? '0',
          JSON.stringify({
            proofClass: current.proof_class,
            attempts: current.attempts,
            resultObjectKey,
            resultSha256,
            billingState: 'PROVISIONAL_RESOURCE_TELEMETRY',
          }),
          `prove:${current.job_id}:queue-seconds`,
          `prove:${current.job_id}:proof-seconds`,
        ],
      )
      if (current.needs_gpu) {
        await client.query(
          `INSERT INTO hosted_usage_ledger(
           tenant_id, allocation_id, job_id, room_id, unit, quantity,
           observed_at, idempotency_key, metadata
           ) VALUES ($1,$2,$3,$4,'telemetry.gpu-second',$5::numeric / 1000,
             clock_timestamp(),$6,$7::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            current.tenant_id, current.allocation_id, current.job_id, current.room_id,
            completed.actual_proof_ms ?? '0', `prove:${current.job_id}:gpu-seconds`,
            JSON.stringify({
              proofClass: current.proof_class,
              resultSha256,
              billingState: 'PROVISIONAL_RESOURCE_TELEMETRY',
            }),
          ],
        )
        const released = await client.query(
          `DELETE FROM hosted_gpu_resource_leases
           WHERE job_id = $1 AND principal_id = $2 AND fence_token = $3`,
          [jobId, principalId, fence.token.toString()],
        )
        if (released.rowCount !== 1) throw new HostedAuthError('GPU resource lease is missing or fenced')
      }
      await this.outbox(client, current.tenant_id, 'prove-job.completed', jobId, {
        resultObjectKey,
        resultSha256,
        usageUnit: 'telemetry.proof-work',
        usageQuantity: current.estimated_work,
        billingState: 'AWAITING_FINALIZED_MEMBER_OUTCOME',
        queueMs: completed.actual_queue_ms,
        proofMs: completed.actual_proof_ms,
      })
      return { job: proveJob(completed), already: false }
    })
  }

  async failProveJob(
    fence: CoordinatorFence,
    jobId: string,
    principalId: string,
    code: string,
    retryable: boolean,
  ): Promise<HostedProveJob> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<HostedProveJobRow>(
        `UPDATE hosted_prove_jobs SET
           status = CASE WHEN $4::boolean AND attempts < max_attempts THEN 'QUEUED' ELSE 'FAILED' END,
           error_code = $3,
           actual_proof_ms = COALESCE(actual_proof_ms,0)
             + GREATEST(0,floor(extract(epoch FROM (clock_timestamp() - leased_at)) * 1000)::bigint),
           leased_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
           fence_token = NULL, updated_at = clock_timestamp()
         WHERE job_id = $1 AND status = 'LEASED' AND lease_owner = $2
           AND lease_expires_at > clock_timestamp() AND fence_token = $5
         RETURNING ${PROVE_JOB_COLUMNS}`,
        [jobId, principalId, code.slice(0, 200), retryable, fence.token.toString()],
      )
      const row = result.rows[0]
      if (!row) throw new HostedAuthError('job is not actively leased by this node')
      if (row.needs_gpu) {
        const released = await client.query(
          `DELETE FROM hosted_gpu_resource_leases
           WHERE job_id = $1 AND principal_id = $2 AND fence_token = $3`,
          [jobId, principalId, fence.token.toString()],
        )
        if (released.rowCount !== 1) throw new HostedAuthError('GPU resource lease is missing or fenced')
      }
      if (row.status === 'FAILED' && row.sponsorship_id) {
        const reservation = await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity = sponsorship.reserved_quantity - reserved.quantity,
             updated_at = clock_timestamp()
           FROM hosted_sponsorship_reservations AS reserved
           WHERE reserved.job_id = $1 AND reserved.status = 'RESERVED'
             AND sponsorship.sponsorship_id = reserved.sponsorship_id`,
          [jobId],
        )
        if (reservation.rowCount !== 1) throw new Error('failed job sponsorship reservation is missing')
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status = 'RELEASED',
             updated_at = clock_timestamp() WHERE job_id = $1 AND status = 'RESERVED'`,
          [jobId],
        )
      }
      await this.outbox(client, row.tenant_id, 'prove-job.failed', row.job_id, {
        code: row.error_code,
        retrying: row.status === 'QUEUED',
        attempts: row.attempts,
      })
      return proveJob(row)
    })
  }

  async sweepProveLeases(fence: CoordinatorFence): Promise<number> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{
        job_id: string
        status: HostedProveJob['status']
        sponsorship_id: string | null
      }>(
        `UPDATE hosted_prove_jobs SET
           status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
           error_code = CASE WHEN attempts >= max_attempts THEN 'LEASE_EXHAUSTED' ELSE 'LEASE_EXPIRED' END,
           actual_proof_ms = COALESCE(actual_proof_ms,0)
             + GREATEST(0,floor(extract(epoch FROM (clock_timestamp() - leased_at)) * 1000)::bigint),
           leased_at = NULL, lease_owner = NULL, lease_expires_at = NULL, fence_token = NULL,
           updated_at = clock_timestamp()
         WHERE status = 'LEASED'
           AND (lease_expires_at <= clock_timestamp() OR fence_token <> $1)
         RETURNING job_id, status, sponsorship_id`,
        [fence.token.toString()],
      )
      if (result.rows.length > 0) {
        await client.query(
          `DELETE FROM hosted_gpu_resource_leases WHERE job_id = ANY($1::text[])`,
          [result.rows.map((row) => row.job_id)],
        )
      }
      for (const row of result.rows) {
        if (row.status !== 'FAILED' || !row.sponsorship_id) continue
        await client.query(
          `UPDATE hosted_sponsorships AS sponsorship SET
             reserved_quantity = sponsorship.reserved_quantity - reserved.quantity,
             updated_at = clock_timestamp()
           FROM hosted_sponsorship_reservations AS reserved
           WHERE reserved.job_id = $1 AND reserved.status = 'RESERVED'
             AND sponsorship.sponsorship_id = reserved.sponsorship_id`,
          [row.job_id],
        )
        await client.query(
          `UPDATE hosted_sponsorship_reservations SET status = 'RELEASED',
             updated_at = clock_timestamp() WHERE job_id = $1 AND status = 'RESERVED'`,
          [row.job_id],
        )
      }
      return result.rowCount ?? 0
    })
  }

  async reconcileCapacity(fence: CoordinatorFence, intent: CapacityIntent): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-capacity:' || $1::text))", [intent.allocationId])
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-capacity-idem:' || $1::text))", [intent.idempotencyKey])
      const replay = await client.query<{
        allocation_id: string
        tenant_id: string
        room_id: string
        desired_state: string
        provider_node_id: string | null
        deadline_at: string | Date | null
        metadata: Record<string, unknown>
      }>(
        `SELECT allocation_id,tenant_id,room_id::text,desired_state,provider_node_id,
                deadline_at,metadata
         FROM hosted_capacity_operations WHERE idempotency_key=$1 FOR SHARE`,
        [intent.idempotencyKey],
      )
      const priorReplay = replay.rows[0]
      if (priorReplay) {
        const deadlineMatches = priorReplay.deadline_at === null
          ? intent.deadlineAt === null
          : intent.deadlineAt !== null
            && canonicalTimestamp(priorReplay.deadline_at) === canonicalTimestamp(intent.deadlineAt)
        if (
          priorReplay.allocation_id !== intent.allocationId
          || priorReplay.tenant_id !== intent.tenantId
          || priorReplay.room_id !== intent.roomId
          || priorReplay.desired_state !== intent.desiredState
          || priorReplay.provider_node_id !== intent.providerNodeId
          || !deadlineMatches
          || canonicalJson(priorReplay.metadata) !== canonicalJson(intent.metadata)
        ) throw new Error('capacity idempotency key is bound to a different immutable operation')
        return
      }

      const current = await client.query<{
        tenant_id: string
        room_id: string
        idempotency_key: string
      }>(
        `SELECT tenant_id,room_id::text,idempotency_key FROM hosted_capacity_intents
         WHERE allocation_id=$1 FOR UPDATE`,
        [intent.allocationId],
      )
      const active = current.rows[0]
      if (active) {
        if (active.tenant_id !== intent.tenantId || active.room_id !== intent.roomId) {
          throw new Error('capacity allocation cannot be rebound to another tenant or room')
        }
        if (intent.previousIdempotencyKey !== active.idempotency_key) {
          throw new Error('capacity state transition must name the prior idempotency key')
        }
      } else if (intent.previousIdempotencyKey) {
        throw new Error('initial capacity intent cannot name a prior operation')
      }
      const priorOperation = active
        ? await client.query<{ operation_id: string }>(
            'SELECT operation_id::text FROM hosted_capacity_operations WHERE idempotency_key=$1',
            [active.idempotency_key],
          )
        : null
      await client.query(
        `INSERT INTO hosted_capacity_operations(
           allocation_id,tenant_id,room_id,desired_state,provider_node_id,deadline_at,
           idempotency_key,prior_operation_id,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          intent.allocationId,
          intent.tenantId,
          intent.roomId,
          intent.desiredState,
          intent.providerNodeId,
          intent.deadlineAt,
          intent.idempotencyKey,
          priorOperation?.rows[0]?.operation_id ?? null,
          JSON.stringify(intent.metadata),
        ],
      )
      await client.query(
        `INSERT INTO hosted_capacity_intents(
           allocation_id,tenant_id,room_id,desired_state,provider_node_id,
           deadline_at,idempotency_key,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (allocation_id) DO UPDATE SET
           desired_state=EXCLUDED.desired_state,provider_node_id=EXCLUDED.provider_node_id,
           deadline_at=EXCLUDED.deadline_at,idempotency_key=EXCLUDED.idempotency_key,
           metadata=EXCLUDED.metadata,attempts=0,next_attempt_at=clock_timestamp(),
           execution_status='PENDING',provider_operation_id=NULL,provider_response=NULL,
           lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,alerted_at=NULL,
           updated_at=clock_timestamp()`,
        [
          intent.allocationId, intent.tenantId, intent.roomId, intent.desiredState,
          intent.providerNodeId, intent.deadlineAt, intent.idempotencyKey,
          JSON.stringify(intent.metadata),
        ],
      )
      await this.outbox(client, intent.tenantId, 'capacity.intent', intent.allocationId, {
        desiredState: intent.desiredState,
        roomId: intent.roomId,
        providerNodeId: intent.providerNodeId,
        deadlineAt: intent.deadlineAt,
      })
    })
  }

  /**
   * Lease explicit tenant capacity operations in deadline order. The lease is
   * DB-clock based and bound to both the coordinator epoch and a monotonic row
   * token; a restarted or promoted worker therefore cannot acknowledge work
   * owned by an old process.
   */
  async leaseCapacityExecutions(
    fence: CoordinatorFence,
    workerId: string,
    limit = 20,
    leaseTtlMs = 30_000,
  ): Promise<CapacityExecutionLease[]> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(workerId)) {
      throw new Error('capacity worker id is invalid')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('capacity execution lease limit must be from 1 through 200')
    }
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 5_000 || leaseTtlMs > 5 * 60_000) {
      throw new Error('capacity execution lease TTL must be from five seconds through five minutes')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{
        allocation_id: string
        tenant_id: string
        room_id: string
        desired_state: CapacityIntent['desiredState']
        provider_node_id: string | null
        deadline_at: string | Date | null
        idempotency_key: string
        metadata: Record<string, unknown>
        applied_state: CapacityIntent['desiredState'] | null
        provider_operation_id: string | null
        attempts: number
        max_attempts: number
        lease_owner: string
        lease_token: string
        lease_expires_at: string | Date
      }>(
        `WITH candidates AS (
           SELECT allocation_id FROM hosted_capacity_intents
           WHERE attempts < max_attempts
             AND next_attempt_at <= clock_timestamp()
             AND (
               execution_status IN ('PENDING','RETRY')
               OR (execution_status='LEASED' AND lease_expires_at <= clock_timestamp())
             )
           ORDER BY deadline_at ASC NULLS LAST,next_attempt_at,updated_at,allocation_id
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE hosted_capacity_intents AS intent SET
           execution_status='LEASED',lease_owner=$2,lease_token=intent.lease_token+1,
           lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond'),
           attempts=intent.attempts+1,updated_at=clock_timestamp()
         FROM candidates WHERE intent.allocation_id=candidates.allocation_id
         RETURNING intent.allocation_id,intent.tenant_id,intent.room_id::text,
           intent.desired_state,intent.provider_node_id,intent.deadline_at,
           intent.idempotency_key,intent.metadata,intent.applied_state,
           intent.provider_operation_id,intent.attempts,intent.max_attempts,
           intent.lease_owner,intent.lease_token::text,intent.lease_expires_at`,
        [limit, workerId, leaseTtlMs],
      )
      return result.rows.map((row) => ({
        allocationId: row.allocation_id,
        tenantId: row.tenant_id,
        roomId: row.room_id,
        desiredState: row.desired_state,
        providerNodeId: row.provider_node_id,
        deadlineAt: nullableTimestamp(row.deadline_at),
        idempotencyKey: row.idempotency_key,
        metadata: row.metadata,
        executionStatus: 'LEASED' as const,
        appliedState: row.applied_state,
        providerOperationId: row.provider_operation_id,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        leaseExpiresAt: nullableTimestamp(row.lease_expires_at)!,
      }))
    })
  }

  async completeCapacityExecution(
    fence: CoordinatorFence,
    lease: Pick<CapacityExecutionLease, 'allocationId' | 'leaseOwner' | 'leaseToken'>,
    outcome: CapacityProviderResult,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(outcome.providerOperationId)) {
      throw new Error('capacity provider operation id is invalid')
    }
    if (outcome.providerNodeId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(outcome.providerNodeId)) {
      throw new Error('capacity provider node id is invalid')
    }
    if (
      outcome.state === 'PENDING'
      && (!Number.isSafeInteger(outcome.retryAfterMs) || outcome.retryAfterMs! < 1_000 || outcome.retryAfterMs! > 60 * 60_000)
    ) throw new Error('pending capacity result requires retryAfterMs from one second through one hour')
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<{
        tenant_id: string
        desired_state: CapacityIntent['desiredState']
        attempts: number
        live: boolean
      }>(
        `SELECT tenant_id,desired_state,attempts,
                lease_expires_at > clock_timestamp() AS live
         FROM hosted_capacity_intents
         WHERE allocation_id=$1 AND execution_status='LEASED'
           AND lease_owner=$2 AND lease_token=$3 FOR UPDATE`,
        [lease.allocationId, lease.leaseOwner, lease.leaseToken],
      )
      const row = current.rows[0]
      if (!row || !row.live) throw new HostedFenceError('capacity execution lease is absent, expired, or fenced')
      if (outcome.state === 'APPLIED') {
        await client.query(
          `UPDATE hosted_capacity_intents SET
             execution_status='APPLIED',applied_state=desired_state,
             provider_operation_id=$4,provider_node_id=COALESCE($5,provider_node_id),
             provider_response=$6::jsonb,lease_owner=NULL,lease_expires_at=NULL,
             last_error=NULL,last_success_at=clock_timestamp(),alerted_at=NULL,
             updated_at=clock_timestamp()
           WHERE allocation_id=$1 AND lease_owner=$2 AND lease_token=$3
             AND execution_status='LEASED' AND lease_expires_at > clock_timestamp()`,
          [
            lease.allocationId, lease.leaseOwner, lease.leaseToken,
            outcome.providerOperationId, outcome.providerNodeId,
            JSON.stringify(outcome.evidence),
          ],
        )
        await this.outbox(client, row.tenant_id, 'capacity.applied', lease.allocationId, {
          desiredState: row.desired_state,
          providerOperationId: outcome.providerOperationId,
          providerNodeId: outcome.providerNodeId,
          attempts: row.attempts,
        })
      } else {
        await client.query(
          `UPDATE hosted_capacity_intents SET
             execution_status='RETRY',provider_operation_id=$4,provider_response=$5::jsonb,
             next_attempt_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
             lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp()
           WHERE allocation_id=$1 AND lease_owner=$2 AND lease_token=$3
             AND execution_status='LEASED' AND lease_expires_at > clock_timestamp()`,
          [
            lease.allocationId, lease.leaseOwner, lease.leaseToken,
            outcome.providerOperationId, JSON.stringify(outcome.evidence), outcome.retryAfterMs,
          ],
        )
      }
    })
  }

  async failCapacityExecution(
    fence: CoordinatorFence,
    lease: Pick<CapacityExecutionLease, 'allocationId' | 'leaseOwner' | 'leaseToken'>,
    message: string,
    retryAfterMs: number,
    forceTerminal = false,
  ): Promise<{ terminal: boolean; deadlineRisk: boolean }> {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1_000 || retryAfterMs > 60 * 60_000) {
      throw new Error('capacity retry must be from one second through one hour')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const current = await client.query<{
        tenant_id: string
        desired_state: CapacityIntent['desiredState']
        attempts: number
        max_attempts: number
        deadline_risk: boolean
        live: boolean
      }>(
        `SELECT tenant_id,desired_state,attempts,max_attempts,
                deadline_at IS NOT NULL AND deadline_at <=
                  clock_timestamp()+($4::bigint*interval '1 millisecond') AS deadline_risk,
                lease_expires_at > clock_timestamp() AS live
         FROM hosted_capacity_intents
         WHERE allocation_id=$1 AND execution_status='LEASED'
           AND lease_owner=$2 AND lease_token=$3 FOR UPDATE`,
        [lease.allocationId, lease.leaseOwner, lease.leaseToken, retryAfterMs],
      )
      const row = current.rows[0]
      if (!row || !row.live) throw new HostedFenceError('capacity execution lease is absent, expired, or fenced')
      const terminal = forceTerminal || row.attempts >= row.max_attempts
      const alert = terminal || row.deadline_risk
      await client.query(
        `UPDATE hosted_capacity_intents SET
           execution_status=$4,next_attempt_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
           lease_owner=NULL,lease_expires_at=NULL,last_error=$6,
           alerted_at=CASE WHEN $7 THEN COALESCE(alerted_at,clock_timestamp()) ELSE alerted_at END,
           updated_at=clock_timestamp()
         WHERE allocation_id=$1 AND lease_owner=$2 AND lease_token=$3
           AND execution_status='LEASED' AND lease_expires_at > clock_timestamp()`,
        [
          lease.allocationId, lease.leaseOwner, lease.leaseToken,
          terminal ? 'FAILED' : 'RETRY', retryAfterMs, message.slice(0, 500), alert,
        ],
      )
      if (alert) {
        await this.outbox(client, row.tenant_id, 'capacity.alert', lease.allocationId, {
          desiredState: row.desired_state,
          terminal,
          deadlineRisk: row.deadline_risk,
          attempts: row.attempts,
          error: message.slice(0, 200),
        })
        await client.query(
          `INSERT INTO hosted_audit_records(tenant_id,action,target,details)
           VALUES ($1,'capacity.execution.alert',$2,$3::jsonb)`,
          [
            row.tenant_id, lease.allocationId,
            JSON.stringify({ terminal, deadlineRisk: row.deadline_risk, attempts: row.attempts }),
          ],
        )
      }
      return { terminal, deadlineRisk: row.deadline_risk }
    })
  }

  /**
   * Freeze one queue-pressure window before it leaves PostgreSQL. The provider
   * receives a stable idempotency key even if the worker dies after the HTTP
   * request. Stale proof profiles make scale-down fail closed.
   */
  async leaseCapacityDemandSignal(
    fence: CoordinatorFence,
    workerId: string,
    options: { windowMs?: number; horizonMs?: number; leaseTtlMs?: number } = {},
  ): Promise<CapacityDemandSignal | null> {
    const windowMs = options.windowMs ?? 60_000
    const horizonMs = options.horizonMs ?? 5 * 60_000
    const leaseTtlMs = options.leaseTtlMs ?? 30_000
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(workerId)) throw new Error('capacity worker id is invalid')
    for (const [label, value, minimum, maximum] of [
      ['signal window', windowMs, 10_000, 60 * 60_000],
      ['capacity horizon', horizonMs, 30_000, 60 * 60_000],
      ['signal lease TTL', leaseTtlMs, 5_000, 5 * 60_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be from ${minimum} through ${maximum} milliseconds`)
      }
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      await client.query(
        `WITH queue AS (
           SELECT count(*)::integer AS queued_jobs,
                  COALESCE(sum(request_bytes),0)::numeric AS queued_bytes,
                  COALESCE(sum(estimated_proof_time_ms),0)::numeric AS proof_ms,
                  count(*) FILTER (
                    WHERE deadline_trusted AND latest_start_at <=
                      clock_timestamp()+($2::bigint*interval '1 millisecond')
                  )::integer AS urgent_jobs,
                  count(*) FILTER (WHERE partition IN ('reserved','dedicated'))::integer AS reserved_jobs,
                  min(latest_start_at) FILTER (WHERE deadline_trusted) AS earliest_start
           FROM hosted_prove_jobs WHERE status='QUEUED'
         ), resources AS (
           SELECT count(DISTINCT gpu_resource_id)::integer AS active_gpu
           FROM hosted_provider_nodes WHERE active AND gpu AND gpu_resource_id IS NOT NULL
         ), profiles AS (
           SELECT count(DISTINCT profile.proof_class)::integer AS stale_profiles
           FROM hosted_prove_jobs AS job
           JOIN hosted_proof_profiles AS profile ON profile.proof_class=job.proof_class
           WHERE job.status='QUEUED'
             AND profile.verified_at < clock_timestamp()-interval '24 hours'
         )
         INSERT INTO hosted_capacity_signals(
           window_started_at,queued_jobs,queued_bytes,estimated_proof_time_ms,
           urgent_jobs,reserved_jobs,active_gpu_resources,desired_gpu_resources,
           stale_proof_profiles,earliest_latest_start_at,scale_down_safe
         ) SELECT
           to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/$1)*$1/1000),
           queue.queued_jobs,queue.queued_bytes,queue.proof_ms,queue.urgent_jobs,
           queue.reserved_jobs,resources.active_gpu,
           LEAST(10000,GREATEST(
             queue.urgent_jobs,
             CASE WHEN queue.reserved_jobs > 0 THEN 1 ELSE 0 END,
             ceil(queue.proof_ms/$2)::integer
           )),
           profiles.stale_profiles,queue.earliest_start,
           profiles.stale_profiles=0 AND queue.urgent_jobs=0
         FROM queue,resources,profiles
         ON CONFLICT (window_started_at) DO NOTHING`,
        [windowMs, horizonMs],
      )
      const result = await client.query<{
        signal_id: string
        window_started_at: string | Date
        queued_jobs: number
        queued_bytes: string
        estimated_proof_time_ms: string
        urgent_jobs: number
        reserved_jobs: number
        active_gpu_resources: number
        desired_gpu_resources: number
        stale_proof_profiles: number
        earliest_latest_start_at: string | Date | null
        scale_down_safe: boolean
        lease_owner: string
        lease_token: string
        lease_expires_at: string | Date
      }>(
        `WITH candidate AS (
           SELECT signal_id FROM hosted_capacity_signals
           WHERE attempts < max_attempts AND next_attempt_at <= clock_timestamp()
             AND (status IN ('PENDING','RETRY') OR (status='LEASED' AND lease_expires_at <= clock_timestamp()))
           ORDER BY signal_id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE hosted_capacity_signals AS signal SET
           status='LEASED',lease_owner=$1,lease_token=signal.lease_token+1,
           lease_expires_at=clock_timestamp()+($2::bigint*interval '1 millisecond'),
           attempts=signal.attempts+1,updated_at=clock_timestamp()
         FROM candidate WHERE signal.signal_id=candidate.signal_id
         RETURNING signal.signal_id::text,signal.window_started_at,signal.queued_jobs,
           signal.queued_bytes::text,signal.estimated_proof_time_ms::text,
           signal.urgent_jobs,signal.reserved_jobs,signal.active_gpu_resources,
           signal.desired_gpu_resources,signal.stale_proof_profiles,
           signal.earliest_latest_start_at,signal.scale_down_safe,
           signal.lease_owner,signal.lease_token::text,signal.lease_expires_at`,
        [workerId, leaseTtlMs],
      )
      const row = result.rows[0]
      return row ? {
        signalId: row.signal_id,
        windowStartedAt: nullableTimestamp(row.window_started_at)!,
        queuedJobs: row.queued_jobs,
        queuedBytes: row.queued_bytes,
        estimatedProofTimeMs: row.estimated_proof_time_ms,
        urgentJobs: row.urgent_jobs,
        reservedJobs: row.reserved_jobs,
        activeGpuResources: row.active_gpu_resources,
        desiredGpuResources: row.desired_gpu_resources,
        staleProofProfiles: row.stale_proof_profiles,
        earliestLatestStartAt: nullableTimestamp(row.earliest_latest_start_at),
        scaleDownSafe: row.scale_down_safe,
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        leaseExpiresAt: nullableTimestamp(row.lease_expires_at)!,
      } : null
    })
  }

  async completeCapacityDemandSignal(
    fence: CoordinatorFence,
    signal: Pick<CapacityDemandSignal, 'signalId' | 'leaseOwner' | 'leaseToken'>,
    providerResponse: Record<string, unknown>,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query(
        `UPDATE hosted_capacity_signals SET status='SENT',provider_response=$4::jsonb,
           sent_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,
           last_error=NULL,updated_at=clock_timestamp()
         WHERE signal_id=$1 AND lease_owner=$2 AND lease_token=$3
           AND status='LEASED' AND lease_expires_at > clock_timestamp()`,
        [signal.signalId, signal.leaseOwner, signal.leaseToken, JSON.stringify(providerResponse)],
      )
      if (result.rowCount !== 1) throw new HostedFenceError('capacity signal lease is absent, expired, or fenced')
    })
  }

  async failCapacityDemandSignal(
    fence: CoordinatorFence,
    signal: Pick<CapacityDemandSignal, 'signalId' | 'leaseOwner' | 'leaseToken'>,
    message: string,
    retryAfterMs: number,
    forceTerminal = false,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1_000 || retryAfterMs > 60 * 60_000) {
      throw new Error('capacity signal retry must be from one second through one hour')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query<{ terminal: boolean }>(
        `UPDATE hosted_capacity_signals SET
           status=CASE WHEN $6 OR attempts>=max_attempts THEN 'FAILED' ELSE 'RETRY' END,
           next_attempt_at=clock_timestamp()+($4::bigint*interval '1 millisecond'),
           lease_owner=NULL,lease_expires_at=NULL,last_error=$5,updated_at=clock_timestamp()
         WHERE signal_id=$1 AND lease_owner=$2 AND lease_token=$3
           AND status='LEASED' AND lease_expires_at > clock_timestamp()
         RETURNING status='FAILED' AS terminal`,
        [
          signal.signalId, signal.leaseOwner, signal.leaseToken,
          retryAfterMs, message.slice(0, 500), forceTerminal,
        ],
      )
      if (result.rowCount !== 1) throw new HostedFenceError('capacity signal lease is absent, expired, or fenced')
      return result.rows[0]!.terminal
    })
  }

  async readOutbox(
    afterEventId: string,
    tenantId: string,
    limit = 200,
    admin = false,
  ): Promise<HostedOutboxEvent[]> {
    const result = await this.pool.query<{
      event_id: string
      tenant_id: string | null
      audience: HostedOutboxAudience
      topic: string
      aggregate_id: string
      payload: unknown
      created_at: string
    }>(
      `SELECT event_id::text, tenant_id, audience, topic, aggregate_id, payload, created_at::text
       FROM hosted_outbox
       WHERE event_id > $1 AND (
         audience = 'public-chain'
         OR (audience = 'tenant' AND (tenant_id = $2 OR $4::boolean))
         OR (audience = 'admin-internal' AND $4::boolean)
       )
       ORDER BY event_id LIMIT $3`,
      [afterEventId, tenantId, Math.max(1, Math.min(limit, 1_000)), admin],
    )
    return result.rows.map((row) => ({
      eventId: row.event_id,
      tenantId: row.tenant_id,
      audience: row.audience,
      topic: row.topic,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      createdAt: row.created_at,
    }))
  }

  async outboxBounds(
    tenantId: string,
    admin = false,
  ): Promise<{ firstEventId: string | null; lastEventId: string | null }> {
    const result = await this.pool.query<{ first_event_id: string | null; last_event_id: string | null }>(
      `SELECT min(event_id)::text AS first_event_id, max(event_id)::text AS last_event_id
       FROM hosted_outbox WHERE audience = 'public-chain'
         OR (audience = 'tenant' AND (tenant_id = $1 OR $2::boolean))
         OR (audience = 'admin-internal' AND $2::boolean)`,
      [tenantId, admin],
    )
    return {
      firstEventId: result.rows[0]?.first_event_id ?? null,
      lastEventId: result.rows[0]?.last_event_id ?? null,
    }
  }

  async acquireSseSlot(
    tenantId: string,
    connectionId: string,
    replicaId: string,
    tenantCap: number,
    globalCap: number,
    ttlMs = 30_000,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(tenantCap) || tenantCap < 1 || tenantCap > globalCap) {
      throw new Error('invalid tenant SSE connection cap')
    }
    if (!Number.isSafeInteger(globalCap) || globalCap < 1 || globalCap > 100_000) {
      throw new Error('invalid global SSE connection cap')
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('zkdeal-hosted-sse-slots'))")
      await client.query('DELETE FROM hosted_sse_connections WHERE expires_at <= clock_timestamp()')
      const counts = await client.query<{ tenant_count: string; global_count: string }>(
        `SELECT
           count(*) FILTER (WHERE tenant_id = $1)::text AS tenant_count,
           count(*)::text AS global_count
         FROM hosted_sse_connections`,
        [tenantId],
      )
      const row = counts.rows[0] ?? { tenant_count: '0', global_count: '0' }
      if (BigInt(row.tenant_count) >= BigInt(tenantCap) || BigInt(row.global_count) >= BigInt(globalCap)) {
        return false
      }
      await client.query(
        `INSERT INTO hosted_sse_connections(connection_id, tenant_id, replica_id, expires_at)
         VALUES ($1,$2,$3,clock_timestamp() + ($4::bigint * interval '1 millisecond'))`,
        [connectionId, tenantId, replicaId, ttlMs],
      )
      return true
    })
  }

  async renewSseSlot(connectionId: string, ttlMs = 30_000): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE hosted_sse_connections
       SET expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond')
       WHERE connection_id = $1 AND expires_at > clock_timestamp()`,
      [connectionId, ttlMs],
    )
    return result.rowCount === 1
  }

  async releaseSseSlot(connectionId: string): Promise<void> {
    await this.pool.query('DELETE FROM hosted_sse_connections WHERE connection_id = $1', [connectionId])
  }

  async hostedMetricsSnapshot():Promise<HostedMetricsSnapshot> {
    const [
      scalar,admissions,queueStatuses,reconciliations,rooms,lifecycle,l1Transactions,
      blobRequirements,blobPublications,aggregateOutcomes,aggregateCharges,
    ]=await Promise.all([
      this.pool.query<Record<string,string>>(
        `SELECT
           COALESCE((SELECT max(block_number) FROM canonical_l1_blocks WHERE canonical),0)::text AS canonical_head,
           COALESCE((SELECT max(block_number) FROM hosted_canonical_floors),0)::text AS canonical_floor,
           COALESCE((
             SELECT max(GREATEST(head.block_number-COALESCE(floor.block_number,0),0))
             FROM (SELECT chain_id,max(block_number) AS block_number FROM canonical_l1_blocks
                   WHERE canonical GROUP BY chain_id) AS head
             LEFT JOIN hosted_canonical_floors AS floor ON floor.chain_id=head.chain_id
           ),0)::text AS indexer_lag,
           pg_database_size(current_database())::text AS database_bytes,
           (SELECT count(*) FROM hosted_outbox WHERE published_at IS NULL)::text AS outbox_backlog,
           ((SELECT count(*) FROM hosted_blob_requirements WHERE canonical AND status IN ('PENDING','ERROR'))
             +(SELECT count(*) FROM hosted_l1_transactions
               WHERE status NOT IN ('PREPARED','FAILED','RECOVERY_REQUIRED','SUPERSEDED')
                 AND raw_transaction_object_key IS NULL))::text AS object_backlog,
           (SELECT count(*) FROM hosted_sse_connections WHERE expires_at>clock_timestamp())::text AS sse_connections,
           (SELECT count(*) FROM hosted_outbox WHERE topic='indexer.rollback')::text AS reorgs,
           (SELECT count(*) FROM hosted_indexer_facts WHERE NOT canonical)::text AS fact_retractions,
           ((SELECT count(*) FROM hosted_post_finality_recoveries WHERE status<>'RESOLVED')
             +(SELECT count(*) FROM hosted_l1_transactions WHERE status='RECOVERY_REQUIRED'))::text AS post_finality_surprises,
           (SELECT count(*) FROM hosted_l1_transactions WHERE deadline_risk)::text AS deadline_risk_transactions,
           COALESCE((SELECT EXTRACT(EPOCH FROM (clock_timestamp()-max(observed_at)))
                     FROM hosted_usage_ledger),0)::text AS usage_lag_seconds,
           COALESCE((SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))
                     FROM admission_wal WHERE status='RESERVED'),0)::text AS admission_oldest_reserved_seconds,
           COALESCE((SELECT sum(request_bytes) FROM hosted_prove_jobs WHERE status IN ('QUEUED','LEASED')),0)::text AS queue_bytes,
           COALESCE((SELECT avg(EXTRACT(EPOCH FROM (COALESCE(leased_at,clock_timestamp())-enqueued_at)))
                     FROM hosted_prove_jobs WHERE status IN ('QUEUED','LEASED','DONE','FAILED')),0)::text AS queue_wait_average_seconds,
           COALESCE((SELECT max(EXTRACT(EPOCH FROM (COALESCE(leased_at,clock_timestamp())-enqueued_at)))
                     FROM hosted_prove_jobs WHERE status IN ('QUEUED','LEASED','DONE','FAILED')),0)::text AS queue_wait_maximum_seconds,
           COALESCE((SELECT sum(attempts) FROM hosted_prove_jobs),0)::text AS queue_attempts,
           COALESCE((SELECT max(head)-min(head) FROM (
             SELECT min(virtual_finish) AS head FROM hosted_prove_jobs
             WHERE status='QUEUED' GROUP BY tenant_id
           ) AS tenant_heads),0)::text AS queue_fairness_spread,
           (SELECT count(*) FROM hosted_gpu_resource_leases WHERE expires_at>clock_timestamp())::text AS gpu_leases,
           COALESCE((SELECT sum(GREATEST(EXTRACT(EPOCH FROM (latest_start_at-clock_timestamp())),0))
                     FROM hosted_prove_jobs WHERE status='QUEUED' AND deadline_trusted),0)::text AS slack_sum,
           (SELECT count(*) FROM hosted_prove_jobs WHERE status='QUEUED' AND deadline_trusted)::text AS slack_count,
           (SELECT count(*) FROM hosted_prove_jobs WHERE status='QUEUED' AND deadline_trusted
              AND latest_start_at<=clock_timestamp())::text AS slack_overdue,
           (SELECT count(*) FROM hosted_prove_jobs WHERE status='QUEUED' AND deadline_trusted
              AND latest_start_at<=clock_timestamp()+interval '5 minutes')::text AS slack_five_minutes,
           (SELECT count(*) FROM hosted_prove_jobs WHERE status='QUEUED' AND deadline_trusted
              AND latest_start_at<=clock_timestamp()+interval '30 minutes')::text AS slack_thirty_minutes,
           COALESCE((SELECT sum(GREATEST(maximum_quantity-reserved_quantity-consumed_quantity,0))
                     FROM hosted_sponsorships WHERE active),0)::text AS sponsorship_available,
           COALESCE((SELECT sum(reserved_quantity) FROM hosted_sponsorships),0)::text AS sponsorship_reserved,
           COALESCE((SELECT sum(consumed_quantity) FROM hosted_sponsorships),0)::text AS sponsorship_consumed,
           (SELECT count(*) FROM hosted_outbox WHERE topic IN ('sponsorship.denied','sponsorship.rejected'))::text AS sponsorship_denials,
           (SELECT count(*) FROM hosted_refunds WHERE status='SUCCEEDED')::text AS refunds`,
      ),
      this.pool.query<{ status:string;count:string }>(
        `SELECT status,count(*)::text AS count FROM admission_wal GROUP BY status ORDER BY status`,
      ),
      this.pool.query<{ status:string;count:string }>(
        `SELECT status,count(*)::text AS count FROM hosted_prove_jobs GROUP BY status ORDER BY status`,
      ),
      this.pool.query<{ status:'reconciled'|'drifted';count:string }>(
        `SELECT CASE WHEN reconciled THEN 'reconciled' ELSE 'drifted' END AS status,count(*)::text AS count
         FROM hosted_room_observations GROUP BY reconciled ORDER BY status`,
      ),
      this.pool.query<{ state:'open'|'closed'|'unknown';count:string }>(
        `SELECT CASE document #>> '{roomState,state}' WHEN '1' THEN 'open' WHEN '2' THEN 'closed'
                  ELSE 'unknown' END AS state,count(*)::text AS count
         FROM hosted_room_observations GROUP BY state ORDER BY state`,
      ),
      this.pool.query<{ event:string;count:string }>(
        `SELECT payload #>> '{provenance,eventName}' AS event,count(*)::text AS count
         FROM hosted_indexer_facts WHERE canonical AND payload #>> '{provenance,eventName}'=ANY(ARRAY[
           'RoomCreated','RoomClosedByRecovery','AllocationUsed','AllocationRenewed','AllocationDisposed',
           'NodeStatusChanged','NodeDrainStarted','NodeRetired']::text[])
         GROUP BY event ORDER BY event`,
      ),
      this.pool.query<{ status:string;count:string }>(
        `SELECT status,count(*)::text AS count FROM hosted_l1_transactions GROUP BY status ORDER BY status`,
      ),
      this.pool.query<{ status:string;count:string }>(
        `SELECT status,count(*)::text AS count FROM hosted_blob_requirements
         GROUP BY status ORDER BY status`,
      ),
      this.pool.query<{ status:string;count:string }>(
        `SELECT status,count(*)::text AS count FROM hosted_l1_transactions
         WHERE bundle_object_key IS NOT NULL GROUP BY status ORDER BY status`,
      ),
      this.pool.query<{ outcome:'applied'|'failed'|'retracted';count:string }>(
        `SELECT outcome,count(*)::text AS count FROM (
           SELECT CASE WHEN applied THEN 'applied' ELSE 'failed' END AS outcome
           FROM hosted_aggregate_outcome_receipts
           UNION ALL SELECT 'retracted' FROM hosted_aggregate_outcome_retractions
         ) AS outcomes GROUP BY outcome ORDER BY outcome`,
      ),
      this.pool.query<{ kind:string;count:string }>(
        `SELECT entry_kind AS kind,count(*)::text AS count FROM hosted_billing_ledger
         WHERE aggregate_hash IS NOT NULL GROUP BY entry_kind ORDER BY entry_kind`,
      ),
    ])
    const number=(value:unknown):number => {
      const parsed=Number(value ?? 0)
      return Number.isFinite(parsed) ? parsed : 0
    }
    const row=scalar.rows[0] ?? {}
    return {
      canonicalHeadBlock:number(row.canonical_head),canonicalFloorBlock:number(row.canonical_floor),
      indexerLagBlocks:number(row.indexer_lag),databaseBytes:number(row.database_bytes),
      outboxBacklog:number(row.outbox_backlog),objectBacklog:number(row.object_backlog),
      sseConnections:number(row.sse_connections),reorgs:number(row.reorgs),
      factRetractions:number(row.fact_retractions),postFinalitySurprises:number(row.post_finality_surprises),
      deadlineRiskTransactions:number(row.deadline_risk_transactions),
      usageReconciliationLagSeconds:number(row.usage_lag_seconds),
      admissionOldestReservedSeconds:number(row.admission_oldest_reserved_seconds),
      queueBytes:number(row.queue_bytes),queueWaitAverageSeconds:number(row.queue_wait_average_seconds),
      queueWaitMaximumSeconds:number(row.queue_wait_maximum_seconds),queueAttempts:number(row.queue_attempts),
      queueFairnessSpread:number(row.queue_fairness_spread),gpuLeases:number(row.gpu_leases),
      trustedDeadlineSlackSumSeconds:number(row.slack_sum),trustedDeadlineSlackCount:number(row.slack_count),
      trustedDeadlineBuckets:{
        overdue:number(row.slack_overdue),fiveMinutes:number(row.slack_five_minutes),
        thirtyMinutes:number(row.slack_thirty_minutes),infinite:number(row.slack_count),
      },
      sponsorship:{
        available:number(row.sponsorship_available),reserved:number(row.sponsorship_reserved),
        consumed:number(row.sponsorship_consumed),denials:number(row.sponsorship_denials),
        refunds:number(row.refunds),
      },
      admissionStatuses:admissions.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      queueStatuses:queueStatuses.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      reconciliationStatuses:reconciliations.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      roomStates:rooms.rows.map((item) => ({ state:item.state,count:number(item.count) })),
      roomLifecycleEvents:lifecycle.rows.map((item) => ({ event:item.event,count:number(item.count) })),
      l1TransactionStatuses:l1Transactions.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      blobRequirementStatuses:blobRequirements.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      blobPublishStatuses:blobPublications.rows.map((item) => ({ status:item.status,count:number(item.count) })),
      aggregateOutcomes:aggregateOutcomes.rows.map((item) => ({ outcome:item.outcome,count:number(item.count) })),
      aggregateCharges:aggregateCharges.rows.map((item) => ({ kind:item.kind,count:number(item.count) })),
    }
  }

  async resolveSafetyEvent(
    fence: CoordinatorFence,
    eventId: string,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const result = await client.query(
        `UPDATE hosted_outbox
         SET resolved_at = COALESCE(resolved_at, clock_timestamp())
         WHERE event_id = $1 AND retention_class = 'safety'`,
        [eventId],
      )
      return result.rowCount === 1
    })
  }

  async reap(
    fence: CoordinatorFence,
    input: {
      transientRetentionDays?: number
      auditRetentionDays?: number
      resolvedSafetyRetentionDays?: number
    } = {},
  ): Promise<{ outbox: number; admissions: number; blocks: number }> {
    const transientDays = input.transientRetentionDays ?? 30
    const auditDays = input.auditRetentionDays ?? 365
    const resolvedSafetyDays = input.resolvedSafetyRetentionDays ?? 30
    if (!Number.isSafeInteger(transientDays) || transientDays < 30) {
      throw new Error('transient retention cannot be shorter than 30 days')
    }
    if (!Number.isSafeInteger(auditDays) || auditDays < 365) {
      throw new Error('audit and billing retention cannot be shorter than 365 days')
    }
    if (!Number.isSafeInteger(resolvedSafetyDays) || resolvedSafetyDays < 30) {
      throw new Error('resolved safety retention cannot be shorter than 30 days')
    }
    return this.transaction(async (client) => {
      await this.assertFence(client, fence)
      const outbox = await client.query(
        `DELETE FROM hosted_outbox
         WHERE (
           retention_class = 'transient'
           AND created_at < clock_timestamp() - ($1::integer * interval '1 day')
         ) OR (
           retention_class = 'audit'
           AND created_at < clock_timestamp() - ($2::integer * interval '1 day')
         ) OR (
           retention_class = 'safety'
           AND resolved_at IS NOT NULL
           AND resolved_at < clock_timestamp() - ($3::integer * interval '1 day')
         )`,
        [transientDays, auditDays, resolvedSafetyDays],
      )
      const admissions = await client.query(
        `DELETE FROM admission_wal
         WHERE status IN ('ACKED','CANCELLED')
           AND updated_at < clock_timestamp() - ($1::integer * interval '1 day')`,
        [auditDays],
      )
      const blocks = await client.query(
        `DELETE FROM canonical_l1_blocks AS block
         WHERE NOT block.canonical
           AND block.observed_at < clock_timestamp() - ($1::integer * interval '1 day')
           AND NOT EXISTS (
             SELECT 1 FROM hosted_canonical_floors AS floor
             WHERE floor.chain_id = block.chain_id
               AND block.block_number <= floor.block_number
           )
           AND NOT EXISTS (
             SELECT 1 FROM hosted_outbox AS event
             WHERE event.topic = 'indexer.rollback'
               AND event.retention_class = 'safety'
               AND event.resolved_at IS NULL
               AND (event.payload->>'chainId')::bigint = block.chain_id
               AND (event.payload->>'fromBlock')::numeric <= block.block_number
           )`,
        [transientDays],
      )
      return {
        outbox: outbox.rowCount ?? 0,
        admissions: admissions.rowCount ?? 0,
        blocks: blocks.rowCount ?? 0,
      }
    })
  }
}
