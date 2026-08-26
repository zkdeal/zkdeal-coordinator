/**
 * Prover-host capability preflight for demo templates.
 *
 * A preset may need a room shape the configured prover cannot build - the
 * hidden-card duel needs five pinned contracts, a participant registry at slots
 * 0-3 and caller-specific STATICCALL rules, and only a host that derives the
 * matching `roomCapabilities` tokens can express them. Checking that BEFORE any
 * contract is deployed or any cold proof is started is the difference between a
 * precise refusal and either an opaque rejection minutes later or, worse, a room
 * that quietly proved a different workload than the preset advertises.
 */

import { describeCardRoomCapabilityGap, reportedRoomCapabilities } from './card-room.js'
import {
  ERC7540_WORKLOAD,
  describeErc7540CapabilityGap,
} from './erc7540-room.js'
import { presetOf } from './demo-runtime-spec.js'
import type { DemoTemplate } from './demo-types.js'
import { AMM_WORKLOAD, describeAmmCapabilityGap } from './amm-room.js'
import { ERC4626_WORKLOAD, describeErc4626CapabilityGap } from './erc4626-room.js'

/** How long to wait for the capability document before treating it as absent. */
const CAPABILITY_TIMEOUT_MS = 5_000

/**
 * The host's capability document, or null when it cannot be read. Never
 * cached: a host restarted with a different image must not be judged on a
 * stale claim.
 */
export async function readProverCapabilities(proverUrl: string): Promise<unknown | null> {
  try {
    const response = await fetch(`${proverUrl}/v5/capabilities`, {
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Throw, naming every missing capability, when the template's preset needs one
 * the host does not report. Templates whose preset declares no capability
 * requirement are unaffected.
 */
export async function assertPreparableTemplate(
  proverUrl: string,
  template: DemoTemplate,
): Promise<void> {
  const required = presetOf(template)?.proverCapabilities ?? []
  if (required.length === 0) return
  const reported = reportedRoomCapabilities(await readProverCapabilities(proverUrl))
  const missing = required.filter((token) => !reported.has(token))
  if (missing.length > 0) {
    const workload = presetOf(template)?.workload
    throw new Error(
      workload === ERC7540_WORKLOAD
        ? describeErc7540CapabilityGap(missing)
        : workload === ERC4626_WORKLOAD
          ? describeErc4626CapabilityGap(missing)
        : workload === AMM_WORKLOAD
          ? describeAmmCapabilityGap(missing)
          : describeCardRoomCapabilityGap(missing),
    )
  }
}
