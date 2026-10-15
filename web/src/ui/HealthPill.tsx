import { healthLevel } from '../topology/types'

const STYLES = {
  ok: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  warning: 'text-amber-300 border-amber-500/50 bg-amber-500/10',
  critical: 'text-red-300 border-red-500/50 bg-red-500/10',
  unknown: 'text-ink-300 border-ink-600 bg-ink-800',
}

export function HealthPill({ health, label }: { health: string | null | undefined; label?: string }) {
  const level = healthLevel(health)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${STYLES[level]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? health ?? 'n/a'}
    </span>
  )
}
