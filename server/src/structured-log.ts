export const HOSTED_TRACE_COMPONENTS=[
  'coordinator-http','queue','indexer','reconciler','publisher','capacity','withdrawal','prover-agent',
] as const

export type HostedTraceComponent=(typeof HOSTED_TRACE_COMPONENTS)[number]
export type HostedTraceOutcome='started'|'succeeded'|'retrying'|'failed'|'retracted'|'denied'

export interface HostedTraceInput {
  correlationId:string
  tenantId?:string|null
  roomId?:string|null
  jobId?:string|null
  operationId?:string|null
  component:HostedTraceComponent
  event:string
  outcome:HostedTraceOutcome
}

export interface HostedTraceRecord extends HostedTraceInput {
  schemaVersion:1
  timestamp:string
  tenantId:string|null
  roomId:string|null
  jobId:string|null
  operationId:string|null
}

type TraceWriter=(line:string) => void
const SAFE=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
let writer:TraceWriter=(line) => process.stdout.write(`${line}\n`)

function safe(value:string|null|undefined,label:string,required=false):string|null {
  if (value===null || value===undefined || value==='') {
    if (required) throw new Error(`${label} is required for a hosted trace`)
    return null
  }
  if (!SAFE.test(value)) throw new Error(`${label} is unsafe for a hosted trace`)
  return value
}

export function hostedTraceRecord(input:HostedTraceInput,now=new Date()):HostedTraceRecord {
  return {
    schemaVersion:1,timestamp:now.toISOString(),
    correlationId:safe(input.correlationId,'correlationId',true)!,
    tenantId:safe(input.tenantId,'tenantId'),roomId:safe(input.roomId,'roomId'),
    jobId:safe(input.jobId,'jobId'),operationId:safe(input.operationId,'operationId'),
    component:input.component,event:safe(input.event,'event',true)!,outcome:input.outcome,
  }
}

export function emitHostedTrace(input:HostedTraceInput):HostedTraceRecord {
  const record=hostedTraceRecord(input)
  writer(JSON.stringify(record))
  return record
}

/** Test-only capture hook; returns a restoration callback. */
export function captureHostedTracesForTest(sink:HostedTraceRecord[]):() => void {
  const previous=writer
  writer=(line) => sink.push(JSON.parse(line) as HostedTraceRecord)
  return () => { writer=previous }
}

