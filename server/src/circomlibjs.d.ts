/**
 * Required even though no file in `server/` imports `circomlibjs`:
 * `@zkdeal/protocol` is consumed as source, so `tsc --noEmit` typechecks
 * `protocol/src/eddsa.ts` and `protocol/src/protocol.ts` inside this project
 * and needs the ambient module here. Deleting this file fails the build.
 */
declare module 'circomlibjs' {
  export interface FField {
    p: bigint
    toObject(e: unknown): bigint
    e(v: bigint | number | string): unknown
    eq(a: unknown, b: unknown): boolean
  }
  export interface Poseidon {
    (inputs: ReadonlyArray<bigint | number | string | unknown>, initState?: unknown): unknown
    F: FField
  }
  export interface EddsaSignature {
    R8: [unknown, unknown]
    S: bigint
  }
  export interface Eddsa {
    prv2pub(prv: Uint8Array): [unknown, unknown]
    signPoseidon(prv: Uint8Array, msg: unknown): EddsaSignature
    verifyPoseidon(msg: unknown, sig: EddsaSignature, pub: [unknown, unknown]): boolean
    F: FField
  }
  export function buildPoseidon(): Promise<Poseidon>
  export function buildEddsa(): Promise<Eddsa>
}
