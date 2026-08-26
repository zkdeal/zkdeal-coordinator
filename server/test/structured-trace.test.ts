import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe,expect,it } from 'vitest'
import {
  HOSTED_TRACE_COMPONENTS,
  captureHostedTracesForTest,
  emitHostedTrace,
} from '../src/structured-log.js'
import { HOSTED_METRIC_CATALOG } from '../src/metrics.js'

describe('hosted structured trace contract',() => {
  it('joins every component with fixed fields and never carries secrets or metric identifiers',() => {
    const records:ReturnType<typeof emitHostedTrace>[]=[]
    const restore=captureHostedTracesForTest(records)
    try {
      for (const component of HOSTED_TRACE_COMPONENTS) emitHostedTrace({
        correlationId:'trace:room-7:batch-42',tenantId:'tenant-a',roomId:'7',jobId:'job-42',
        operationId:'operation-42',component,event:'job.complete',outcome:'succeeded',
      })
    } finally { restore() }
    expect(records.map((record) => record.component)).toEqual(HOSTED_TRACE_COMPONENTS)
    for (const record of records) {
      expect(record).toMatchObject({
        schemaVersion:1,correlationId:'trace:room-7:batch-42',tenantId:'tenant-a',roomId:'7',
        jobId:'job-42',operationId:'operation-42',event:'job.complete',outcome:'succeeded',
      })
      expect(Object.keys(record).sort()).toEqual([
        'component','correlationId','event','jobId','operationId','outcome','roomId','schemaVersion',
        'tenantId','timestamp',
      ])
    }
    const serialized=JSON.stringify(records)
    expect(serialized).not.toMatch(/authorization|bearer|password|private.?key|requestBody|resultBody|secret|token/i)
    for (const metric of HOSTED_METRIC_CATALOG) {
      expect(metric.labels).not.toEqual(expect.arrayContaining(['correlationId','tenantId','roomId','jobId','operationId']))
    }
  })

  it('keeps each owner runtime boundary wired to the shared emitter',async () => {
    const callsites=[
      ['coordinator-http','../src/correlation.ts'],
      ['queue','../src/prove-queue/postgres-queue-routes.ts'],
      ['indexer','../src/hosted-indexer.ts'],
      ['reconciler','../src/hosted-indexer.ts'],
      ['publisher','../src/managed-l1-publisher.ts'],
      ['capacity','../src/capacity-controller.ts'],
      ['withdrawal','../src/withdrawal-claimer.ts'],
    ] as const
    for (const [component,path] of callsites) {
      const source=await readFile(resolve(import.meta.dirname,path),'utf8')
      expect(source,component).toContain('emitHostedTrace')
      expect(source,component).toContain(`component:'${component}'`)
    }
  })

  it('joins the packaged prover agent to the queue lease without carrying payload bytes',async () => {
    const fixture=JSON.parse(await readFile(resolve(
      import.meta.dirname,'../../../prover-node/agent/test/fixtures/hosted-trace-join.json',
    ),'utf8')) as { joinFields:string[];records:Array<Record<string,unknown>> }
    expect(fixture.joinFields).toEqual(['correlationId','tenantId','roomId','jobId'])
    const keys=fixture.records.map((record) => fixture.joinFields.map((field) => record[field]).join('|'))
    expect(new Set(keys).size).toBe(1)
    expect(fixture.records.map((record) => record.component)).toEqual([
      'queue','prover-agent','prover-agent','queue',
    ])
    const serialized=JSON.stringify(fixture.records)
    expect(serialized).not.toMatch(/authorization|bearer|password|private.?key|requestBody|resultBody|secret|token/i)
    const agentSource=await readFile(resolve(import.meta.dirname,'../../../prover-node/agent/src/agent.ts'),'utf8')
    expect(agentSource).toContain('parseLeasedJob')
    expect(agentSource).toContain('emitAgentTrace')
  })
})
