'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { burnerAccount, forgetBurnerIdentity, hasStoredBurnerKey } from './keys'
import { requestFaucet, fetchConfig } from './coordinator'
import { disconnectSharedRoomClient, getSharedRoomClient } from './room-client'

interface EthereumProvider {
  isMetaMask?: boolean
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

interface WalletState {
  address: string | null
  chainId: string | null
  chainName: string
  connecting: boolean
  hasMetaMask: boolean
  isBurner: boolean
  faucetEnabled: boolean
  balanceHint: string | null
  /** True when a burner private key is persisted in this browser. */
  burnerStored: boolean
  connect: () => Promise<void>
  connectMetaMask: () => Promise<void>
  useBurner: () => Promise<void>
  /** Tears down the shared client (signer, node, attached room), not just UI state. */
  disconnect: () => Promise<void>
  /** Destructive: erases the persisted burner key from this browser. */
  forgetBurner: () => Promise<void>
  faucet: () => Promise<void>
}

const WalletContext = createContext<WalletState | null>(null)

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [chainId, setChainId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [hasMetaMask, setHasMetaMask] = useState(false)
  const [isBurner, setIsBurner] = useState(true)
  const [faucetEnabled, setFaucetEnabled] = useState(false)
  const [balanceHint, setBalanceHint] = useState<string | null>(null)
  const [burnerStored, setBurnerStored] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setHasMetaMask(Boolean(window.ethereum))
    // Auto-load burner for demo UX. burnerAccount() generates and persists a
    // key on first call, so the private key exists in localStorage from the
    // first page load onwards; the wallet menu says so and offers to erase it.
    try {
      const acct = burnerAccount()
      setAddress(acct.address)
      setIsBurner(true)
      setBurnerStored(hasStoredBurnerKey())
    } catch {
      /* ignore */
    }
    fetchConfig()
      .then((c) => {
        setFaucetEnabled(Boolean(c.faucetEnabled))
        setChainId('0x' + Number(c.chainId).toString(16))
      })
      .catch(() => {})
  }, [])

  const useBurner = useCallback(async () => {
    setConnecting(true)
    try {
      const client = getSharedRoomClient()
      await client.connect({ preferMetaMask: false })
      const st = client.getState()
      setAddress(st.l1Address)
      setIsBurner(true)
      setBurnerStored(hasStoredBurnerKey())
      if (st.config?.chainId) setChainId('0x' + Number(st.config.chainId).toString(16))
    } finally {
      setConnecting(false)
    }
  }, [])

  const connectMetaMask = useCallback(async () => {
    setConnecting(true)
    try {
      const eth = window.ethereum
      if (!eth) throw new Error('MetaMask not found')
      const client = getSharedRoomClient()
      await client.connect({ preferMetaMask: true })
      const st = client.getState()
      setAddress(st.l1Address)
      setIsBurner(false)
      const id = (await eth.request({ method: 'eth_chainId' })) as string
      setChainId(id)
    } finally {
      setConnecting(false)
    }
  }, [])

  const connect = useCallback(async () => {
    if (window.ethereum) return connectMetaMask()
    return useBurner()
  }, [connectMetaMask, useBurner])

  const disconnect = useCallback(async () => {
    // Revoke real authority, not just the label: stop the shared client's
    // node, detach its room and clear its connected flag. RoomsProvider drops
    // joinedRoomId when that flag goes false, which disables every
    // room-scoped control.
    await disconnectSharedRoomClient()
    setAddress(null)
    setBalanceHint(null)
  }, [])

  const forgetBurner = useCallback(async () => {
    await disconnectSharedRoomClient()
    forgetBurnerIdentity()
    setBurnerStored(false)
    setAddress(null)
    setBalanceHint(null)
  }, [])

  const faucet = useCallback(async () => {
    if (!address) return
    await requestFaucet(address)
    setBalanceHint('faucet requested')
  }, [address])

  const chainName = chainId
    ? `L1 ${parseInt(chainId, 16)}`
    : '-'

  return (
    <WalletContext.Provider
      value={{
        address,
        chainId,
        chainName,
        connecting,
        hasMetaMask,
        isBurner,
        faucetEnabled,
        balanceHint,
        burnerStored,
        connect,
        connectMetaMask,
        useBurner,
        disconnect,
        forgetBurner,
        faucet,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used within WalletProvider')
  return ctx
}
