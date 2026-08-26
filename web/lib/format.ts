export function shortHex(hex: string, lead = 6, tail = 4): string {
  if (!hex) return ''
  if (hex.length <= lead + tail) return hex
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`
}

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function blockRateLabel(blockTimeMs: number): string {
  const perSec = 1000 / blockTimeMs
  return `${perSec.toFixed(perSec >= 10 ? 0 : 1)} blocks/s`
}
