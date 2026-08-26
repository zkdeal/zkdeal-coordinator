/**
 * State machine behind the "always-online tokenized shop" demo.
 *
 * React-free so it can be unit-tested directly: the page it drives is routed
 * (`/applications`) and its whole point is showing conserved tokenized inventory
 * under a validity proof. An unclamped decrement rendered "-2 items" after six
 * cycles while still offering a purchase and reporting paid proceeds, which is
 * the exact `PersistentShop` invariant the demo exists to illustrate.
 */

export type ShopPhase = 'READY' | 'ADMITTED' | 'DISCONNECTED' | 'CHECKPOINTED' | 'CLAIMED'

/** Units allocated to the buyer by each accepted checkpoint. */
export const SHOP_UNITS_PER_PURCHASE = 2
export const SHOP_INITIAL_INVENTORY = 10

export interface ShopState {
  phase: ShopPhase
  inventory: number
  customerNumber: number
}

export function initialShopState(): ShopState {
  return { phase: 'READY', inventory: SHOP_INITIAL_INVENTORY, customerNumber: 1 }
}

/** True when the shop cannot fund another purchase. */
export function shopIsSoldOut(state: ShopState): boolean {
  return state.inventory < SHOP_UNITS_PER_PURCHASE
}

/**
 * Advance one step. A purchase can only be admitted while the inventory can
 * cover it, so the balance never goes negative and never over-allocates.
 */
export function advanceShop(state: ShopState): ShopState {
  switch (state.phase) {
    case 'READY':
      return shopIsSoldOut(state) ? state : { ...state, phase: 'ADMITTED' }
    case 'ADMITTED':
      return { ...state, phase: 'DISCONNECTED' }
    case 'DISCONNECTED':
      return {
        ...state,
        phase: 'CHECKPOINTED',
        inventory: state.inventory - SHOP_UNITS_PER_PURCHASE,
      }
    case 'CHECKPOINTED':
      return { ...state, phase: 'CLAIMED' }
    case 'CLAIMED':
      return { ...state, phase: 'READY', customerNumber: state.customerNumber + 1 }
  }
}
