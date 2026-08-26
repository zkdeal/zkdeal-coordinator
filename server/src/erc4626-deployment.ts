import type { Account, Hex, PublicClient, WalletClient } from 'viem'
import {
  ERC4626_INVESTOR,
  ERC4626_LIQUIDITY_PROVIDER,
  ERC4626_WORKLOAD,
} from './erc4626-room.js'
import type {
  Erc4626RoomAccount,
  Erc4626RoomDeployment,
} from './erc4626-request.js'
import { presetOf } from './demo-runtime-spec.js'
import type { Artifact } from './demo-runtime-types.js'
import type { DemoErc4626Room, DemoTemplate } from './demo-types.js'

export interface Erc4626DeployContext {
  publicClient: PublicClient
  wallet: WalletClient
  account: Account
  artifact(name: string, alternatives?: string[]): Promise<Artifact>
}

async function deployed(
  context: Erc4626DeployContext,
  name: string,
  args: readonly unknown[],
): Promise<Erc4626RoomAccount> {
  const artifact = await context.artifact(name)
  const value = artifact.bytecode
  const bytecode = typeof value === 'string' ? value : value?.object
  if (!bytecode || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length <= 2) {
    throw new Error(`the ${name} artifact has no usable creation bytecode`)
  }
  const hash = await context.wallet.deployContract({
    account: context.account,
    abi: artifact.abi,
    bytecode: bytecode as Hex,
    args: args as never,
    chain: null,
  } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${name} did not deploy on local Ethereum`)
  }
  const runtimeCode = await context.publicClient.getCode({ address: receipt.contractAddress })
  if (!runtimeCode || runtimeCode === '0x') throw new Error(`${name} deployed with empty runtime code`)
  return { address: receipt.contractAddress, runtimeCode }
}

export async function prepareErc4626Room(
  template: DemoTemplate,
  context: Erc4626DeployContext,
  cache: Map<string, Erc4626RoomDeployment>,
): Promise<Erc4626RoomDeployment | null> {
  if (presetOf(template)?.workload !== ERC4626_WORKLOAD) return null
  const cached = cache.get(template.id)
  if (cached) return cached
  const assetToken = await deployed(context, 'RoomERC20', [
    'Vault Asset',
    'vAST',
    2_000n,
    context.account.address,
  ])
  const vault = await deployed(context, 'RoomVault4626', [
    assetToken.address,
    'Progressive Room Vault',
    'prSHARE',
  ])
  const deployment: Erc4626RoomDeployment = {
    vault,
    assetToken,
    investor: ERC4626_INVESTOR,
    liquidityProvider: ERC4626_LIQUIDITY_PROVIDER,
    participantCapacity: template.participantCapacity,
  }
  cache.set(template.id, deployment)
  return deployment
}

export function erc4626RoomDocument(
  deployment: Erc4626RoomDeployment,
): DemoErc4626Room {
  return {
    vaultAddress: deployment.vault.address,
    assetTokenAddress: deployment.assetToken.address,
    investorAddress: deployment.investor,
    liquidityProviderAddress: deployment.liquidityProvider,
    participantCapacity: deployment.participantCapacity,
    runtimeBindings: [
      { role: 'vault', address: deployment.vault.address },
      { role: 'assetToken', address: deployment.assetToken.address },
    ],
  }
}

export async function restoreErc4626Room(
  document: DemoErc4626Room,
  context: Pick<Erc4626DeployContext, 'publicClient'>,
): Promise<Erc4626RoomDeployment> {
  const account = async (role: string, address: string): Promise<Erc4626RoomAccount> => {
    const runtimeCode = await context.publicClient.getCode({ address: address as Hex })
    if (!runtimeCode || runtimeCode === '0x') {
      throw new Error(`the persisted ERC-4626 ${role} at ${address} has no runtime code on this chain`)
    }
    return { address: address as Hex, runtimeCode }
  }
  return {
    vault: await account('vault', document.vaultAddress),
    assetToken: await account('asset token', document.assetTokenAddress),
    investor: document.investorAddress as Hex,
    liquidityProvider: document.liquidityProviderAddress as Hex,
    participantCapacity: document.participantCapacity,
  }
}
