import { CARD_ROOM_PLAYERS } from '@zkdeal/protocol'
import type { Hex } from 'viem'
import { DEMO_PRESETS, type DemoPreset, type DemoTemplate } from './demo-control.js'
import { CARD_ROOM_WORKLOAD } from './card-room.js'
import { buildCardRoomRequest, type CardRoomDeployment } from './card-request.js'
import { ERC7540_WORKLOAD } from './erc7540-room.js'
import {
  buildErc7540RoomRequest,
  type Erc7540RoomDeployment,
} from './erc7540-request.js'
import { AMM_WORKLOAD } from './amm-room.js'
import { NAIVE_AMM_WORKLOAD } from './naive-amm-room.js'
import { ERC4626_WORKLOAD } from './erc4626-room.js'
import {
  buildErc4626RoomRequest,
  type Erc4626RoomDeployment,
} from './erc4626-request.js'

/** The preset a stored template was created from, if any. */
export function presetOf(template: DemoTemplate): DemoPreset | null {
  return (
    (template.presetId ? DEMO_PRESETS.find((item) => item.id === template.presetId) : null) ?? null
  )
}

/**
 * The moves one batch carries, split across the room's two L2 blocks.
 *
 * `calldata` is what the host signs itself with its fixture key - the
 * historical `blockCalls` path, which only a single-signer storage room can
 * use. `signed` is the browser's own EIP-2718 envelopes, which `blocks.rs`
 * consumes as `rawTransactions` ahead of everything else and which is the ONLY
 * way a duel move a player built actually reaches the state transition.
 */
export interface RoomMoves {
  calldata: [string[], string[]]
  blockCalls?: [
    Array<{ calldata: string; signerIndex: number; gasLimit: number }>,
    Array<{ calldata: string; signerIndex: number; gasLimit: number }>,
  ]
  signed?: [string[], string[]]
}

/**
 * The prover-service request shape shared by cold preparation and room
 * checkpointing. Derived entirely from the stored template, so it stays
 * reproducible from the persisted demo state alone.
 *
 * A `card-duel` request is the one shape that cannot be derived from the
 * template alone: the host refuses the workload without a `contracts`
 * descriptor carrying REAL per-address runtime code, and that code only exists
 * once the five duel accounts have been deployed and read back. `cardRoom`
 * supplies it; omitting it for a duel template is a loud failure rather than a
 * request the host rejects one step later.
 */
