export const PRODUCTION_CONFIRMATION_FLOOR = 12n
export const DEFAULT_PRODUCTION_CONFIRMATIONS = 64n

/** Throw before an API/config value below the production safety floor reaches L1. */
export function assertProductionConfirmationDepth(value: bigint, label: string): bigint {
  if (value < PRODUCTION_CONFIRMATION_FLOOR) {
    throw new Error(
      `${label} must be at least ${PRODUCTION_CONFIRMATION_FLOOR} blocks for a production room`,
    )
  }
  return value
}
