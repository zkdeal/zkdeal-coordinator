'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Field, Input, Textarea } from '@/components/ui/primitives'
import { ManifestComposer, type ComposerValue } from '@/components/manifest-composer'
import { presetManifest } from '@/lib/manifest-presets'
import { useRooms } from '@/lib/rooms-store'
import { useWallet } from '@/lib/wallet'
import { blockRateLabel } from '@/lib/format'
import { SEQUENCER_BLOCK_TIME_MS } from '@/lib/types'
import type { RoomSettings } from '@/lib/types'

export function CreateRoomDialog() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { createRoom } = useRooms()
  const { address, connect } = useWallet()
  const router = useRouter()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // The composer always emits a full manifest (presets keep presetId set) so
  // the manifest digest is verified end-to-end for every room.
  const [composer, setComposer] = useState<ComposerValue>(() => ({
    manifest: presetManifest('erc4626'),
    scenarioKey: 'erc4626',
    error: null,
  }))
  const [memberTarget, setMemberTarget] = useState(2)
  const [depositEth, setDepositEth] = useState('0.1')
  const [deadlineHours, setDeadlineHours] = useState(2)
  const [challengeWindowBlocks, setChallengeWindowBlocks] = useState(2)

  const canSubmit =
    name.trim().length >= 3 && Boolean(address) && !busy && composer.manifest !== null

  async function submit() {
    if (!canSubmit || !address || !composer.manifest) return
    setBusy(true)
    setErr(null)
    try {
      const settings: RoomSettings = {
        // Fixed by the sequencer implementation, not chosen here.
        blockTimeMs: SEQUENCER_BLOCK_TIME_MS,
        memberTarget,
        depositEth,
        deadlineSec: Math.floor(Date.now() / 1000) + deadlineHours * 3600,
        challengeWindowBlocks,
        proofSystem: 'Groth16',
        daLayer: 'Calldata',
        // Determined by the L1 the coordinator is pointed at; never assumed.
        sequencerPolicy: 'fifo-join-order',
      }
      const id = await createRoom({
        name: name.trim(),
        description:
          description.trim() ||
          'Permissioned deal channel - unanimous client verification + SNARK settlement.',
        // Preset id maps to the legacy scenario byte (generic 0 / erc4626 1 /
        // dvp 2); a modified manifest becomes scenario byte 255 ('custom').
        scenario: composer.scenarioKey,
        deployment: composer.manifest,
        operator: address,
        settings,
        autoJoin: true,
      })
      setOpen(false)
      router.push(`/room?id=${encodeURIComponent(id)}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        New channel
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Open a deal channel"
        description="Creates a RoomManager room on L1, joins with your deposit, and opens the session."
        className="max-w-2xl"
      >
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="flex flex-col gap-4">
            <Field
              label="Channel name"
              hint="Local label only - stored in this browser tab, never sent to the coordinator or L1. Other members see the channel id."
              htmlFor="room-name"
            >
              <Input
                id="room-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Desk A - overnight netting"
              />
            </Field>

            <Field
              label="Description"
              hint="Local label only - not shared with other members."
              htmlFor="room-desc"
            >
              <Textarea
                id="room-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this channel settle? Who should join?"
              />
            </Field>

            <Field
              label="Contracts"
              hint="Selects the L2 genesis contract set. Presets deploy the built-in demo catalog (no audit report or bytecode-bound attestation exists for it); customize to add catalog picks or your own bytecode."
            >
              <ManifestComposer onChange={setComposer} />
            </Field>

            {/* Block time is NOT a room setting: the sequencer runs a fixed
                interval and nothing in the room record carries a chosen value.
                A slider here would have been purely decorative. */}
            <div className="rounded-lg border border-border bg-background/40 p-3 text-[0.7rem] leading-snug text-muted-foreground">
              {`Block time is fixed at ${SEQUENCER_BLOCK_TIME_MS}ms (${blockRateLabel(
                SEQUENCER_BLOCK_TIME_MS,
              )}) by the sequencer and is not configurable per channel. Deal execution targets ≤16 blocks (~8s).`}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Members (≤4)">
                <Input
                  type="number"
                  min={1}
                  max={4}
                  value={memberTarget}
                  onChange={(e) => setMemberTarget(Math.min(4, Math.max(1, Number(e.target.value))))}
                />
              </Field>
              <Field label="Deposit (ETH each)">
                <Input
                  type="text"
                  value={depositEth}
                  onChange={(e) => setDepositEth(e.target.value)}
                />
              </Field>
              <Field label="Deadline (hours)">
                <Input
                  type="number"
                  min={1}
                  value={deadlineHours}
                  onChange={(e) => setDeadlineHours(Math.max(1, Number(e.target.value)))}
                />
              </Field>
              <Field label="Challenge window (L1 blocks)">
                <Input
                  type="number"
                  min={1}
                  value={challengeWindowBlocks}
                  onChange={(e) => setChallengeWindowBlocks(Math.max(1, Number(e.target.value)))}
                />
              </Field>
            </div>

            <div className="rounded-lg border border-border bg-background/40 p-3 text-[0.7rem] leading-snug text-muted-foreground">
              Settlement certificate: Groth16. DA: L1 calldata at submitCheckpoint. Sequencer:{' '}
              <span className="text-foreground">FIFO at sequencer (join-order leader)</span> - no
              MEV-protection claim. After finalize, members <span className="text-foreground">claim</span>{' '}
              (pull).
            </div>

            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-4">
          {address ? (
            <span className="font-mono text-[0.7rem] text-muted-foreground">
              operator: {address.slice(0, 6)}…{address.slice(-4)}
            </span>
          ) : (
            <span className="text-[0.7rem] text-warning">Connect a wallet to create.</span>
          )}
          {address ? (
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create on L1'}
            </Button>
          ) : (
            <Button onClick={() => void connect()} variant="outline">
              <Wallet className="size-4" />
              Connect
            </Button>
          )}
        </div>
      </Modal>
    </>
  )
}
