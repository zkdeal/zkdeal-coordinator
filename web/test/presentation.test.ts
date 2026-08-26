import { describe, expect, it } from 'vitest'
import {
  applicationPresentation,
  cardPresentation,
  demoPresentation,
} from '../lib/presentation'

describe('focused presentation URLs', () => {
  it('accepts only the named live demo presentations', () => {
    expect(demoPresentation('overview')).toBe('overview')
    expect(demoPresentation('room-life')).toBe('room-life')
    expect(demoPresentation('erc7540')).toBe('erc7540')
    expect(demoPresentation('dvp')).toBe('dvp')
    expect(demoPresentation('erc4626')).toBe('erc4626')
    expect(demoPresentation('amm')).toBe('amm')
    expect(demoPresentation('studio')).toBeNull()
  })

  it('selects one application or the cards presenter', () => {
    expect(applicationPresentation('auction')).toBe('auction')
    expect(applicationPresentation('shop')).toBe('shop')
    expect(applicationPresentation('both')).toBeNull()
    expect(cardPresentation('cards')).toBe(true)
    expect(cardPresentation('card')).toBe(false)
  })
})
