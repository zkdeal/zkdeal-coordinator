import { checkpointPolicyDocument } from './demo-checkpoint-policy.js'
import { roomSettingsDocument } from './demo-room-settings.js'
import type { DemoSystemStatus } from './demo-control.js'
import type { DemoEvidence, DemoLiveRuntimeOptions } from './demo-runtime-types.js'

export function shortReference(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Fold already-probed service results and the startup canary evidence into the
 * public demo status document. Pure: every live probe happens in the caller.
 */
export function summarizeSystem(
  services: DemoSystemStatus['services'],
  evidence: DemoEvidence | null,
  options: DemoLiveRuntimeOptions,
  /** Read from the RoomManager, or null when the chain could not be read. */
  deploymentDomain: string | null = null,
): DemoSystemStatus {
  // `reference` stays for display; `address` is what a viewer opens in the
  // explorer, so it is published whole rather than shortened into uselessness.
  const contracts = Object.entries(evidence?.contracts ?? {}).map(([label, address]) => ({
    label,
    reference: shortReference(address),
    address,
  }))
  const calibration = evidence?.gpuCalibration
  const gpu =
    calibration?.samplesSeconds && calibration.samplesSeconds.length > 0
      ? {
          name: calibration.gpuName ?? 'Current CUDA GPU',
          samplesSeconds: calibration.samplesSeconds,
          medianSeconds: calibration.medianSeconds ?? median(calibration.samplesSeconds),
          maximumSeconds: calibration.maximumSeconds ?? Math.max(...calibration.samplesSeconds),
          recommendedProofSeconds:
            calibration.recommendedProofSeconds ??
            Math.ceil(Math.max(12, Math.max(...calibration.samplesSeconds) * 1.25 + 2)),
          recommendedDeadlineBlocks:
            calibration.recommendedDeadlineBlocks ??
            Math.ceil(
              (Math.ceil(Math.max(12, Math.max(...calibration.samplesSeconds) * 1.25 + 2)) + 12) /
                12,
            ),
        }
      : null
  const canaryTx = evidence?.transactions?.submit
  const canaryBlock = evidence?.transactions?.submitBlock
  const ready = services.every((item) => item.status === 'READY') && Boolean(canaryTx)
  return {
    decision: ready ? 'READY' : services.some((item) => item.status === 'FAILED') ? 'DEGRADED' : 'STARTING',
    services,
    gpu,
    contracts,
    canary:
      typeof canaryTx === 'string' && canaryTx.startsWith('0x') && canaryBlock
        ? {
            roomReference: 'Room 1',
            l1Block: canaryBlock,
            transactionReference: shortReference(canaryTx),
            l1TransactionHash: canaryTx,
            explorerUrl: options.explorerUrl ? `${options.explorerUrl}/tx/${canaryTx}` : null,
          }
        : null,
    explorerUrl: options.explorerUrl ?? null,
    apiUrl: options.apiUrl ?? null,
    deploymentDomain,
    checkpointPolicy: checkpointPolicyDocument(),
    roomSettings: roomSettingsDocument(),
    // The queue belongs to the controller process, not to the probed services;
    // `DemoController.system` replaces this with the live one.
    provingQueue: { active: null, waiting: [] },
  }
}
