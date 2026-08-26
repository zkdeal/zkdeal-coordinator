import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeRequestPath, resolveFile } from '../scripts/serve-out.mjs'

/**
 * M1: `resolveFile` decoded the request path with a bare `decodeURIComponent`,
 * called synchronously from the `createServer` callback with no try/catch. A
 * `URIError` thrown from a request listener is an uncaught exception, so
 * `GET /%` terminated the process - an unauthenticated one-request denial of
 * service on any instance started with HOST=0.0.0.0.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('static server path decoding', () => {
  it('returns null instead of throwing on malformed percent-encoding', () => {
    for (const bad of ['/%', '/%zz', '/%FF', '/a/%E0%A4%A', '/%C0%80%']) {
      expect(decodeRequestPath(bad)).toBeNull()
    }
  })

  it('still decodes well-formed paths, stripping query and hash', () => {
    expect(decodeRequestPath('/room%20pool/index.html?a=1#frag')).toBe('/room pool/index.html')
    expect(decodeRequestPath('/')).toBe('/')
    expect(decodeRequestPath('/%2Findex.html')).toBe('//index.html')
  })

  it('keeps confining resolved paths to the served root', () => {
    // A leading slash makes `normalize` clamp the `..` segments at the root;
    // a decoded path without one would escape, so the prefix check still runs.
    expect(resolveFile('../../package.json', root)).toBeNull()
    expect(resolveFile('/../../package.json', root)).toBe(resolve(root, 'package.json'))
    expect(resolveFile('/package.json', root)).toBe(resolve(root, 'package.json'))
  })
})
