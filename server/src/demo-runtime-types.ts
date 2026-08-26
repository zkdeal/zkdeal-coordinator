import type { Abi, Hex } from 'viem'

export interface Artifact {
  abi: Abi
  bytecode: { object: Hex } | Hex
  deployedBytecode?: { object: Hex } | Hex
}

export interface DemoEvidence {
  decision?: string
  contracts?: Record<string, Hex>
  transactions?: Record<string, Hex | string>
  exactDeadline?: { startBlock?: string; proofDeadlineBlock?: string }
  gpuCalibration?: {
    gpuName?: string
    samplesSeconds?: number[]
    medianSeconds?: number
    maximumSeconds?: number
    recommendedProofSeconds?: number
    recommendedDeadlineBlocks?: number
  }
}

export const ROOM_CREATED_EVENT_ABI = [
  {
    type: 'event',
    name: 'RoomCreated',
    inputs: [
      { name: 'roomId', type: 'uint64', indexed: true },
      { name: 'coldTemplateId', type: 'bytes32', indexed: true },
      { name: 'initialApproverRoot', type: 'bytes32', indexed: true },
      { name: 'activeApproverCount', type: 'uint64', indexed: false },
      { name: 'authorizationMode', type: 'uint8', indexed: false },
      { name: 'participantCapacity', type: 'uint64', indexed: false },
    ],
  },
] as const

export interface PreparedResponse {
  coldRequest: Record<string, unknown>
  roomRequest: Record<string, unknown>
  contractConfig: {
    templateId: Hex
    initialStateRoot: Hex
    policyHash: Hex
    proofProgramId: Hex
    proofSystemVersion: Hex
    initialApproverRoot: Hex
    initialActiveCount: number
    initialParticipantRoot: Hex
    initialParticipantCount: number
    /** keccak256 of the framed canonical cold witness bytes below. */
    genesisDataHash: Hex
    /** The exact framed canonical witness bytes the registry statement binds. */
    canonicalColdTemplateData: Hex
  }
}

export interface ProofResult {
  receiptB64: string
  ethereumSealB64: string
  journal?: Record<string, unknown>
  journalHash: Hex
  profile?: Record<string, number>
  proofMode: string
}

export interface DemoLiveRuntimeOptions {
  l1RpcUrl: string
  /** Independent endpoints for critical settlement/finality reads. */
  l1RpcUrls?: readonly string[]
  proverUrl: string
  contractsRoot: string
  evidencePath: string
  explorerUrl?: string | null
  apiUrl?: string | null
  deployerKey?: Hex
  /**
   * Shared prove-queue base URL (QUEUE_URL). When set, `post()` submits
   * each prover request as a queue job and polls for the verbatim prover
   * JSON instead of calling `proverUrl` directly. Health and capability
   * probes still read `proverUrl` - the queue carries jobs, not liveness.
   */
  queueUrl?: string | null
  /** Bearer credential for the queue's submitter surface. */
  queueSubmitToken?: string | null
}
