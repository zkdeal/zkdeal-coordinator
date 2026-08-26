import { describe, expect, it } from 'vitest'
import {
  advanceShop,
  initialShopState,
  shopIsSoldOut,
  SHOP_INITIAL_INVENTORY,
  SHOP_UNITS_PER_PURCHASE,
} from '../lib/shop-demo'

/**
 * L21: the shop demo decremented inventory with no floor, so six cycles of the
 * primary button rendered "-2 items" while still offering a purchase and
 * reporting paid proceeds - on the page whose stated purpose is showing
 * conserved tokenized inventory under a validity proof.
 */
describe('shop demo state machine', () => {
  const cycle = (state: ReturnType<typeof initialShopState>) =>
    [0, 1, 2, 3, 4].reduce((current) => advanceShop(current), state)

  it('allocates exactly one purchase per customer cycle', () => {
    const after = cycle(initialShopState())
    expect(after.phase).toBe('READY')
    expect(after.customerNumber).toBe(2)
    expect(after.inventory).toBe(SHOP_INITIAL_INVENTORY - SHOP_UNITS_PER_PURCHASE)
  })

  it('never lets inventory go negative, however many cycles run', () => {
    let state = initialShopState()
    for (let i = 0; i < 20; i += 1) state = cycle(state)
    expect(state.inventory).toBe(0)
    expect(state.phase).toBe('READY')
  })

  it('refuses to admit a purchase once the shop is sold out', () => {
    let state = initialShopState()
    for (let i = 0; i < SHOP_INITIAL_INVENTORY / SHOP_UNITS_PER_PURCHASE; i += 1) {
      state = cycle(state)
    }
    expect(shopIsSoldOut(state)).toBe(true)
    expect(advanceShop(state)).toEqual(state)
  })
})
