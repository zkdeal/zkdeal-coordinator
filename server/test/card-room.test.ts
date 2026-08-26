import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CARD_APPLICATION_DOMAIN,
  CARD_DUEL_ENTRY_POINT_SIGNATURES,
  CARD_DUEL_SELECTORS,
  CARD_PARTICIPANT_CAPACITY,
  cardDuelAllowedSelectors,
  emptyParticipantRoot,
} from '@zkdeal/protocol'
import { keccak256, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  CARD_ROOM_PRESET_ID,
  CARD_ROOM_REQUIRED_CAPABILITIES,
  CARD_ROOM_TOUCHED_CONTRACTS,
  CARD_ROOM_WORKLOAD,
  cardRoomPreset,
  describeCardRoomCapabilityGap,
  missingCardRoomCapabilities,
} from '../src/card-room.js'
import { DemoLiveRuntime } from '../src/demo-live-runtime.js'
import { DEMO_PRESETS } from '../src/demo-presets.js'
import { baseSpec } from '../src/demo-runtime-spec.js'
import { validateTemplateRequest } from '../src/demo-validation.js'
import { DemoController } from '../src/demo-controller.js'
import type { DemoPhase, DemoRuntime, DemoTemplate } from '../src/demo-types.js'
import {
  admissionKey,
  closeHarnesses,
  harness,
  operator,
  room,
  signed,
} from './helpers/admission-harness.js'
import { cardRoomFixture } from './helpers/card-room-fixture.js'

afterAll(closeHarnesses)

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zkdeal-card-room-'))
  created.push(path)
  return path
}

const preset = cardRoomPreset()

/**
 * A move payload the browser would actually submit: the `play` selector plus an
 * opaque body long enough to hold a participant tuple, a seven-deep Merkle
 * proof and the 256-byte inner Groth16 proof. Its CONTENT is deliberately
 * meaningless - the point of these tests is that no layer on the way to L1
 * looks inside it.
 */
function playCalldata(): `0x${string}` {
  const innerProof = 'ab'.repeat(256)
  const body = '00'.repeat(32 * 12) + innerProof
  return `${CARD_DUEL_SELECTORS.play}${body}` as `0x${string}`
}

