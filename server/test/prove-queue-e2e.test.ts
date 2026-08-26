/**
 * End-to-end against a REAL standalone queue with REAL stub agents.
 *
 * The compose `queue-test` service (web2-api/docker-compose.yml) spins the
 * standalone queue plus three prover agents - two `ok:2000` stubs and one
 * `take-and-die` stub that leases exactly one job and exits - then runs this
 * suite with QUEUE_E2E_URL set. Without that env the suite skips: the plain
 * server test run has no queue to talk to, and faking one here would test
 * nothing the unit suites do not.
 *
 * What must hold: every job ends DONE, including the one whose first holder
 * died (re-leased after lease expiry and completed by a live agent); a
 * waiting submitter's observed position never grows; and both bearer gates
 * answer 401 to a wrong token.
 */

import { describe, expect, it } from 'vitest'

const queueUrl = process.env.QUEUE_E2E_URL?.replace(/\/+$/, '')
const submitToken = process.env.ZKDEAL_QUEUE_SUBMIT_TOKEN ?? ''
const nodeToken = process.env.ZKDEAL_QUEUE_NODE_TOKEN ?? ''

const JOBS = 6
const E2E_TIMEOUT_MS = 120_000

async function call(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${queueUrl}${path}`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
    ...init,
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    /* 204 has no body */
  }
  return { status: response.status, body }
}

describe.runIf(Boolean(queueUrl))('the shared prove queue with live agents', () => {
  it(
    'completes every job, survives an agent death, and keeps positions honest',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const jobIds: string[] = []
      for (let n = 0; n < JOBS; n += 1) {
        const { status, body } = await call('/queue/v1/jobs', submitToken, {
          method: 'POST',
          body: JSON.stringify({
            endpoint: '/v5/rooms/prove',
            request: { fixture: `e2e-${n}`, payload: 'x'.repeat(1_000) },
          }),
        })
        expect(status).toBe(200)
        jobIds.push((body as { jobId: string }).jobId)
        // The very first job is what the take-and-die agent grabs; the ok
        // agents are only started by the harness after that lease exists.
      }

      // Watch the LAST submitted job: its position must never grow, even
      // while the dead agent's job is being requeued in front of everything.
      const lastId = jobIds[jobIds.length - 1]!
      const positions: number[] = []
      const deadline = Date.now() + E2E_TIMEOUT_MS - 10_000
      const jobs = new Map<string, { status: string; nodeId: string | null; attempts: number }>()
      while (Date.now() < deadline) {
        let allDone = true
        for (const jobId of jobIds) {
          const { status, body } = await call(`/queue/v1/jobs/${jobId}`, submitToken)
          expect(status).toBe(200)
          const job = body as {
            status: string
            nodeId: string | null
            attempts: number
            position: number | null
          }
          jobs.set(jobId, job)
          if (jobId === lastId && typeof job.position === 'number') positions.push(job.position)
          if (job.status === 'FAILED') throw new Error(`job ${jobId} was condemned`)
          if (job.status !== 'DONE') allDone = false
        }
        if (allDone) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      for (const jobId of jobIds) expect(jobs.get(jobId)?.status).toBe('DONE')
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i]!).toBeLessThanOrEqual(positions[i - 1]!)
      }

      // The dead agent's job died with it and was completed by a live one.
      const relayed = [...jobs.values()].filter((job) => job.attempts >= 2)
      expect(relayed.length).toBeGreaterThanOrEqual(1)
      for (const job of relayed) expect(['stub-a', 'stub-b']).toContain(job.nodeId)

      // The queue's own ledger tells the same story: the dead node leased
      // but banked nothing; the live agents did all the finishing.
      const { body: statusBody } = await call('/queue/v1/status', submitToken)
      const nodes = (statusBody as { nodes: Array<Record<string, unknown>> }).nodes
      const dead = nodes.find((node) => node.nodeId === 'stub-dead')
      expect(dead).toMatchObject({ jobsDone: 0 })
      expect(dead?.lastLeaseAt).toBeTruthy()
      const finished = nodes
        .filter((node) => node.nodeId !== 'stub-dead')
        .reduce((sum, node) => sum + Number(node.jobsDone ?? 0), 0)
      expect(finished).toBe(JOBS)

      // Every result is the agent's verbatim prover JSON.
      const { status, body } = await call(`/queue/v1/jobs/${lastId}/result`, submitToken)
      expect(status).toBe(200)
      expect(body).toMatchObject({ decision: 'stub-proof' })
    },
  )

  it('answers 401 to a wrong bearer on both surfaces', async () => {
    const submit = await call('/queue/v1/jobs', 'wrong-submitter-token', {
      method: 'POST',
      body: JSON.stringify({ endpoint: '/v5/rooms/prove', request: {} }),
    })
    expect(submit.status).toBe(401)
    const lease = await call('/queue/v1/lease', 'wrong-node-token', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'mallory' }),
    })
    expect(lease.status).toBe(401)
    // The submitter credential opens no node-side door either.
    const crossed = await call('/queue/v1/lease', submitToken, {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'mallory' }),
    })
    expect(crossed.status).toBe(401)
    expect(nodeToken).not.toBe('')
  })
})
