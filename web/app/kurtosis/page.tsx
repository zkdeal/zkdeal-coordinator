import type { Metadata } from 'next'
import { KurtosisStoryPlayer } from '@/components/kurtosis-story-player'

/*
 * No protocol generation in the title: the page renders whatever bundle is
 * loaded, and an imported trace declares its own `run.protocolVersion`.
 * Hard-coding a generation in the chrome would present an imported run's
 * evidence as some other generation's. The player badges the version the
 * trace itself declares; the built-in reference declares 5.
 */
export const metadata: Metadata = {
  title: 'Kurtosis protocol stories · zkdeal',
  description:
    'Replayable node-level traces for zkdeal Kurtosis recovery and adversary stories; each run declares its own protocol version.',
}

export default function KurtosisStoriesPage() {
  return <KurtosisStoryPlayer />
}