function template(overrides: Partial<DemoTemplate> = {}): DemoTemplate {
  const validated = validateTemplateRequest({ name: 'Hidden-card duel', presetId: CARD_ROOM_PRESET_ID })
  return {
    ...validated,
    id: 'tpl-card',
    phase: 'ROOM_READY',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('hidden-card duel preset', () => {
  it('replaces the placeholder that ran the generic storage workload', () => {
    const listed = DEMO_PRESETS.find((entry) => entry.id === CARD_ROOM_PRESET_ID)
    expect(listed).toBeDefined()
    expect(listed?.workload).toBe(CARD_ROOM_WORKLOAD)
    expect(listed?.workload).not.toBe('storage')
    expect(JSON.stringify(listed)).not.toContain('0x12345678')
  })

  it('is a validity-only room at the legal minimum participant capacity', () => {
    expect(preset.authorizationMode).toBe('VALIDITY_ONLY')
    expect(preset.activeApprovers).toBe(0)
    expect(preset.participantCapacity).toBe(CARD_PARTICIPANT_CAPACITY)
    expect(preset.participantCapacity & (preset.participantCapacity - 1)).toBe(0)
  })

  it('allows exactly the compiled duel entry points plus the token surface', () => {
    for (const selector of cardDuelAllowedSelectors()) {
      expect(preset.allowedSelectors).toContain(selector)
    }
    expect(new Set(preset.allowedSelectors).size).toBe(preset.allowedSelectors.length)
    expect(preset.allowedSelectors.length).toBeLessThanOrEqual(64)
    for (const selector of preset.allowedSelectors) {
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/)
    }
  })

  it('agrees with an independent selector implementation', () => {
    for (const [name, signature] of Object.entries(CARD_DUEL_ENTRY_POINT_SIGNATURES)) {
      expect(toFunctionSelector(signature), name).toBe(
        CARD_DUEL_SELECTORS[name as keyof typeof CARD_DUEL_SELECTORS],
      )
    }
  })

  it('cans no move calldata, because no duel move can honestly be canned', () => {
    expect(preset.actions).toHaveLength(0)
  })

  it('seeds every constructor-written duel slot except the address-dependent one', () => {
    const bySlot = new Map(preset.initialStorage.map((entry) => [entry.slot, entry.value]))
    expect([...bySlot.keys()].sort()).toEqual(['0', '1', '2', '3', '4', '6'])
    expect(bySlot.get('0')).toBe(
      BigInt(emptyParticipantRoot(CARD_PARTICIPANT_CAPACITY)).toString(),
    )
    expect(bySlot.get('1')).toBe('1')
    expect(bySlot.get('2')).toBe('0')
    expect(bySlot.get('3')).toBe(String(CARD_PARTICIPANT_CAPACITY))
    expect(bySlot.get('4')).toBe(BigInt(CARD_APPLICATION_DOMAIN).toString())
    // proofDomain (slot 5) needs the deployed duel address and is therefore
    // supplied at preparation, not by the preset.
    expect(bySlot.has('5')).toBe(false)
  })

  it('survives template validation with its capacity and mode intact', () => {
    const validated = validateTemplateRequest({ name: 'Hidden-card duel', presetId: CARD_ROOM_PRESET_ID })
    expect(validated.presetId).toBe(CARD_ROOM_PRESET_ID)
    expect(validated.authorizationMode).toBe('VALIDITY_ONLY')
    expect(validated.activeApprovers).toBe(0)
    expect(validated.participantCapacity).toBe(CARD_PARTICIPANT_CAPACITY)
    expect(validated.allowedSelectors).toEqual(preset.allowedSelectors)
  })
})

describe('prover request shape', () => {
  const domain = `0x${'11'.repeat(32)}` as const

  // A duel request carries real per-address runtime code, so `baseSpec` needs
  // the deployment; `card-request.test.ts` covers the request shape itself.
  const duelSpec = () =>
    baseSpec(template(), 1, 1_000, domain, undefined, null, cardRoomFixture())

  it('carries the preset participant and contract counts', () => {
    const spec = duelSpec()
    expect(spec.workload).toBe(CARD_ROOM_WORKLOAD)
    expect(spec.registeredParticipants).toBe(0)
    expect(spec.touchedParticipants).toBe(2)
    expect(spec.touchedContracts).toBe(CARD_ROOM_TOUCHED_CONTRACTS)
    expect(spec.residentAccounts).toBe(CARD_ROOM_TOUCHED_CONTRACTS + 3)
  })

  it('keeps the historical single-contract default for other presets', () => {
    const shop = template({ presetId: 'shop' })
    const spec = baseSpec(shop, 1, 1_000, domain)
    expect(spec.registeredParticipants).toBe(1)
    expect(spec.touchedParticipants).toBe(1)
    expect(spec.touchedContracts).toBe(1)
    expect(spec.residentAccounts).toBe(2)
  })

  it('never reports fewer resident accounts than the contracts it touches', () => {
    const spec = duelSpec()
    expect(Number(spec.residentAccounts)).toBeGreaterThan(Number(spec.touchedContracts))
  })
})

describe('card room prover capability gate', () => {
  it('treats an absent capability document as no capability at all', () => {
    expect(missingCardRoomCapabilities(null)).toEqual([...CARD_ROOM_REQUIRED_CAPABILITIES])
    expect(missingCardRoomCapabilities({})).toEqual([...CARD_ROOM_REQUIRED_CAPABILITIES])
    expect(missingCardRoomCapabilities({ roomCapabilities: 'all' })).toEqual([
      ...CARD_ROOM_REQUIRED_CAPABILITIES,
    ])
  })

  it('reports only the tokens a partially capable host omits', () => {
    const reported = CARD_ROOM_REQUIRED_CAPABILITIES.slice(0, 2)
    expect(missingCardRoomCapabilities({ roomCapabilities: reported })).toEqual(
      CARD_ROOM_REQUIRED_CAPABILITIES.slice(2),
    )
  })

  it('accepts a host that reports every required capability', () => {
    expect(
      missingCardRoomCapabilities({ roomCapabilities: [...CARD_ROOM_REQUIRED_CAPABILITIES, 'extra'] }),
    ).toEqual([])
  })

  it('names every missing capability and why it is missing', () => {
    const message = describeCardRoomCapabilityGap([...CARD_ROOM_REQUIRED_CAPABILITIES])
    for (const token of CARD_ROOM_REQUIRED_CAPABILITIES) expect(message).toContain(token)
    expect(message).toContain('v5_fixture')
  })

  /**
   * The live runtime must refuse BEFORE it deploys a contract, reads the
   * canary evidence or starts a cold proof. A stubbed `fetch` that answers only
   * `/v5/capabilities` proves it: any other request would throw and the failure
   * message would be a different one.
   */
  async function prepareWithCapabilities(reported: unknown): Promise<string> {
    const runtime = new DemoLiveRuntime({
      l1RpcUrl: 'http://127.0.0.1:1',
      l1RpcUrls: ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
      proverUrl: 'http://prover.invalid',
      contractsRoot: await dataDir(),
      evidencePath: join(await dataDir(), 'missing-evidence.json'),
      explorerUrl: null,
      apiUrl: null,
    })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (!url.endsWith('/v5/capabilities')) throw new Error(`unexpected fetch to ${url}`)
      return new Response(JSON.stringify(reported), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    try {
      await runtime.prepareTemplate(template(), async () => {})
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      globalThis.fetch = original
    }
  }

  it('refuses preparation before deploying anything when the host lacks capabilities', async () => {
    const message = await prepareWithCapabilities({ protocolVersion: 5 })
    for (const token of CARD_ROOM_REQUIRED_CAPABILITIES) expect(message).toContain(token)
  })

  it('reports the gap through the demo controller as a caller-safe failure', async () => {
    const runtime: DemoRuntime = {
      systemStatus: async () => {
        throw new Error('unused')
      },
      recentBlocks: async () => [],
      prepareTemplate: async (_subject: DemoTemplate, onPhase: (phase: DemoPhase) => Promise<void>) => {
        await onPhase('COLD_EXECUTING')
        throw new Error(describeCardRoomCapabilityGap(missingCardRoomCapabilities(null)))
      },
      deployRoom: async () => {
        throw new Error('unused')
      },
      checkpointRoom: async () => {
        throw new Error('unused')
      },
    }
    const controller = new DemoController(await dataDir(), runtime)
    await controller.initialize()
    const { template: created } = await controller.createTemplate(
      { name: 'Hidden-card duel', presetId: CARD_ROOM_PRESET_ID },
      'idem-card-capability-1',
    )
    await controller.drain()
    const stored = controller.template(created.id)!
    expect(stored.phase).toBe('FAILED')
    expect(stored.failure?.explanation).toContain('v5.workload.card-duel')
  })
})

describe('card move calldata is opaque to the coordinator', () => {
  it('accepts a duel move whose calldata carries a 256-byte inner proof', async () => {
    const runtime: DemoRuntime = {
      systemStatus: async () => {
        throw new Error('unused')
      },
      recentBlocks: async () => [],
      prepareTemplate: async () => {
        throw new Error('unused')
      },
      deployRoom: async () => ({ chainRoomId: '9', transaction: `0x${'11'.repeat(32)}` }),
      checkpointRoom: async () => {
        throw new Error('unused')
      },
    }
    const controller = new DemoController(await dataDir(), runtime)
    await controller.initialize()
    const { template: created } = await controller.createTemplate(
      { name: 'Hidden-card duel', presetId: CARD_ROOM_PRESET_ID },
      'idem-card-move-1',
    )
    await controller.drain()
    // The capability gate is not exercised here; drive the phases the way a
    // prepared template would leave them so `addAction` is reachable.
    const snapshot = controller.template(created.id)!
    expect(snapshot.allowedSelectors).toContain(CARD_DUEL_SELECTORS.play)

    const calldata = playCalldata()
    expect(calldata.length).toBe(2 + 8 + (32 * 12 + 256) * 2)
    expect(calldata.slice(0, 10)).toBe(CARD_DUEL_SELECTORS.play)
    // Nothing between the browser and L1 parses past the four-byte selector:
    // the demo controller checks the prefix, the admission service hashes the
    // whole raw transaction, and canonical_batch_data_v5 RLP-encodes it whole.
    expect(snapshot.allowedSelectors.includes(calldata.slice(0, 10))).toBe(true)
    expect(snapshot.allowedSelectors).not.toContain('0xdeadbeef')
  })

  it('admits a signed duel move without inspecting a byte of its calldata', async () => {
    const { app, service } = await harness([
      room('11', privateKeyToAccount(admissionKey).address),
    ])
    const rawSignedTransaction = await signed(0, undefined, playCalldata())
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/11/transactions',
      headers: operator,
      payload: {
        rawSignedTransaction,
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const receipt = response.json().receipt
    // The receipt binds keccak256(rawTx) only - the calldata is never decoded,
    // so an argument shape change needs no coordinator change.
    expect(receipt.transactionHash).toBe(keccak256(rawSignedTransaction))
    expect(response.body).not.toContain(playCalldata().slice(10))
    const [queued] = service.takePending('11')
    expect(queued?.rawSignedTransaction).toBe(rawSignedTransaction.toLowerCase())
  })

  it('still refuses an unauthenticated caller for a duel move', async () => {
    const { app } = await harness([room('12', privateKeyToAccount(admissionKey).address)])
    const response = await app.inject({
      method: 'POST',
      url: '/rooms/12/transactions',
      payload: {
        rawSignedTransaction: await signed(0, undefined, playCalldata()),
        depositInboxId: '0',
        deadlineBlock: '100',
        maximumBatchIndex: '2',
      },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().decision).toBe('NOT_ADMITTED')
  })
})
