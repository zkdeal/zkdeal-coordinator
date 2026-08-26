import Fastify from 'fastify'
import { afterEach,describe,expect,it } from 'vitest'
import { registerCorrelationHooks,requestCorrelationId } from '../src/correlation.js'

describe('cross-service correlation logging contract',() => {
  const apps:ReturnType<typeof Fastify>[]=[]
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

  const app=() => {
    const server=Fastify({ logger:false })
    apps.push(server)
    registerCorrelationHooks(server)
    server.post<{ Body:{ correlationId?:string } }>('/work',async (request) => ({
      correlationId:requestCorrelationId(request),
    }))
    return server
  }

  it('echoes one safe header/body identity',async () => {
    const server=app(),correlationId='owner:room:batch:0001'
    const response=await server.inject({
      method:'POST',url:'/work',headers:{ 'x-correlation-id':correlationId },payload:{ correlationId },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['x-correlation-id']).toBe(correlationId)
    expect(response.json()).toEqual({ correlationId })
  })

  it('rejects conflicting or malformed correlation identities',async () => {
    const server=app()
    const conflict=await server.inject({
      method:'POST',url:'/work',headers:{ 'x-correlation-id':'owner:room:batch:0001' },
      payload:{ correlationId:'owner:room:batch:0002' },
    })
    expect(conflict.statusCode).toBe(409)
    const malformed=await server.inject({
      method:'POST',url:'/work',headers:{ 'x-correlation-id':'bad value' },payload:{},
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('accepts a legacy body identity and propagates it to the response',async () => {
    const server=app(),correlationId='queue:legacy:0001'
    const response=await server.inject({ method:'POST',url:'/work',payload:{ correlationId } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['x-correlation-id']).toBe(correlationId)
  })
})

