'use client'

/**
 * Small presentational pieces of the /demo console: service status dot, room
 * phase badge and the four-node correctness path.
 *
 * Split out of `components/long-running-demo.tsx` unchanged.
 */

import { Check, ChevronRight, CircleAlert, Cpu, Layers3, ShieldCheck, WalletCards } from 'lucide-react'
import Image from 'next/image'
import { phaseIndex, phaseLabel, type DemoPhase } from '@/lib/demo-console'
import type { Service } from '@/components/demo-console/api'
import styles from '../../app/demo/demo.module.css'

export function StatusDot({ status }: { status: Service['status'] }) {
  return <span className={`${styles.statusDot} ${styles[`status${status}`]}`} aria-label={status} />
}

export function PhaseBadge({ phase }: { phase: DemoPhase }) {
  return (
    <span className={`${styles.phaseBadge} ${styles[`phase${phase}`] ?? ''}`}>
      {phase === 'FAILED' ? <CircleAlert size={13} /> : phase === 'L1_FINALIZED' ? <Check size={13} /> : null}
      {phaseLabel(phase)}
    </span>
  )
}

export function Topology({ active }: { active: DemoPhase | null }) {
  const nodes = [
    { id: 'wallet', label: 'User intent', icon: WalletCards, at: 'ACTIVE' as DemoPhase },
    { id: 'room', label: 'Room blocks', icon: Layers3, at: 'PROVING' as DemoPhase },
    { id: 'prover', label: 'CUDA proof', icon: Cpu, at: 'LOCALLY_VERIFIED' as DemoPhase },
    { id: 'ethereum', label: 'Ethereum finality', icon: ShieldCheck, at: 'L1_FINALIZED' as DemoPhase },
  ]
  const activeIndex = active ? phaseIndex(active) : -1
  return (
    <div className={styles.topology}>
      {nodes.map((node, index) => {
        const reached = activeIndex >= phaseIndex(node.at)
        const Icon = node.icon
        return (
          <div className={styles.topologySegment} key={node.id}>
            <div className={`${styles.topologyNode} ${reached ? styles.topologyReached : ''}`}>
              {node.id === 'room' ? (
                <Image
                  className={styles.topologyBrand}
                  src="/zkdeal-icon.ico"
                  alt=""
                  width={20}
                  height={20}
                />
              ) : (
                <Icon size={19} />
              )}
              <span>{node.label}</span>
            </div>
            {index < nodes.length - 1 ? (
              <div className={`${styles.topologyLink} ${reached ? styles.topologyReached : ''}`}>
                <span />
                <ChevronRight size={15} />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
