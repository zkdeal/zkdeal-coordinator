/**
 * Compile-time constant injected by webpack DefinePlugin (see
 * web/next.config.mjs). `true` only when NEXT_PUBLIC_ENABLE_TEST_HOOKS === '1'
 * at build time; folded to a literal so every branch guarded by it is removed
 * from the bundle otherwise.
 *
 * Only the webpack path defines it (`next build --webpack`, pinned in
 * package.json). Read it through a `typeof` guard so a bundler that leaves the
 * identifier undeclared disables the hooks instead of throwing at runtime.
 */
declare const __ZKDEAL_TEST_HOOKS__: boolean
