export const DEMO_PRESENTATIONS = [
  'overview',
  'room-life',
  'erc7540',
  'dvp',
  'erc4626',
  'amm',
] as const
export type DemoPresentation = (typeof DEMO_PRESENTATIONS)[number]

export const APPLICATION_PRESENTATIONS = ['auction', 'shop'] as const
export type ApplicationPresentation = (typeof APPLICATION_PRESENTATIONS)[number]

function one(value: string | null): string | null {
  return value?.trim().toLowerCase() || null
}

export function demoPresentation(value: string | null): DemoPresentation | null {
  const candidate = one(value)
  return DEMO_PRESENTATIONS.find((entry) => entry === candidate) ?? null
}

export function applicationPresentation(value: string | null): ApplicationPresentation | null {
  const candidate = one(value)
  return APPLICATION_PRESENTATIONS.find((entry) => entry === candidate) ?? null
}

export function cardPresentation(value: string | null): boolean {
  return one(value) === 'cards'
}