export function baseSpec(
  template: DemoTemplate,
  roomId: number,
  l1InclusionDeadline: number,
  deploymentDomain: Hex,
  moves?: RoomMoves,
  contractAddress?: Hex | null,
  cardRoom?: CardRoomDeployment | null,
  erc7540Room?: Erc7540RoomDeployment | null,
  erc4626Room?: Erc4626RoomDeployment | null,
): Record<string, unknown> {
  const preset = presetOf(template)
  const fallbackSelector = template.allowedSelectors[0] ?? '0x00000000'
  const fallbackCalls: [string[], string[]] = [
    [`${fallbackSelector}${'0'.repeat(63)}9`],
    [`${fallbackSelector}${'0'.repeat(63)}a`],
  ]
  const selected = template.selectedState.filter((item) => item.mode !== 'EXCLUDED')
  const imports = selected.filter((item) => item.mode === 'L1_MIRROR').length
  // A single-contract, single-participant room was the only shape the fixture
  // could express, so these were literals. A preset that touches several
  // pinned contracts (the card duel touches five) or several participant
  // leaves per move declares its own counts.
  const workload = preset?.workload ?? 'storage'
  const duel = workload === CARD_ROOM_WORKLOAD
  const erc7540 = workload === ERC7540_WORKLOAD
  const erc4626 = workload === ERC4626_WORKLOAD
  // Both AMM presets share the flat multi-signer `blockCalls` + `initialStorage`
  // request shape: a clone-shaped room with per-block, per-signer calls over one
  // pinned runtime. Only the ordering discipline (commit-reveal vs sequenced)
  // differs, and that lives in the contract, not the request.
  const amm = workload === AMM_WORKLOAD || workload === NAIVE_AMM_WORKLOAD
  const touchedContracts = preset?.touchedContracts ?? 1
  const residentAccounts = preset?.residentAccounts ?? 2
  if (duel && !cardRoom) {
    throw new Error(
      'a card-duel room request needs the deployed duel, proof adapter, deck and hand verifiers ' +
        'and stake token: the prover host builds no bytecode for this workload and refuses a ' +
        'request without a `contracts` descriptor, a `cardDuel` object and `callRules`',
    )
  }
  if (duel && cardRoom!.participantCapacity !== template.participantCapacity) {
    // `MerkleParticipants` writes the capacity in its constructor and the host
    // compares the request against the storage word it reads back, so a
    // template edited away from the deployed duel is refused here rather than
    // as "the opening participant capacity slot holds ..." minutes later.
    throw new Error(
      `the deployed duel was built for a participant capacity of ${cardRoom!.participantCapacity}, ` +
        `but the template asks for ${template.participantCapacity}`,
    )
  }
  if (erc7540 && !erc7540Room) {
    throw new Error(
      'an ERC-7540 room needs the deployed vault and asset-token runtimes; the generic storage ' +
        'placeholder cannot execute this preset',
    )
  }
  if (erc7540 && erc7540Room!.participantCapacity !== template.participantCapacity) {
    throw new Error('the deployed ERC-7540 room capacity differs from the prepared template')
  }
  if (erc4626 && !erc4626Room) {
    throw new Error(
      'an ERC-4626 room needs the deployed vault and asset-token runtimes; the generic storage '
        + 'placeholder cannot execute this preset',
    )
  }
  if (erc4626 && erc4626Room!.participantCapacity !== template.participantCapacity) {
    throw new Error('the deployed ERC-4626 room capacity differs from the prepared template')
  }
  // The host signs one fixture key per seat, so a duel room's opening state
  // holds two externally-owned accounts on top of its pinned contracts.
  const minimumResident = duel
    ? touchedContracts + CARD_ROOM_PLAYERS
    : erc7540
      ? touchedContracts + 3
      : erc4626
        ? touchedContracts + 2
      : amm
        ? touchedContracts + 3
      : touchedContracts + 1
  const pending = (moves?.calldata[0].length ?? 0) + (moves?.calldata[1].length ?? 0)
  if (duel && pending > 0 && !moves?.signed) {
    // THE SILENT DROP THIS REPLACES. `blocks.rs` consumes `blockCalls` before
    // it ever reaches the card plan, so this function used to answer a duel
    // checkpoint by throwing the caller's moves away and sending the scripted
    // registerDuelist/openDuel/joinDuel plan instead - producing a real L1
    // transaction hash for a duel nobody played. A duel move can only be proved
    // as the browser's own signed envelope, so a move without one is refused.
    throw new Error(
      `this checkpoint carries ${pending} duel move(s) with calldata but no signed transaction. ` +
        'A duel move is proved as the player\'s own EIP-2718 envelope through `rawTransactions`; ' +
        'the host signs only its scripted opening plan, so accepting calldata alone would prove a ' +
        'batch the players did not make. Submit each move with its signed envelope.',
    )
  }
  return {
    deploymentDomain,
    roomId,
    l1ChainId: 31_337,
    l1InclusionDeadline,
    authorizationMode:
      template.authorizationMode === 'VALIDITY_ONLY' ? 'validity-only' : 'unanimous-approvers',
    activeSigners: template.activeApprovers,
    participantCapacity: template.participantCapacity,
    registeredParticipants: preset?.registeredParticipants ?? 1,
    touchedParticipants: preset?.touchedParticipants ?? 1,
    touchedContracts,
    // The fixture requires residentAccounts >= signers + touchedContracts; a
    // preset may raise it but may not undercut the accounts it says it touches.
    residentAccounts: Math.max(residentAccounts, minimumResident),
    residentMirrorVariables: Math.max(1, selected.length - imports),
    importedVariables: imports,
    workload,
    stateCommitment: 'mpt',
    allowedSelectors: template.allowedSelectors,
    // `blocks.rs` consumes `blockCalls` BEFORE it reaches the card plan, so a
    // duel room that carried them would silently prove one-signer storage
    // writes instead of registerDuelist/openDuel/joinDuel; and a descriptor
    // room's storage is per-address, so a flat `initialStorage` beside it would
    // be a second declaration the host silently ignores.
    ...(duel
      ? buildCardRoomRequest(cardRoom!)
      : erc7540
        ? {
            ...buildErc7540RoomRequest(erc7540Room!),
            blockCalls:
              moves?.blockCalls
              ?? [
                preset!.actions
                  .filter((action) => action.recommendedBlock === 1)
                  .map((action) => ({
                    calldata: action.calldata,
                    signerIndex: action.fixtureSignerIndex!,
                    gasLimit: action.gasLimit!,
                  })),
                preset!.actions
                  .filter((action) => action.recommendedBlock === 2)
                  .map((action) => ({
                    calldata: action.calldata,
                    signerIndex: action.fixtureSignerIndex!,
                    gasLimit: action.gasLimit!,
                  })),
              ],
          }
        : erc4626
          ? {
              ...buildErc4626RoomRequest(erc4626Room!),
              ...(moves?.signed
                ? {}
                : {
                    blockCalls:
                      moves?.blockCalls
                      ?? [
                        preset!.actions
                          .filter((action) => action.recommendedBlock === 1)
                          .map((action) => ({
                            calldata: action.calldata,
                            signerIndex: action.fixtureSignerIndex!,
                            gasLimit: action.gasLimit!,
                          })),
                        preset!.actions
                          .filter((action) => action.recommendedBlock === 2)
                          .map((action) => ({
                            calldata: action.calldata,
                            signerIndex: action.fixtureSignerIndex!,
                            gasLimit: action.gasLimit!,
                          })),
                      ],
                  }),
            }
        : amm
          ? {
              initialStorage: selected.map((item) => ({ slot: item.slot, value: item.value })),
              blockCalls:
                moves?.blockCalls
                ?? [
                  preset!.actions
                    .filter((action) => action.recommendedBlock === 1)
                    .map((action) => ({
                      calldata: action.calldata,
                      signerIndex: action.fixtureSignerIndex!,
                      gasLimit: action.gasLimit!,
                    })),
                  preset!.actions
                    .filter((action) => action.recommendedBlock === 2)
                    .map((action) => ({
                      calldata: action.calldata,
                      signerIndex: action.fixtureSignerIndex!,
                      gasLimit: action.gasLimit!,
                    })),
                ],
            }
      : {
          initialStorage: selected.map((item) => ({ slot: item.slot, value: item.value })),
          blockCalls: moves?.calldata ?? fallbackCalls,
        }),
    // Browser-signed moves. `rawTransactions` outranks both `blockCalls` and
    // the card plan in `blocks.rs`, and the host refuses a request that carries
    // it alongside `blockCalls`, so it is emitted alone.
    //
    // No `senderAccounts`: a duel seat is owned by the prover's own fixture
    // signer (`cardRoomFixtureSigner`), the address the cold state funds and
    // allowances, so the browser signs as a seat the room already holds. An
    // envelope from any other key is refused by the host by name.
    ...(moves?.signed ? { rawTransactions: moves.signed } : {}),
    // Per-contract descriptors carry their own runtime code; the flat runtime
    // and the single primary address describe clone-shaped rooms only.
    ...(!duel && !erc7540 && !erc4626 && template.runtimeCode
      ? { runtimeCode: template.runtimeCode }
      : {}),
    ...(!duel && !erc7540 && !erc4626 && contractAddress ? { contractAddress } : {}),
  }
}
