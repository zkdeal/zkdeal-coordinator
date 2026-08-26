import type { Account, Hex, PublicClient, WalletClient } from 'viem'
import { AMM_WORKLOAD } from './amm-room.js'
import { presetOf } from './demo-runtime-spec.js'
import type { Artifact } from './demo-runtime-types.js'
import type { DemoTemplate } from './demo-types.js'

export interface AmmRoomDeployment {
  address: Hex
  runtimeCode: Hex
}

export interface AmmDeployContext {
  publicClient: PublicClient
  wallet: WalletClient
  account: Account
  artifact(name: string, alternatives?: string[]): Promise<Artifact>
}

/** Deploy the real compiled runtime whose code hash the cold proof will pin. */
export async function prepareAmmRoom(
  template: DemoTemplate,
  context: AmmDeployContext,
): Promise<AmmRoomDeployment | null> {
  if (presetOf(template)?.workload !== AMM_WORKLOAD) return null
  const artifact = await context.artifact('CommitRevealAMM')
  const value = artifact.bytecode
  const bytecode = typeof value === 'string' ? value : value?.object
  if (!bytecode || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length <= 2) {
    throw new Error('the CommitRevealAMM artifact has no usable creation bytecode')
  }
  const hash = await context.wallet.deployContract({
    account: context.account,
    abi: artifact.abi,
    bytecode: bytecode as Hex,
    args: [],
    chain: null,
  } as never)
  const receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error('CommitRevealAMM did not deploy on local Ethereum')
  }
  const runtimeCode = await context.publicClient.getCode({ address: receipt.contractAddress })
  if (!runtimeCode || runtimeCode === '0x') {
    throw new Error('CommitRevealAMM deployed with empty runtime code')
  }
  return { address: receipt.contractAddress, runtimeCode }
}
