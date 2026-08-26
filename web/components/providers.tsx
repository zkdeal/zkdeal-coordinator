'use client'

import { RoomsProvider } from '@/lib/rooms-store'
import { WalletProvider } from '@/lib/wallet'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <RoomsProvider>{children}</RoomsProvider>
    </WalletProvider>
  )
}
