import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CardDuelConsole } from '@/components/card-duel/card-duel-console'

export const metadata: Metadata = {
  title: 'Hidden-card duel · zkdeal',
  description:
    'A two-seat card duel whose decks, salts and hands never leave the browser: inner Groth16 proofs are generated locally and only roots, ordered public inputs and proof bytes are published.',
}

export default function CardDuelPage() {
  return (
    <Suspense>
      <CardDuelConsole />
    </Suspense>
  )
}
