import { cn } from '@/lib/utils'

/* ---------------------------------- Card --------------------------------- */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />
}

/* --------------------------------- Panel --------------------------------- */

export function Panel({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            {title && <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>}
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

/* --------------------------------- Tones --------------------------------- */

// Accepts both semantic aliases (ok/warn/info/danger) and raw names.
export type Tone =
  | 'default'
  | 'primary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted'
  | 'info'
  | 'ok'
  | 'warn'
  | 'danger'

function normalizeTone(tone: Tone): keyof typeof toneClasses {
  if (tone === 'ok') return 'success'
  if (tone === 'warn') return 'warning'
  if (tone === 'danger') return 'destructive'
  if (tone === 'info') return 'primary'
  return tone
}

const toneClasses = {
  default: 'border-border bg-secondary text-secondary-foreground',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  accent: 'border-accent/30 bg-accent/10 text-accent',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
} as const

const dotColor = {
  default: 'bg-muted-foreground',
  primary: 'bg-primary',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
} as const

const textColor = {
  default: 'text-foreground',
  primary: 'text-primary',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
} as const

/* --------------------------------- Badge --------------------------------- */

export function Badge({
  tone = 'default',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.7rem] leading-none font-medium',
        toneClasses[normalizeTone(tone)],
        className,
      )}
      {...props}
    />
  )
}

/* ------------------------------- StatusDot ------------------------------- */

export function StatusDot({ tone = 'success', pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = dotColor[normalizeTone(tone)]
  return (
    <span className="relative flex size-2">
      {pulse && (
        <span
          className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', color)}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}

/* --------------------------------- Field --------------------------------- */

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-[0.7rem] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* --------------------------------- Inputs -------------------------------- */

const inputCls =
  'h-8 w-full rounded-md border border-input bg-background/60 px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputCls, className)} {...props} />
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(inputCls, 'h-auto min-h-16 resize-none py-2 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputCls, 'appearance-none bg-background pr-8', className)} {...props} />
  )
}

/* ---------------------------------- Stats -------------------------------- */

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="font-mono text-base font-semibold text-foreground tabular-nums">{value}</span>
      {sub && <span className="text-[0.7rem] text-muted-foreground">{sub}</span>}
    </div>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: Tone
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background/40 p-3">
      <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">{label}</span>
      <span
        className={cn(
          'font-mono text-lg font-semibold tabular-nums',
          textColor[normalizeTone(tone)],
        )}
      >
        {value}
      </span>
      {hint && <span className="text-[0.7rem] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  )
}
