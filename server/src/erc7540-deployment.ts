import type { Account, Hex, PublicClient, WalletClient } from 'viem'
import {
  ERC7540_ALICE,
  ERC7540_BOB,
  ERC7540_MANAGER,
  ERC7540_WORKLOAD,
} from './erc7540-room.js'
import type {
  Erc7540RoomAccount,
  Erc7540RoomDeployment,
} from './erc7540-request.js'
import { presetOf } from './demo-runtime-spec.js'
import type { Artifact } from './demo-runtime-types.js'
import type { DemoErc7540Room, DemoTemplate } from './demo-types.js'

export interface Erc7540DeployContext {
  publicClient: PublicClient
  wallet: WalletClient
  account: Account
  artifact(name: string, alternatives?: string[]): Promise<Artifact>
}

async function deployed(
  context: Erc7540DeployContext,
  name: string,
  args: readonly unknown[],
): Promise<Erc7540RoomAccount> {
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

export async function prepareErc7540Room(
  template: DemoTemplate,
  context: Erc7540DeployContext,
  cache: Map<string, Erc7540RoomDeployment>,
): Promise<Erc7540RoomDeployment | null> {
  if (presetOf(template)?.workload !== ERC7540_WORKLOAD) return null
  const cached = cache.get(template.id)
  if (cached) return cached
  const assetToken = await deployed(context, 'RoomToken', ['Room Asset', 'rAST'])
  const vault = await deployed(context, 'RoomVault7540', [
    assetToken.address,
    ERC7540_MANAGER,
    'Async Room Share',
    'arSHARE',
  ])
  const deployment: Erc7540RoomDeployment = {
    vault,
    assetToken,
    alice: ERC7540_ALICE,
    bob: ERC7540_BOB,
    manager: ERC7540_MANAGER,
    participantCapacity: template.participantCapacity,
  }
  cache.set(template.id, deployment)
  return deployment
}

export function erc7540RoomDocument(
  deployment: Erc7540RoomDeployment,
): DemoErc7540Room {
  return {
    vaultAddress: deployment.vault.address,
    assetTokenAddress: deployment.assetToken.address,
    aliceAddress: deployment.alice,
    bobAddress: deployment.bob,
    managerAddress: deployment.manager,
    participantCapacity: deployment.participantCapacity,
    runtimeBindings: [
      { role: 'vault', address: deployment.vault.address },
      { role: 'assetToken', address: deployment.assetToken.address },
    ],
  }
}

export async function restoreErc7540Room(
  document: DemoErc7540Room,
  context: Pick<Erc7540DeployContext, 'publicClient'>,
): Promise<Erc7540RoomDeployment> {
  const account = async (role: string, address: string): Promise<Erc7540RoomAccount> => {
    const runtimeCode = await context.publicClient.getCode({ address: address as Hex })
    if (!runtimeCode || runtimeCode === '0x') {
      throw new Error(
        `the persisted ERC-7540 ${role} at ${address} has no runtime code on this chain`,
      )
    }
    return { address: address as Hex, runtimeCode }
  }
  return {
    vault: await account('vault', document.vaultAddress),
    assetToken: await account('asset token', document.assetTokenAddress),
    alice: document.aliceAddress as Hex,
    bob: document.bobAddress as Hex,
    manager: document.managerAddress as Hex,
    participantCapacity: document.participantCapacity,
  }
}
