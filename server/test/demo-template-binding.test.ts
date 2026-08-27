import { describe, expect, it } from 'vitest'

import { coldTemplateExitRouteBound } from '../src/demo-template-binding.js'

describe('demo cold-template exit-route binding', () => {
  it('recognizes the named and positional registry tuple shapes', () => {
    expect(coldTemplateExitRouteBound({ exitRouteBound: true })).toBe(true)
    expect(coldTemplateExitRouteBound([0, 0, 0, 0, 0, 0, true, 0, true])).toBe(true)
  })

  it('keeps absent, malformed, and explicitly unbound templates fail-closed', () => {
    expect(coldTemplateExitRouteBound({ exitRouteBound: false })).toBe(false)
    expect(coldTemplateExitRouteBound([0, 0, 0, 0, 0, 0, true, 0, false])).toBe(false)
    expect(coldTemplateExitRouteBound({ exists: true })).toBe(false)
    expect(coldTemplateExitRouteBound(null)).toBe(false)
  })
})
