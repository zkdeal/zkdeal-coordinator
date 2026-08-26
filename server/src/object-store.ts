import { createHash, createHmac } from 'node:crypto'

export interface StoredObject {
  key: string
  sha256: string
  bytes: number
  contentType: string
}

export interface ObjectStore {
  putContent(body: Uint8Array, contentType: string): Promise<StoredObject>
  get(key: string): Promise<Uint8Array | null>
  head(key: string): Promise<StoredObject | null>
  delete(key: string): Promise<void>
}

export interface S3ObjectStoreOptions {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
  /** Optional SSE-S3 or MinIO-compatible server-side encryption. */
  serverSideEncryption?: 'AES256'
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

function hexSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function safeKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new Error('object key is malformed')
  }
  return key.split('/').map(encodePathSegment).join('/')
}

function digestFromContentKey(key: string): string {
  const match = /(?:^|\/)([0-9a-f]{64})$/.exec(key)
  if (!match) throw new Error('object key is not content-addressed')
  return match[1]!
}

/**
 * Small dependency-free S3/MinIO adapter. It signs each request with AWS
 * Signature V4 and stores bodies under their SHA-256 digest, so a database
 * row can safely point at immutable request/result/blob bytes.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: URL
  private readonly request: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly prefix: string

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.endpoint = new URL(options.endpoint)
    if (!['http:', 'https:'].includes(this.endpoint.protocol)) throw new Error('S3 endpoint must be HTTP(S)')
    if (!/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/.test(options.bucket)) throw new Error('S3 bucket is invalid')
    if (!options.region || !options.accessKeyId || options.secretAccessKey.length < 8) {
      throw new Error('S3 region and credentials are required')
    }
    this.request = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
    this.prefix = (options.prefix ?? 'zkdeal').replace(/^\/+|\/+$/g, '')
  }

  private url(key: string): URL {
    const result = new URL(this.endpoint)
    const base = result.pathname.replace(/\/$/, '')
    result.pathname = `${base}/${encodePathSegment(this.options.bucket)}/${safeKey(key)}`
    return result
  }

  private async signed(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    key: string,
    body?: Uint8Array,
    contentType?: string,
    sha256?: string,
  ): Promise<Response> {
    const url = this.url(key)
    const timestamp = this.now().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const date = timestamp.slice(0, 8)
    const payloadHash = sha256 ?? hexSha256(body ?? new Uint8Array())
    const headers = new Headers({
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
    })
    if (contentType) headers.set('content-type', contentType)
    if (sha256) headers.set('x-amz-meta-sha256', sha256)
    if (this.options.serverSideEncryption && method === 'PUT') {
      headers.set('x-amz-server-side-encryption', this.options.serverSideEncryption)
    }
    const signedHeaders = [...headers.keys()].sort()
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers.get(name)!.trim()}\n`).join('')
    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n')
    const scope = `${date}/${this.options.region}/s3/aws4_request`
    const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hexSha256(canonicalRequest)}`
    const dateKey = hmac(`AWS4${this.options.secretAccessKey}`, date)
    const regionKey = hmac(dateKey, this.options.region)
    const serviceKey = hmac(regionKey, 's3')
    const signingKey = hmac(serviceKey, 'aws4_request')
    const signature = hmac(signingKey, toSign).toString('hex')
    headers.set(
      'authorization',
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    )
    return this.request(url, { method, headers, body: body ? Buffer.from(body) : undefined })
  }

  async putContent(body: Uint8Array, contentType: string): Promise<StoredObject> {
    const sha256 = hexSha256(body)
    const key = `${this.prefix}/sha256/${sha256.slice(0, 2)}/${sha256}`
    const existing = await this.head(key)
    if (existing) {
      if (existing.sha256 !== sha256 || existing.bytes !== body.byteLength) {
        throw new Error('content-addressed object metadata does not match its key')
      }
      return existing
    }
    const response = await this.signed('PUT', key, body, contentType, sha256)
    if (!response.ok) throw new Error(`S3 PUT failed with status ${response.status}`)
    const stored = await this.head(key)
    if (!stored || stored.sha256 !== sha256 || stored.bytes !== body.byteLength) {
      throw new Error('S3 object did not pass the post-write integrity check')
    }
    const roundTrip = await this.get(key)
    if (!roundTrip || roundTrip.byteLength !== body.byteLength || hexSha256(roundTrip) !== sha256) {
      throw new Error('S3 object did not pass the post-write retrieval check')
    }
    return stored
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.signed('GET', key)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`S3 GET failed with status ${response.status}`)
    const body = new Uint8Array(await response.arrayBuffer())
    const keyDigest = digestFromContentKey(key)
    const expected = response.headers.get('x-amz-meta-sha256')
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error('S3 object is missing immutable content metadata')
    }
    const actual = hexSha256(body)
    if (actual !== expected || actual !== keyDigest) throw new Error('S3 object digest mismatch')
    return body
  }

  async head(key: string): Promise<StoredObject | null> {
    const response = await this.signed('HEAD', key)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`S3 HEAD failed with status ${response.status}`)
    const sha256 = response.headers.get('x-amz-meta-sha256')
    const bytes = Number(response.headers.get('content-length'))
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('S3 object is missing immutable content metadata')
    }
    if (sha256 !== digestFromContentKey(key)) throw new Error('S3 object metadata does not match its content key')
    return {
      key,
      sha256,
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.signed('DELETE', key)
    if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE failed with status ${response.status}`)
  }
}
