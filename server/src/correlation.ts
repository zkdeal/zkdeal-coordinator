import type { FastifyInstance,FastifyRequest } from 'fastify'
import { emitHostedTrace } from './structured-log.js'

const CORRELATION=/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/
const requestCorrelations=new WeakMap<FastifyRequest,string>()

function headerValue(request:FastifyRequest):string|null {
  const raw=request.headers['x-correlation-id']
  const value=Array.isArray(raw) ? raw[0] : raw
  return typeof value==='string' && value.length>0 ? value : null
}

function bodyValue(request:FastifyRequest):string|null {
  const body=request.body
  if (!body || typeof body!=='object' || Array.isArray(body)) return null
  const value=(body as Record<string,unknown>).correlationId
  return typeof value==='string' && value.length>0 ? value : null
}

export function requestCorrelationId(request:FastifyRequest):string {
  return requestCorrelations.get(request) ?? request.id
}

/**
 * One correlation identity crosses HTTP, durable jobs/operations and logs.
 * Values are never used as metric labels. A body value may supply the ID for
 * older queue clients, but it may never contradict an explicit header.
 */
export function registerCorrelationHooks(app:FastifyInstance):void {
  app.addHook('preHandler',async (request,reply) => {
    const header=headerValue(request),body=bodyValue(request)
    if ((header!==null && !CORRELATION.test(header)) || (body!==null && !CORRELATION.test(body))) {
      return reply.code(400).send({ error:'correlationId must contain 8 through 200 safe characters' })
    }
    if (header!==null && body!==null && header!==body) {
      return reply.code(409).send({ error:'X-Correlation-Id is bound to a different body correlationId' })
    }
    const correlationId=header ?? body ?? request.id
    requestCorrelations.set(request,correlationId)
    reply.header('x-correlation-id',correlationId)
    emitHostedTrace({ correlationId,component:'coordinator-http',event:'request',outcome:'started' })
    request.log.info({ correlationId,method:request.method,path:request.routeOptions.url },'correlated request started')
  })
  app.addHook('onResponse',async (request,reply) => {
    const correlationId=requestCorrelationId(request)
    if (!reply.hasHeader('x-correlation-id')) reply.header('x-correlation-id',correlationId)
    emitHostedTrace({
      correlationId,component:'coordinator-http',event:'request',
      outcome:reply.statusCode<400 ? 'succeeded' : reply.statusCode<500 ? 'denied' : 'failed',
    })
    request.log.info({ correlationId,statusCode:reply.statusCode },'correlated request completed')
  })
  app.addHook('onError',async (request,reply,error) => {
    emitHostedTrace({
      correlationId:requestCorrelationId(request),component:'coordinator-http',event:'request',outcome:'failed',
    })
    request.log.error({ correlationId:requestCorrelationId(request),statusCode:reply.statusCode,error },
      'correlated request failed')
  })
}
