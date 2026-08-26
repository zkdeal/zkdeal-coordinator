import { createHash } from 'node:crypto'
import {
  commitmentsToVersionedHashes,
  hexToBytes,
  keccak256,
  parseTransaction,
  serializeTransaction,
  toBlobs,
  type Hex,
  type TransactionSerializableEIP4844,
} from 'viem'
import type { HostedRuntime } from './hosted-runtime.js'

export interface BlobBundle {
  schemaVersion: 1
  blobs: Hex[]
  commitments: Hex[]
  proofs: Hex[]
  versionedHashes: Hex[]
}

export interface IndexedBlobRequirement {
  chainId: number
  transactionHash: `0x${string}`
  blockNumber: string
  blockHash: `0x${string}`
  roomId: string
  batchIndex: string
  blobStartIndex: number
  versionedHashes: `0x${string}`[]
  commitments: `0x${string}`[]
}

type Kzg = Awaited<ReturnType<typeof import('kzg-wasm')['loadKZG']>>
let kzgPromise: Promise<Kzg> | null = null

async function kzg(): Promise<Kzg> {
  kzgPromise ??= import('kzg-wasm').then(({ loadKZG }) => loadKZG())
  return kzgPromise
}

/**
 * c-kzg WASM initialization is CPU-heavy and can briefly monopolize the Node
 * event loop. Hosted processes call this before acquiring a fencing lease so
 * first use cannot make an otherwise healthy writer miss lease renewals.
 */
