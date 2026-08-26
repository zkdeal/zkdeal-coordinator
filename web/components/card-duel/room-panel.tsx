'use client'

/**
 * Where a rehearsed move actually goes.
 *
 * A card move is an ordinary room action whose calldata the browser supplies
 * - the card preset ships no canned actions, because no duel move can be canned.
 * When there is no room, the coordinator's own explanation is shown verbatim
 * rather than paraphrased: "no room" covers a missing preset, an unprepared
 * template, a template that failed its cold proof and a room that has already
 * settled, and those are four different operator actions.
 *
 * The one button that changes the world is "Open a room": it creates a room
 * from the prepared cold template and deploys it on L1. It is deliberately a
 * click and not an automatic consequence of loading this page.
 *
 * It is also where the identity claim is made honestly. Every move leaves this
 * tab as a real EIP-1559 transaction signed by a WELL-KNOWN PUBLIC test key, so
 * that is stated here in full rather than implied to be the viewer's wallet.
 */
import { KeyRound, Plus, RefreshCcw, Server, ShieldCheck } from 'lucide-react'
import { L1TransactionLink } from '@/components/l1-transaction-link'
import { Badge, Field, Input, Select } from '@/components/ui/primitives'
import type { CardDemoIdentity } from '@/lib/card/identity'
import type { CardSettlementControls } from './use-card-settlement'

/**
 * Proving-deadline choices for a NEW room, in seconds of wall clock.
 *
 * The duel defaults to 120 s: a batch is roughly fifty seconds of proving plus
 * inclusion on an idle prover, and the prover is shared - a room queued ahead of
 * this one pushes the start out by its whole duration. Two minutes is the
 * margin that keeps a duel from racing its own deadline; the shorter and longer
 * options are here because a presenter demonstrating the deadline itself needs
 * to be able to choose one.
 */
const DEADLINE_CHOICES_SECONDS = [60, 120, 240, 480] as const

export function RoomPanel({
  settlement,
  duelAddress,
  onDuelAddress,
  identity,
}: {
  settlement: CardSettlementControls
  duelAddress: string
  onDuelAddress: (value: string) => void
  identity: CardDemoIdentity
}) {
  const { room, reason, rooms, deployment, template, activity, stage, coordinator } = settlement
  const working = activity === 'looking' || activity === 'opening'
  // Rooms that are not the one moves go to. Named explicitly, because a settled
  // room keeps its history and stops accepting moves, and "which of these am I
  // playing in" is the question a presenter with three of them actually has.
  const others = rooms.filter((entry) => entry.roomId !== room?.roomId)

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-primary">
          <Server className="size-5" />
          <span className="font-mono text-xs tracking-[0.18em] uppercase">Room transport</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            The room setting the coordinator exposes, where the person opening
            a room can see and choose it. It is disabled once a room exists,
            because it only applies to the NEXT one.
          */}
          <label className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            proving deadline
            <Select
              className="h-8 w-24"
              value={settlement.deadlineSeconds}
              disabled={working}
              onChange={(event) => settlement.setDeadlineSeconds(Number(event.target.value))}
            >
              {DEADLINE_CHOICES_SECONDS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} s
                </option>
              ))}
            </Select>
            <span className="font-mono text-[0.65rem]">
              = {settlement.deadlineBlocks} L1 blocks
            </span>
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
            disabled={working}
            onClick={() => void settlement.attach()}
          >
            <RefreshCcw className="size-3.5" /> Look for a card room
          </button>
          {room === null && template !== null ? (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={working}
              onClick={() => void settlement.openRoom()}
            >
              <Plus className="size-3.5" />
              {activity === 'opening' ? `Deploying${stage ? ` · ${stage}` : ''}…` : 'Open a room'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        {room ? (
          <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="success">current · {room.phase}</Badge>
              <span className="font-medium">{room.roomName}</span>
              <span className="font-mono text-[0.7rem] text-muted-foreground">
                {room.chainRoomId ? `chain room #${room.chainRoomId}` : 'not yet deployed'} ·{' '}
                {room.actionCount} action{room.actionCount === 1 ? '' : 's'} held · next L2 block{' '}
                {room.nextBlock}
              </span>
            </div>
            {deployment ? (
              <div className="mt-1.5">
                <L1TransactionLink receipt={deployment} label="room deployed in" />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
            {reason ??
              'No card room has been looked for yet. Moves below are built and audited locally until one exists.'}
          </p>
        )}
      </div>

      {/*
        Every other card room on this coordinator, so it is unambiguous which
        one the moves below are going to. A room that has settled is not gone -
        it keeps its whole history and simply stops accepting moves.
      */}
      {others.length > 0 ? (
        <div className="mt-2 rounded-lg border border-border bg-background/40 px-3 py-2">
          <span className="font-mono text-[0.62rem] tracking-[0.16em] text-muted-foreground uppercase">
            other rooms from this template
          </span>
          <ul className="mt-1 flex flex-col gap-1">
            {others.map((entry) => (
              <li key={entry.roomId} className="flex flex-wrap items-center gap-2 text-[0.7rem]">
                <Badge tone={entry.accepting ? 'accent' : 'muted'}>
                  {entry.accepting ? 'accepting' : 'closed to moves'}
                </Badge>
                <span className="text-muted-foreground">{entry.roomName}</span>
                <span className="font-mono text-[0.62rem] text-muted-foreground">
                  {entry.phase}
                  {entry.chainRoomId ? ` · chain room #${entry.chainRoomId}` : ''} ·{' '}
                  {entry.actionCount} action{entry.actionCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {template !== null ? (
        <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground">
          cold template &ldquo;{template.name}&rdquo;
          {coordinator?.deadlineBlocks
            ? ` · coordinator recommends ${coordinator.deadlineBlocks} L1 blocks of inclusion allowance per batch`
            : ''}
        </p>
      ) : null}

      {/*
        Where a presenter reads it off the screen. A duel move is a real signed
        EIP-1559 transaction, and the key that signs it is a public demo key -
        both facts belong next to the transport that carries them, not in a
        footnote.
      */}
      <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[0.7rem] leading-relaxed text-warning">
        <KeyRound className="mt-0.5 size-3.5 shrink-0" />
        <span>{identity.notice}</span>
      </p>

      <p className="mt-2 font-mono text-[0.68rem] leading-relaxed text-muted-foreground">
        {settlement.chainId !== null
          ? `every move is signed as an EIP-1559 transaction for room chain ${settlement.chainId} · room_chain_id_v5(deploymentDomain, roomId)`
          : (settlement.signingReason ??
            'a room chain id appears here once a deployed room is attached; every move is signed under it')}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field
          label="Duel contract address"
          hint={
            settlement.template?.duelAddress
              ? 'Published by the coordinator as the duel its cold template was prepared against, and adopted on attach. The proof domain below is derived from it.'
              : 'This coordinator publishes no duel address, so this is the console default and may be the wrong contract. The proof domain below is derived from it, so a wrong address is also a wrong public input 0.'
          }
        >
          <Input
            value={duelAddress}
            spellCheck={false}
            onChange={(event) => onDuelAddress(event.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Proof domain (public input 0)</span>
          <code className="block truncate rounded-md border border-border bg-background/60 px-2.5 py-1.5 font-mono text-[0.68rem]">
            {identity.proofDomainField}
          </code>
          <p className="text-[0.7rem] leading-snug text-muted-foreground">
            keccak256(abi.encode(roomApplicationDomain, duel)) reduced into the BN254 scalar field.
          </p>
        </div>
      </div>
    </section>
  )
}
