import { describe, expect, it } from 'vitest'
import {
  assertProductionConfirmationDepth,
  DEFAULT_PRODUCTION_CONFIRMATIONS,
  PRODUCTION_CONFIRMATION_FLOOR,
} from '../src/l1-confirmation-policy.js'

describe('production L1 confirmation policy', () => {
  it('defaults to 64 and refuses a configured depth below 12', () => {
    expect(DEFAULT_PRODUCTION_CONFIRMATIONS).toBe(64n)
    expect(PRODUCTION_CONFIRMATION_FLOOR).toBe(12n)
    expect(assertProductionConfirmationDepth(12n, 'import confirmations')).toBe(12n)
    expect(() => assertProductionConfirmationDepth(11n, 'import confirmations')).toThrow(
      /at least 12/,
    )
  })
})