export async function initializeBlobKzg(): Promise<void> {
  await kzg()
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function lowerHex(value: unknown, bytes: number, field: string): Hex {
  const text = String(value ?? '').toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${field} must be ${bytes} bytes`)
  }
  return text as Hex
}

function normalizeBundle(input: BlobBundle): BlobBundle {
  if (input.schemaVersion !== 1) throw new Error('unsupported blob bundle schema')
  if (
    input.blobs.length === 0
    || input.blobs.length > 6
    || input.commitments.length !== input.blobs.length
    || input.proofs.length !== input.blobs.length
    || input.versionedHashes.length !== input.blobs.length
  ) throw new Error('blob bundle parallel arrays are malformed')
  return {
    schemaVersion: 1,
    blobs: input.blobs.map((value) => lowerHex(value, 131_072, 'blob')),
    commitments: input.commitments.map((value) => lowerHex(value, 48, 'blob commitment')),
    proofs: input.proofs.map((value) => lowerHex(value, 48, 'blob proof')),
    versionedHashes: input.versionedHashes.map((value) => lowerHex(value, 32, 'blob versioned hash')),
  }
}

export async function buildBlobBundle(data: Hex): Promise<BlobBundle> {
  const implementation = await kzg()
  const blobs = toBlobs({ data, to: 'hex' }) as Hex[]
  const commitments = blobs.map((blob) => implementation.blobToKZGCommitment(blob) as Hex)
  const proofs = blobs.map((blob, index) =>
    implementation.computeBlobKZGProof(blob, commitments[index]!) as Hex)
  const versionedHashes = commitmentsToVersionedHashes({ commitments, to: 'hex' }) as Hex[]
  return normalizeBundle({ schemaVersion: 1, blobs, commitments, proofs, versionedHashes })
}

/**
 * Build transaction sidecars from exact, already field-encoded EIP-4844
 * blobs. Aggregate proof artifacts contain these canonical 128 KiB values;
 * passing them through `toBlobs` again would change the committed payload.
 */
export async function buildBlobBundleFromBlobs(input: readonly Hex[]): Promise<BlobBundle> {
  if (input.length === 0 || input.length > 6) throw new Error('exact blob bundle must contain 1 through 6 blobs')
  const implementation = await kzg()
  const blobs = input.map((value) => lowerHex(value, 131_072, 'exact transaction blob'))
  const commitments = blobs.map((blob) => implementation.blobToKZGCommitment(blob) as Hex)
  const proofs = blobs.map((blob,index) =>
    implementation.computeBlobKZGProof(blob,commitments[index]!) as Hex)
  const versionedHashes = commitmentsToVersionedHashes({ commitments,to:'hex' }) as Hex[]
  return verifyBlobBundle({ schemaVersion:1,blobs,commitments,proofs,versionedHashes })
}

export async function verifyBlobBundle(
  input: BlobBundle,
  expectedVersionedHashes?: readonly Hex[],
  expectedCommitments?: readonly Hex[],
): Promise<BlobBundle> {
  const bundle = normalizeBundle(input)
  const implementation = await kzg()
  const derivedHashes = commitmentsToVersionedHashes({ commitments: bundle.commitments, to: 'hex' }) as Hex[]
  for (let index = 0; index < bundle.blobs.length; index += 1) {
    const commitment = implementation.blobToKZGCommitment(bundle.blobs[index]!) as Hex
    if (commitment.toLowerCase() !== bundle.commitments[index]!.toLowerCase()) {
      throw new Error(`blob ${index} does not match its KZG commitment`)
    }
    if (derivedHashes[index]!.toLowerCase() !== bundle.versionedHashes[index]!.toLowerCase()) {
      throw new Error(`blob ${index} commitment does not match its versioned hash`)
    }
    if (!implementation.verifyBlobKZGProof(
      bundle.blobs[index]!, bundle.commitments[index]!, bundle.proofs[index]!,
    )) throw new Error(`blob ${index} KZG proof is invalid`)
  }
  if (expectedVersionedHashes) {
    const expected = expectedVersionedHashes.map((value) => lowerHex(value, 32, 'expected versioned hash'))
    if (
      expected.length !== bundle.versionedHashes.length
      || expected.some((value, index) => value !== bundle.versionedHashes[index])
    ) throw new Error('blob bundle does not match the canonical transaction versioned hashes')
  }
  if (expectedCommitments) {
    const expected = expectedCommitments.map((value) => lowerHex(value, 48, 'expected commitment'))
    if (
      expected.length !== bundle.commitments.length
      || expected.some((value, index) => value !== bundle.commitments[index])
    ) throw new Error('blob bundle does not match the indexed data-availability manifest commitments')
  }
  return bundle
}

export function encodeBlobBundle(bundle: BlobBundle): Uint8Array {
  return new TextEncoder().encode(canonical(normalizeBundle(bundle)))
}

export function decodeBlobBundle(bytes: Uint8Array): BlobBundle {
  return normalizeBundle(JSON.parse(new TextDecoder().decode(bytes)) as BlobBundle)
}

/**
 * Validate the exact EIP-4844 network payload retained for retry/broadcast.
 * The outer network wrapper is not the transaction-hash preimage, so parse it
 * and reserialize the signed body without sidecars before hashing.
 */
export async function verifySignedBlobTransaction(
  signedTransaction: Hex,
  inputBundle: BlobBundle,
): Promise<{ transactionHash: Hex; bundle: BlobBundle }> {
  const bundle = await verifyBlobBundle(inputBundle)
  const parsed = parseTransaction(signedTransaction)
  if (parsed.type !== 'eip4844') throw new Error('prepublished transaction must be EIP-4844 type 3')
  if (!parsed.r || !parsed.s || parsed.yParity === undefined) {
    throw new Error('prepublished EIP-4844 transaction must be signed')
  }
  const transactionHashes = hashes(parsed.blobVersionedHashes)
  if (
    transactionHashes.length !== bundle.versionedHashes.length
    || transactionHashes.some((value, index) => value !== bundle.versionedHashes[index])
  ) throw new Error('signed transaction blob versioned hashes do not match the archived bundle')

  const sidecars = parsed.sidecars
  if (!Array.isArray(sidecars) || sidecars.length !== bundle.blobs.length) {
    throw new Error('prepublished EIP-4844 network payload must include every blob sidecar')
  }
  for (let index = 0; index < sidecars.length; index += 1) {
    const sidecar = sidecars[index]!
    if (
      lowerHex(sidecar.blob, 131_072, 'signed transaction blob') !== bundle.blobs[index]
      || lowerHex(sidecar.commitment, 48, 'signed transaction commitment') !== bundle.commitments[index]
      || lowerHex(sidecar.proof, 48, 'signed transaction proof') !== bundle.proofs[index]
    ) throw new Error('signed transaction sidecars do not match the archived bundle')
  }

  const canonicalSignedBody = serializeTransaction({
    ...parsed,
    sidecars: undefined,
    blobs: undefined,
    kzg: undefined,
  } as TransactionSerializableEIP4844)
  return { transactionHash: keccak256(canonicalSignedBody), bundle }
}

function sourceId(url: string): string {
  return `beacon-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
}

export class BeaconSidecarClient {
  private readonly endpoints: string[]

  constructor(
    endpoints: readonly string[],
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.endpoints = endpoints.map((value) => {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('beacon sidecar endpoint must be HTTP(S)')
      return url.href.replace(/\/$/, '')
    })
    if (new Set(this.endpoints).size !== this.endpoints.length) {
      throw new Error('beacon sidecar endpoints must be distinct')
    }
  }

  async fetchBundle(
    beaconBlockRoot: Hex,
    expectedVersionedHashes: readonly Hex[],
  ): Promise<{ bundle: BlobBundle; verifiedSources: string[] }> {
    const root = lowerHex(beaconBlockRoot, 32, 'beacon block root')
    const expected = expectedVersionedHashes.map((value) => lowerHex(value, 32, 'expected versioned hash'))
    const failures: string[] = []
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.request(
          `${endpoint}/eth/v1/beacon/blob_sidecars/${root}`,
          { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as { data?: unknown[] }
        if (!Array.isArray(payload.data)) throw new Error('beacon response has no sidecar data')
        const byHash = new Map<string, { blob: Hex; commitment: Hex; proof: Hex }>()
        for (const item of payload.data) {
          if (!item || typeof item !== 'object') throw new Error('beacon sidecar is malformed')
          const sidecar = item as Record<string, unknown>
          const commitment = lowerHex(sidecar.kzg_commitment ?? sidecar.commitment, 48, 'beacon commitment')
          const [versionedHash] = commitmentsToVersionedHashes({ commitments: [commitment], to: 'hex' }) as Hex[]
          byHash.set(versionedHash!.toLowerCase(), {
            blob: lowerHex(sidecar.blob, 131_072, 'beacon blob'),
            commitment,
            proof: lowerHex(sidecar.kzg_proof ?? sidecar.proof, 48, 'beacon proof'),
          })
        }
        const selected = expected.map((hash) => byHash.get(hash))
        if (selected.some((item) => !item)) throw new Error('beacon response is missing a transaction blob')
        const bundle = await verifyBlobBundle({
          schemaVersion: 1,
          blobs: selected.map((item) => item!.blob),
          commitments: selected.map((item) => item!.commitment),
          proofs: selected.map((item) => item!.proof),
          versionedHashes: [...expected],
        }, expected)
        return { bundle, verifiedSources: [sourceId(endpoint)] }
      } catch (error) {
        failures.push(`${sourceId(endpoint)}:${error instanceof Error ? error.message : 'failure'}`)
      }
    }
    throw new Error(`blob sidecars unavailable from configured beacon providers (${failures.join(', ') || 'none configured'})`)
  }
}

function hashes(value: unknown): Hex[] {
  if (!Array.isArray(value)) throw new Error('canonical blob transaction has no versioned hash list')
  return value.map((item) => lowerHex(item, 32, 'transaction versioned hash'))
}

export class BlobArchiveCoordinator {
  private readonly beacon: BeaconSidecarClient

  constructor(
    private readonly runtime: HostedRuntime,
    beaconEndpoints: readonly string[],
    request: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.beacon = new BeaconSidecarClient(beaconEndpoints, request)
  }

  async archivePrepublished(input: {
    chainId: number
    transactionHash: `0x${string}`
    signedTransaction: Hex
    bundle: BlobBundle
  }): Promise<{
    transactionHash: Hex
    bundleObjectKey: string
    signedTransactionObjectKey: string
  }> {
    const identity = await verifySignedBlobTransaction(input.signedTransaction, input.bundle)
    if (identity.transactionHash !== input.transactionHash.toLowerCase()) {
      throw new Error('prepublished signed transaction hash does not match transactionHash')
    }
    const bundle = identity.bundle
    const bundleObject = await this.runtime.objects.putContent(encodeBlobBundle(bundle), 'application/vnd.zkdeal.blob-bundle+json')
    const signedObject = await this.runtime.objects.putContent(
      hexToBytes(input.signedTransaction), 'application/vnd.ethereum.signed-transaction',
    )
    await this.runtime.store.recordBlobArchive(this.runtime.writableFence(), {
      chainId: input.chainId,
      transactionHash: input.transactionHash,
      versionedHashes: bundle.versionedHashes,
      commitments: bundle.commitments,
      proofs: bundle.proofs,
      bundleObjectKey: bundleObject.key,
      bundleSha256: bundleObject.sha256,
      signedTransactionObjectKey: signedObject.key,
      archiveSource: 'hosted-prepublish',
      verifiedSources: ['hosted-publisher'],
    })
    return {
      transactionHash: identity.transactionHash,
      bundleObjectKey: bundleObject.key,
      signedTransactionObjectKey: signedObject.key,
    }
  }

  private async verifiedArchive(requirement: IndexedBlobRequirement): Promise<BlobBundle | null> {
    const archive = await this.runtime.store.blobArchive(requirement.chainId, requirement.transactionHash)
    if (!archive) return null
    const bytes = await this.runtime.objects.get(archive.bundleObjectKey)
    if (!bytes) throw new Error('durable blob archive object is missing')
    return verifyBlobBundle(
      decodeBlobBundle(bytes),
      archive.versionedHashes,
      archive.commitments,
    )
  }

  async ensureArchived(requirement: IndexedBlobRequirement): Promise<void> {
    const transaction = await this.runtime.l1.agreedTransaction(requirement.transactionHash)
    if (
      transaction.transaction.blockHash !== requirement.blockHash.toLowerCase()
      || BigInt(String(transaction.transaction.blockNumber)) !== BigInt(requirement.blockNumber)
    ) throw new Error('blob transaction is not bound to the indexed canonical block')
    const transactionHashes = hashes(transaction.transaction.blobVersionedHashes)
    let bundle = await this.verifiedArchive(requirement)
    if (bundle) bundle = await verifyBlobBundle(bundle, transactionHashes)
    if (!bundle) {
      const next = await this.runtime.l1.agreedBlock(`0x${(BigInt(requirement.blockNumber) + 1n).toString(16)}`)
      const beaconRoot = next.parentBeaconBlockRoot
      if (!beaconRoot) throw new Error('next canonical execution block has no parent beacon block root')
      const fetched = await this.beacon.fetchBundle(beaconRoot, transactionHashes)
      bundle = fetched.bundle
      const object = await this.runtime.objects.putContent(
        encodeBlobBundle(bundle), 'application/vnd.zkdeal.blob-bundle+json',
      )
      await this.runtime.store.recordBlobArchive(this.runtime.writableFence(), {
        chainId: requirement.chainId,
        transactionHash: requirement.transactionHash,
        versionedHashes: bundle.versionedHashes,
        commitments: bundle.commitments,
        proofs: bundle.proofs,
        bundleObjectKey: object.key,
        bundleSha256: object.sha256,
        signedTransactionObjectKey: null,
        archiveSource: 'beacon-fallback',
        verifiedSources: [...new Set([...transaction.verifiedSources, ...fetched.verifiedSources])],
      })
    }
    const start = requirement.blobStartIndex
    const hashesForRoom = bundle.versionedHashes.slice(start, start + requirement.versionedHashes.length)
    const commitmentsForRoom = bundle.commitments.slice(start, start + requirement.commitments.length)
    if (
      hashesForRoom.length !== requirement.versionedHashes.length
      || hashesForRoom.some((value, index) => value !== requirement.versionedHashes[index]?.toLowerCase())
      || commitmentsForRoom.some((value, index) => value !== requirement.commitments[index]?.toLowerCase())
    ) throw new Error('archived transaction blobs do not match the indexed room manifest range')
    await this.runtime.store.completeBlobRequirement(
      this.runtime.writableFence(), requirement, null,
    )
  }

  async recoverPending(limit = 100): Promise<{ verified: number; failed: number }> {
    const pending = await this.runtime.store.pendingBlobRequirements(limit)
    let verified = 0
    let failed = 0
    for (const requirement of pending) {
      try {
        await this.ensureArchived(requirement)
        verified += 1
      } catch (error) {
        failed += 1
        await this.runtime.store.completeBlobRequirement(
          this.runtime.writableFence(), requirement,
          error instanceof Error ? error.message.slice(0, 500) : 'blob archive verification failed',
        )
      }
    }
    return { verified, failed }
  }
}
