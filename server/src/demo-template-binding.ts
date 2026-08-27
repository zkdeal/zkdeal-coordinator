/**
 * viem returns a named object for a named Solidity tuple and a positional
 * array for an unnamed one. `exitRouteBound` is the ninth and last field in
 * ColdTemplateRegistry.Template; accept only an explicit boolean true from
 * either representation so an unfamiliar ABI shape remains fail-closed.
 */
export function coldTemplateExitRouteBound(value: unknown): boolean {
  if (Array.isArray(value)) return value[8] === true
  if (value === null || typeof value !== 'object') return false
  return (value as { exitRouteBound?: unknown }).exitRouteBound === true
}
