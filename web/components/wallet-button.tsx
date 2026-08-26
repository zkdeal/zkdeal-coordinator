'use client'

import { useState } from 'react'
import { Droplets, LogOut, Trash2, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/primitives'
import { useWallet } from '@/lib/wallet'
import { shortAddr } from '@/lib/keys'

export function WalletButton() {
  const {
    address,
    connecting,
    connect,
    connectMetaMask,
    useBurner,
    disconnect,
    forgetBurner,
    burnerStored,
    faucet,
    faucetEnabled,
    chainName,
    isBurner,
    hasMetaMask,
  } = useWallet()
  const [open, setOpen] = useState(false)

  if (!address) {
    return (
      <Button size="sm" onClick={() => void connect()} disabled={connecting}>
        <Wallet className="size-3.5" />
        {connecting ? 'Connecting…' : 'Connect'}
      </Button>
    )
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="size-2 rounded-full bg-success" />
        <span className="font-mono">{shortAddr(address)}</span>
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-border bg-popover p-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Connected</span>
              <Badge tone={isBurner ? 'warning' : 'primary'}>
                {isBurner ? 'Burner' : 'MetaMask'}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-xs break-all text-foreground">{address}</p>
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Network</span>
              <span className="font-mono text-foreground">{chainName}</span>
            </div>
            {faucetEnabled && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                onClick={() => void faucet()}
              >
                <Droplets className="size-3.5" />
                Faucet
              </Button>
            )}
            <div className="mt-2 flex flex-col gap-1">
              {hasMetaMask && isBurner && (
                <Button variant="ghost" size="sm" onClick={() => void connectMetaMask()}>
                  Switch to MetaMask
                </Button>
              )}
              {!isBurner && (
                <Button variant="ghost" size="sm" onClick={() => void useBurner()}>
                  Switch to burner
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-destructive hover:text-destructive"
                onClick={() => {
                  void disconnect()
                  setOpen(false)
                }}
              >
                <LogOut className="size-3.5" />
                Disconnect
              </Button>
              {burnerStored && (
                <>
                  <p className="px-1 text-[0.65rem] leading-snug text-muted-foreground">
                    Disconnect stops the session client (signer, p2p node, attached channel). The
                    burner private key stays in this browser&apos;s localStorage until erased.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start text-destructive hover:text-destructive"
                    onClick={() => {
                      if (
                        confirm(
                          'Erase the burner private key from this browser? Any deposit or balance it controls becomes unreachable from this device. This cannot be undone.',
                        )
                      ) {
                        void forgetBurner()
                        setOpen(false)
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Forget burner key
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
