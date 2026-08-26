import { describe, expect, it } from 'vitest'
import {
  BeaconSidecarClient,
  buildBlobBundle,
  decodeBlobBundle,
  encodeBlobBundle,
  verifyBlobBundle,
  type BlobBundle,
} from '../src/blob-archive.js'

function changeNibble(value: `0x${string}`): `0x${string}` {
  const nibble = value.at(-1) === '0' ? '1' : '0'
  return `${value.slice(0, -1)}${nibble}` as `0x${string}`
}

describe('EIP-4844 blob archive verification', () => {
  it('constructs, canonically encodes, and c-kzg verifies a bundle', async () => {
    const bundle = await buildBlobBundle('0x7a6b6465616c')
    expect(bundle.blobs).toHaveLength(1)
    expect(await verifyBlobBundle(bundle, bundle.versionedHashes, bundle.commitments)).toEqual(bundle)
    expect(decodeBlobBundle(encodeBlobBundle(bundle))).toEqual(bundle)
  }, 120_000)

  it('rejects corrupt blob, commitment, proof, versioned hash, and manifest bindings', async () => {
    const bundle = await buildBlobBundle('0x01020304')
    const corruptions: BlobBundle[] = [
      { ...bundle, blobs: [changeNibble(bundle.blobs[0]!)] },
      { ...bundle, commitments: [changeNibble(bundle.commitments[0]!)] },
      { ...bundle, proofs: [changeNibble(bundle.proofs[0]!)] },
      { ...bundle, versionedHashes: [changeNibble(bundle.versionedHashes[0]!)] },
    ]
    for (const corrupted of corruptions) {
      await expect(verifyBlobBundle(corrupted)).rejects.toThrow()
    }
    await expect(verifyBlobBundle(bundle, [changeNibble(bundle.versionedHashes[0]!)]))
      .rejects.toThrow('canonical transaction')
    await expect(verifyBlobBundle(bundle, undefined, [changeNibble(bundle.commitments[0]!)]))
      .rejects.toThrow('manifest commitments')
  }, 120_000)

  it('maps standard beacon sidecars by versioned hash and fails closed on missing/corrupt data', async () => {
    const bundle = await buildBlobBundle('0x05060708')
    const payload = {
      data: [{
        blob: bundle.blobs[0],
        kzg_commitment: bundle.commitments[0],
        kzg_proof: bundle.proofs[0],
      }],
    }
    const ok = new BeaconSidecarClient(
      ['https://beacon-a.example'],
      (async () => Response.json(payload)) as typeof fetch,
    )
    const fetched = await ok.fetchBundle(`0x${'11'.repeat(32)}`, bundle.versionedHashes)
    expect(fetched.bundle).toEqual(bundle)
    expect(fetched.verifiedSources).toEqual([expect.stringMatching(/^beacon-[0-9a-f]{16}$/)])

    const missing = new BeaconSidecarClient(
      ['https://beacon-a.example'],
      (async () => Response.json({ data: [] })) as typeof fetch,
    )
    await expect(missing.fetchBundle(`0x${'11'.repeat(32)}`, bundle.versionedHashes))
      .rejects.toThrow('missing a transaction blob')

    const corrupt = new BeaconSidecarClient(
      ['https://beacon-a.example'],
      (async () => Response.json({
        data: [{ ...payload.data[0], blob: changeNibble(bundle.blobs[0]!) }],
      })) as typeof fetch,
    )
    await expect(corrupt.fetchBundle(`0x${'11'.repeat(32)}`, bundle.versionedHashes))
      .rejects.toThrow('does not match its KZG commitment')
  }, 120_000)
})
