import { describe, expect, it } from 'vitest'
import {
  createReferenceKurtosisBundle,
  parseKurtosisStoryBundle,
} from '../lib/kurtosis-stories'

describe('Kurtosis story trace import', () => {
  it('ships every required recovery and adversary story in the reference bundle', () => {
    const bundle = createReferenceKurtosisBundle()
    expect(bundle.schema).toBe('zkdeal-kurtosis-stories/v1')
    expect(bundle.topology).toMatchObject({ countedServices: 16, persistentServices: 15, memberClients: 7 })
    expect(bundle.stories).toHaveLength(18)
    expect(bundle.stories.filter((story) => story.category === 'recovery')).toHaveLength(6)
    expect(bundle.stories.filter((story) => story.category === 'adversary')).toHaveLength(12)
    expect(bundle.stories.every((story) => story.events.length > 0)).toBe(true)
  })

  it('round-trips a generated run and rejects unknown topology endpoints', () => {
    const bundle = createReferenceKurtosisBundle()
    expect(parseKurtosisStoryBundle(JSON.stringify(bundle)).stories).toHaveLength(18)

    const altered = structuredClone(bundle)
    altered.stories[0]!.events[0]!.to = ['not-a-node']
    expect(() => parseKurtosisStoryBundle(JSON.stringify(altered))).toThrow(/unknown node/)
  })

  /*
   * L17: the parser validated six properties and cast the rest, so a file with
   * the right schema string could still throw during render - outside the
   * importer's try/catch, leaving a blank page instead of the inline banner.
   */
  it('reconstructs the bundle rather than casting the parsed root', () => {
    const bundle = createReferenceKurtosisBundle()
    const parsed = parseKurtosisStoryBundle(
      JSON.stringify({ ...bundle, unexpectedTopLevelField: 'dropped' }),
    )
    expect(parsed).toEqual(bundle)
  })

  it('rejects a trace missing a field the player dereferences', () => {
    const reject = (mutate: (bundle: ReturnType<typeof createReferenceKurtosisBundle>) => void, message: RegExp) => {
      const altered = structuredClone(createReferenceKurtosisBundle())
      mutate(altered)
      expect(() => parseKurtosisStoryBundle(JSON.stringify(altered))).toThrow(message)
    }
    // The three boundary panels spread these unconditionally.
    reject((b) => delete (b as { assumptions?: unknown }).assumptions, /assumptions/)
    reject((b) => delete (b as { doesNotGuarantee?: unknown }).doesNotGuarantee, /doesNotGuarantee/)
    reject((b) => delete (b as { guarantees?: unknown }).guarantees, /guarantees/)
    // topology.note is rendered as the page footer.
    reject((b) => delete (b.topology as { note?: unknown }).note, /topology\.note/)
    // Colour tables are indexed by these.
    reject((b) => { b.stories[0]!.events[0]!.phase = 'made-up' as never }, /phase/)
    reject((b) => { b.stories[0]!.events[0]!.tone = 'made-up' as never }, /tone/)
    reject((b) => { b.stories[0]!.status = 'MAYBE' as never }, /status/)
  })

  it('bounds activeMembers by the declared member-client count', () => {
    const altered = structuredClone(createReferenceKurtosisBundle())
    altered.stories[0]!.activeMembers = 1e9
    expect(() => parseKurtosisStoryBundle(JSON.stringify(altered))).toThrow(/activeMembers/)
  })

  it('bounds the event count so the timing spread cannot overflow', () => {
    const altered = structuredClone(createReferenceKurtosisBundle())
    const template = altered.stories[0]!.events[0]!
    altered.stories[0]!.events = Array.from({ length: 5_000 }, (_, index) => ({
      ...structuredClone(template),
      id: `e-${index}`,
      atMs: index,
    }))
    expect(() => parseKurtosisStoryBundle(JSON.stringify(altered))).toThrow(/events/)
  })
})
