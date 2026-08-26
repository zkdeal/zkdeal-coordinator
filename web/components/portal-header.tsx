'use client'

import Link from 'next/link'
import Image from 'next/image'
import { Radio } from 'lucide-react'
import { WalletButton } from '@/components/wallet-button'
import { StatusDot } from '@/components/ui/primitives'
import { useRooms } from '@/lib/rooms-store'

export function PortalHeader() {
  const { onlineCount } = useRooms()

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-2.5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center overflow-hidden rounded-md border border-primary/30 bg-white">
              <Image src="/zkdeal-icon.ico" alt="" width={28} height={28} priority />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-sm font-semibold tracking-tight">zkdeal</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">
                execution rooms · Ethereum settlement
              </span>
            </span>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/room-pool"
            className="hidden rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground sm:block"
          >
            Create room
          </Link>
          <Link
            href="/applications"
            className="hidden rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground sm:block"
          >
            Auction + shop
          </Link>
          <Link
            href="/card-duel"
            className="hidden rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground sm:block"
          >
            Hidden-card duel
          </Link>
          <Link
            href="/demo-studio"
            className="hidden rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground sm:block"
          >
            Demo studio
          </Link>
          <span className="hidden items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-muted-foreground sm:flex">
            <Radio className="size-3 text-primary" />
            <StatusDot tone="success" pulse />
            {onlineCount} online
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
