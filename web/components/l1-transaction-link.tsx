'use client'

/**
 * The one way a transaction hash becomes a link on this site.
 *
 * Every log that claims something reached Ethereum - the card duel's move log
 * and checkpoint ledger, the two application demos, the live room studio -
 * renders this. It exists so the rule is enforced in one place: either the full
 * 32-byte hash is available and the row is a real anchor a viewer can open in
 * the block explorer the COORDINATOR advertises, or there is no anchor at all
 * and the row says why.
 *
 * The link text is abbreviated for a dense row; the `href` and the `title`
 * carry the whole hash, so it survives copy, hover and read-aloud. A bare
 * abbreviation with no link is the thing this component refuses to produce.
 */
import { ArrowUpRight } from 'lucide-react'
import { l1ReceiptLink, type L1Receipt } from '@/lib/l1-receipt'

export function L1TransactionLink({
  receipt,
  label = 'transaction',
  full = false,
}: {
  receipt: L1Receipt
  /** The word before the hash, e.g. "settled in". */
  label?: string
  /** Show the whole hash inline, for a panel a presenter reads out loud. */
  full?: boolean
}) {
  const link = l1ReceiptLink(receipt)
  if (!link) {
    return (
      <span className="text-[0.68rem] text-warning" title={receipt.hash || undefined}>
        {receipt.note}
      </span>
    )
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      title={link.title}
      data-transaction={link.title}
      className="inline-flex min-w-0 items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[0.68rem] break-all text-success hover:bg-success/20"
    >
      <span className="text-success/70">{label}</span>
      {full ? link.title : link.text}
      <ArrowUpRight className="size-3 shrink-0" />
    </a>
  )
}
