import {
  ERC4626_PARTICIPANT_REGISTRY_SLOTS,
  buildErc4626AssetStorage,
  buildErc4626VaultStorage,
  emptyParticipantRoot,
} from '@zkdeal/protocol'
import type { Hex } from 'viem'
import {
  ERC4626_INVESTOR,
  ERC4626_LIQUIDITY_PROVIDER,
  ERC4626_TOKEN_SELECTORS,
  erc4626AllowedSelectors,
} from './erc4626-room.js'

export interface Erc4626RoomAccount {
  address: Hex
  runtimeCode: Hex
}

export interface Erc4626RoomDeployment {
  vault: Erc4626RoomAccount
  assetToken: Erc4626RoomAccount
  investor: Hex
  liquidityProvider: Hex
  participantCapacity: number
}

function checkedAccount(role: string, account: Erc4626RoomAccount): Erc4626RoomAccount {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account.address) || BigInt(account.address) === 0n) {
    throw new Error(`the ERC-4626 ${role} needs a non-zero 20-byte address`)
  }
  if (!/^0x[0-9a-fA-F]+$/.test(account.runtimeCode) || account.runtimeCode.length <= 2) {
    throw new Error(`the ERC-4626 ${role} needs deployed runtime code`)
  }
  return { address: account.address.toLowerCase() as Hex, runtimeCode: account.runtimeCode }
}

export function buildErc4626RoomRequest(
  deployment: Erc4626RoomDeployment,
): Record<string, unknown> {
  const vault = checkedAccount('vault', deployment.vault)
  const assetToken = checkedAccount('asset token', deployment.assetToken)
  if (vault.address === assetToken.address) throw new Error('vault and asset token must be distinct')
  if (
    deployment.investor.toLowerCase() !== ERC4626_INVESTOR.toLowerCase()
    || deployment.liquidityProvider.toLowerCase() !== ERC4626_LIQUIDITY_PROVIDER.toLowerCase()
  ) {
    throw new Error('the ERC-4626 cold state must fund fixture signers zero and one')
  }
  const participantRoot = emptyParticipantRoot(deployment.participantCapacity)
  const vaultStorage = buildErc4626VaultStorage({
    assetToken: assetToken.address,
    investor: deployment.investor,
    participantRoot,
    participantCapacity: deployment.participantCapacity,
  })
  const tokenStorage = buildErc4626AssetStorage({
    vault: vault.address,
    investor: deployment.investor,
    liquidityProvider: deployment.liquidityProvider,
    balancePerOwner: 1_000n,
    investorAllowance: 100n,
    liquidityProviderAllowance: 50n,
  })
  const registry = ERC4626_PARTICIPANT_REGISTRY_SLOTS
  return {
    signerAccounts: 2,
    maxTransactionsPerBlock: 3,
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
        selectors: erc4626AllowedSelectors(),
        kinds: [0],
      },
      {
        caller: vault.address,
        target: assetToken.address,
        selectors: ERC4626_TOKEN_SELECTORS,
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
