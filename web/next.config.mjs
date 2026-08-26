/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  transpilePackages: [
    '@zkdeal/card',
    '@zkdeal/protocol',
    '@zkdeal/l2-engine',
    '@zkdeal/p2p',
    '@zkdeal/prover',
    '@zkdeal/room-client',
    '@zkdeal/zkvm',
  ],
  // Next 16 defaults to Turbopack; empty config acknowledges that.
  // Use `next build --webpack` when node builtin fallbacks are required.
  turbopack: {},
  webpack: (config, { isServer, webpack }) => {
    config.resolve = config.resolve ?? {}
    /*
     * Test-hook kill switch.
     *
     * `process.env.NEXT_PUBLIC_*` is only inlined by Next when the variable is
     * actually SET, so an unset flag stayed a runtime lookup and the
     * `import('./test-hooks')` behind it survived into the production bundle -
     * exactly the shipped `window.__zkdeal` the review found. Defining our
     * own boolean unconditionally makes the branch a compile-time constant, so
     * the whole test-hook module graph is dead-code-eliminated whenever the
     * flag is not exactly '1'. web/scripts/assert-bundle.mjs verifies the
     * emitted output either way.
     *
     * Turbopack (Next 16's default) has no DefinePlugin equivalent, which is
     * why `dev` and `build` pin `--webpack`. Readers must still go through a
     * `typeof __ZKDEAL_TEST_HOOKS__ !== 'undefined'` guard so a Turbopack
     * build disables the hooks rather than throwing a ReferenceError.
     */
    config.plugins.push(
      new webpack.DefinePlugin({
        __ZKDEAL_TEST_HOOKS__: JSON.stringify(
          process.env.NEXT_PUBLIC_ENABLE_TEST_HOOKS === '1',
        ),
      }),
    )
    // Workspace packages use TypeScript ESM (import './x.js' → x.ts).
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        os: false,
        module: false,
        net: false,
        tls: false,
        child_process: false,
      }
      // @zkdeal/prover dynamically imports node:fs/promises for Node paths;
      // strip the node: scheme so fallbacks apply in the browser bundle.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '')
        }),
      )
    }
    return config
  },
}

/*
 * COOP / COEP: static export cannot set response headers. In production the
 * coordinator serves this SPA with:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * so SharedArrayBuffer multithreaded proving works.
 *
 * For `next dev` local proving tests we attach the same headers below
 * (NODE_ENV !== 'production' at config load time during `next dev`).
 */
if (process.env.NODE_ENV !== 'production') {
  nextConfig.headers = async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      ],
    },
  ]
}

export default nextConfig
