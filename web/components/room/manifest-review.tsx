'use client'

/**
 * ManifestReview - joiner-facing review of the room deployment manifest.
 *
 * Rooms whose manifest contains custom (unreviewed) bytecode render this
 * expanded with an explicit acknowledge checkbox; Approve-genesis in the
 * settle panel stays disabled until the member checks it. Pure-preset rooms
 * keep today's flow: the panel is available but collapsed, no checkbox gate.
 *
 * The digest shown is the LOCAL recomputation (RoomClient state) - the
 * coordinator copy is never trusted.
 */

import { ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  bytesToHex0x,
  hexToBytes,
  keccak256,
  type ManifestDeployment,
} from '@zkdeal/protocol'
import { Badge, Panel } from '@/components/ui/primitives'
import { useManifestAck } from '@/lib/manifest-ack'
import { describeArg } from '@/lib/manifest-presets'
import { useRooms } from '@/lib/rooms-store'

function bytecodeHash(creationBytecode: string): string {
  try {
    return bytesToHex0x(keccak256(hexToBytes(creationBytecode)))
  } catch {
    return '0x?'
  }
}

function shortHash(h: string): string {
  return h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h
}

function DeploymentRow({
  d,
  index,
  hints,
}: {
  d: ManifestDeployment
  index: number
  hints: Array<{ kind: string; contractName: string }>
}) {
  const myHints = hints.filter((h) => h.contractName === d.name)
  const isCustom = d.source === 'custom'
  return (
    <div className="rounded-md border border-border bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[0.65rem] text-muted-foreground">#{index}</span>
        <span className="font-mono text-xs font-semibold text-foreground">{d.name}</span>
        {isCustom ? (
          <Badge tone="warning">
            <ShieldAlert className="size-3" />
            unreviewed custom bytecode
          </Badge>
        ) : (
          <Badge tone="success">
            <ShieldCheck className="size-3" />
            built-in demo catalog · {d.catalogId}
          </Badge>
        )}
      </div>
      {isCustom && (
        <p
          className="mt-1 font-mono text-[0.65rem] text-muted-foreground"
          title={bytecodeHash(d.creationBytecode)}
        >
          keccak256(creation) {shortHash(bytecodeHash(d.creationBytecode))} ·{' '}
          {(d.creationBytecode.length - 2) / 2} bytes
        </p>
      )}
      {d.args.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {d.args.map((a, i) => (
            <div key={i} className="flex gap-2 font-mono text-[0.65rem]">
              <span className="text-muted-foreground">{a.kind}</span>
              <span className="break-all text-foreground">{describeArg(a)}</span>
            </div>
          ))}
        </div>
      )}
      {myHints.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {myHints.map((h, i) => (
            <Badge key={i} tone="info">
              exit hint: {h.kind}
            </Badge>
          ))}
        </div>
      )}
      {isCustom && myHints.length === 0 && (
        <p className="mt-1.5 text-[0.65rem] leading-snug text-warning">
          No attribution hint - value left in this contract falls to the dust policy
          (assigned to the last member in join order).
        </p>
      )}
    </div>
  )
}

export function ManifestReview({ roomId }: { roomId: string }) {
  const { clientState, joinedRoomId } = useRooms()
  const { acknowledged, acknowledge } = useManifestAck(roomId)

  const live = joinedRoomId === roomId && clientState.roomId === roomId
  const manifest = live ? clientState.roomManifest : undefined
  if (!manifest) return null

  const digest = clientState.manifestDigest
  const reviewRequired = !!clientState.manifestReviewRequired
  const hints = manifest.exitAttributionHints
  const zkvm = manifest.zkvm

  const body = (
    <div className="flex flex-col gap-2" data-testid="manifest-review">
      {manifest.deployments.map((d, i) => (
        <DeploymentRow key={d.name} d={d} index={i} hints={hints} />
      ))}
      <div className="rounded-md border border-border bg-background/40 p-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[0.65rem]">
          <span className="text-muted-foreground">zkVM</span>
          <Badge tone={zkvm.backend === 'none' ? 'muted' : 'primary'}>{zkvm.backend}</Badge>
          <span className="text-muted-foreground">
            settle {zkvm.settle} · max lag {zkvm.proving.maxLagBlocks} blocks
          </span>
        </div>
        {zkvm.programDigest && (
          <p className="mt-1 font-mono text-[0.65rem] break-all text-muted-foreground">
            programDigest {zkvm.programDigest}
          </p>
        )}
      </div>
      {digest && (
        <p className="font-mono text-[0.65rem] break-all text-muted-foreground">
          manifestDigest <span className="text-foreground">{digest}</span>
        </p>
      )}
      {reviewRequired && (
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[0.7rem] leading-snug text-warning">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={acknowledged}
            disabled={acknowledged}
            onChange={(e) => {
              if (e.target.checked) acknowledge()
            }}
            data-testid="manifest-ack-checkbox"
          />
          <span>
            I reviewed the custom bytecode, constructor args and exit hints above.
            The manifest digest is bound into the genesis root I am about to approve.
          </span>
        </label>
      )}
    </div>
  )

  if (!reviewRequired) {
    return (
      <Panel
        title="Contract manifest"
        subtitle={
          manifest.presetId
            ? `Preset '${manifest.presetId}' - built-in demo catalog contracts only (no audit report or bytecode attestation).`
            : 'Catalog contracts only.'
        }
      >
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show deployments &amp; digest
          </summary>
          <div className="mt-2">{body}</div>
        </details>
      </Panel>
    )
  }

  return (
    <Panel
      title="Contract manifest review"
      subtitle="This room deploys custom bytecode. Review and acknowledge before approving genesis."
    >
      {body}
    </Panel>
  )
}
