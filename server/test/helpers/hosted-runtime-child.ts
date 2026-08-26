import { loadConfig } from '../../src/config.js'
import { HostedRuntime } from '../../src/hosted-runtime.js'

const role = process.env.TEST_HOSTED_PROCESS_ROLE
if (role !== 'coordinator' && role !== 'indexer' && role !== 'reconciler') {
  throw new Error('TEST_HOSTED_PROCESS_ROLE must name coordinator, indexer, or reconciler')
}
const config = loadConfig()
const runtime = await HostedRuntime.create(config, role === 'coordinator' ? {} : {
  workerComponent: role,
  workerId: process.env.HOSTED_WORKER_ID ?? `${config.coordinatorId}-${role}-child`,
})
if (!runtime) throw new Error('hosted child runtime was not created')

let closed = false
let mutating = false
let announced = false
const mutate = async () => {
  if (closed || mutating) return
  mutating = true
  try {
    await runtime.store.upsertTenant(runtime.writableFence(), {
      tenantId: `process-${role}`,
      displayName: `${role} process fence probe`,
      tier: 'internal',
    })
    if (!announced) {
      announced = true
      process.stdout.write(`READY ${role}\n`)
    }
  } catch (error) {
    process.stdout.write(`FENCED ${role} ${error instanceof Error ? error.name : 'Error'}\n`)
    closed = true
    clearInterval(timer)
    await runtime.close().catch(() => {})
    process.exit(42)
  } finally {
    mutating = false
  }
}
const timer = setInterval(() => void mutate(), 250)
await mutate()

const stop = async () => {
  if (closed) return
  closed = true
  clearInterval(timer)
  await runtime.close().catch(() => {})
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
await new Promise<void>(() => {})
