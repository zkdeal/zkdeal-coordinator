import {
  ERC7540_PARTICIPANT_REGISTRY_SLOTS,
  buildErc7540AssetStorage,
  buildErc7540VaultStorage,
  emptyParticipantRoot,
} from '@zkdeal/protocol'
import type { Hex } from 'viem'
import {
  ERC7540_ALICE,
  ERC7540_BOB,
  ERC7540_TOKEN_SELECTORS,
  erc7540AllowedSelectors,
} from './erc7540-room.js'

export interface Erc7540RoomAccount {
  address: Hex
  runtimeCode: Hex
}

export interface Erc7540RoomDeployment {
  vault: Erc7540RoomAccount
  assetToken: Erc7540RoomAccount
  alice: Hex
  bob: Hex
  manager: Hex
  participantCapacity: number
}

function checkedAccount(role: string, account: Erc7540RoomAccount): Erc7540RoomAccount {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account.address) || BigInt(account.address) === 0n) {
    throw new Error(`the ERC-7540 ${role} needs a non-zero 20-byte address`)
  }
  if (!/^0x[0-9a-fA-F]+$/.test(account.runtimeCode) || account.runtimeCode.length <= 2) {
    throw new Error(`the ERC-7540 ${role} needs deployed runtime code`)
  }
  return { address: account.address.toLowerCase() as Hex, runtimeCode: account.runtimeCode }
}

export function buildErc7540RoomRequest(
  deployment: Erc7540RoomDeployment,
): Record<string, unknown> {
  const vault = checkedAccount('vault', deployment.vault)
  const assetToken = checkedAccount('asset token', deployment.assetToken)
  if (vault.address === assetToken.address) throw new Error('vault and asset token must be distinct')
  if (
    deployment.alice.toLowerCase() !== ERC7540_ALICE.toLowerCase()
    || deployment.bob.toLowerCase() !== ERC7540_BOB.toLowerCase()
  ) {
    throw new Error('the ERC-7540 cold state must fund fixture signers zero and one')
  }
  const participantRoot = emptyParticipantRoot(deployment.participantCapacity)
  const vaultStorage = buildErc7540VaultStorage({
    assetToken: assetToken.address,
    vault: vault.address,
    controllers: [deployment.alice, deployment.bob],
    participantRoot,
    participantCapacity: deployment.participantCapacity,
  })
  const tokenStorage = buildErc7540AssetStorage({
    vault: vault.address,
    owners: [deployment.alice, deployment.bob],
    balancePerOwner: 1_000n,
  })
  const registry = ERC7540_PARTICIPANT_REGISTRY_SLOTS
  return {
    signerAccounts: 3,
    maxTransactionsPerBlock: 6,
    residentMirrorVariables: vaultStorage.length + tokenStorage.length,
    contracts: [
      {
        role: 'vault',
        address: vault.address,
        runtimeCode: vault.runtimeCode,
        writable: true,
        prefixBits: 0,
        slotPrefix: '0',
        initialStorage: vaultStorage,
      },
      {
        role: 'assetToken',
        address: assetToken.address,
        runtimeCode: assetToken.runtimeCode,
        writable: true,
        prefixBits: 0,
        slotPrefix: '0',
        initialStorage: tokenStorage,
      },
    ],
    callRules: [
      {
        caller: 'active-member',
        target: vault.address,
        selectors: erc7540AllowedSelectors(),
        kinds: [0],
      },
      {
        caller: vault.address,
        target: assetToken.address,
        selectors: ERC7540_TOKEN_SELECTORS,
        kinds: [0, 1],
      },
    ],
    participantRegistry: {
      contract: vault.address,
      rootSlot: registry.root.toString(),
      epochSlot: registry.epoch.toString(),
      countSlot: registry.count.toString(),
      capacitySlot: registry.capacity.toString(),
    },
  }
}
