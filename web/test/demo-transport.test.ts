import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeDemoRoom } from '../lib/applications/transport'

afterEach(() => vi.unstubAllGlobals())

describe('demo room transport', () => {
  it('closes the exact current room with an idempotent mutation', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: 'room-current',
          name: 'ERC-7540 self-play',
          templateId: 'tpl-1',
          managed: false,
          deadlineBlocksFromStart: 10,
          phase: 'CLOSED',
          chainRoomId: '7',
          deploymentTransaction: null,
          actions: [],
          closedAt: '2026-07-28T12:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchStub)

    const closed = await closeDemoRoom('room-current')

    expect(closed.phase).toBe('CLOSED')
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]!
    expect(String(url)).toContain('/demo/v1/rooms/room-current/close')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^demo-close-/)
  })
})
