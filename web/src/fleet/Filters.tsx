import { useState, type ReactNode } from 'react'
import type { FleetHost } from '../topology/types'
import { facetCounts, FLAGS, useFleet, type FilterKey, type Filters as FilterMap } from './store'

const FACETS: { key: FilterKey; label: string; limit?: number; label_of?: (v: string) => string }[] = [
  { key: 'state', label: 'State', label_of: (v) => STATE_LABELS[v] ?? v },
  { key: 'flag', label: 'Quick', label_of: (v) => FLAGS[v]?.label ?? v },
  { key: 'lab', label: 'Lab' },
  { key: 'rack', label: 'Rack', limit: 16 },
  { key: 'model', label: 'Model' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'health', label: 'Health' },
  { key: 'tag', label: 'Tag', limit: 14 },
]

export const STATE_LABELS: Record<string, string> = {
  ok: 'fresh',
  stale: 'stale',
  error: 'failed',
  pending: 'not collected',
}

const STATE_TONE: Record<string, string> = {
  ok: 'text-emerald-300',
  stale: 'text-amber-300',
  error: 'text-red-300',
  pending: 'text-ink-300',
}

function Chip({ on, onClick, children, tone }: { on: boolean; onClick: () => void; children: ReactNode; tone?: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
        on
          ? 'border-signal/60 bg-signal/15 text-white'
          : `border-ink-700 bg-ink-900/60 hover:border-ink-600 hover:text-white ${tone ?? 'text-ink-300'}`
      }`}
    >
      {children}
    </button>
  )
}

export function Filters({
  hosts,
  filters,
  onChange,
  onClear,
}: {
  hosts: FleetHost[]
  filters: FilterMap
  onChange: (key: FilterKey, value: string | null) => void
  onClear: () => void
}) {
  const [expanded, setExpanded] = useState<Set<FilterKey>>(new Set())
  const isStatic = useFleet((s) => s.mode === 'static') // snapshots have no collection state
  const active = Object.values(filters).some(Boolean)

  return (
    <div className="flex flex-col gap-1.5">
      {FACETS.filter((f) => !(isStatic && f.key === 'state')).map(({ key, label, limit, label_of }) => {
        const values = facetCounts(hosts, filters, key)
        const selected = filters[key]
        // Keep a selected value visible even when other filters leave it with zero hosts.
        if (selected && !values.some(([v]) => v === selected)) values.unshift([selected, 0])
        if (values.length === 0 || (values.length === 1 && !selected && key !== 'flag' && key !== 'state')) return null
        const shown = limit && !expanded.has(key) ? values.slice(0, limit) : values
        return (
          <div key={key} className="flex items-start gap-3">
            <div className="w-14 shrink-0 pt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">{label}</div>
            <div className="flex flex-wrap gap-1.5">
              {shown.map(([value, count]) => (
                <Chip
                  key={value}
                  on={selected === value}
                  tone={key === 'state' ? STATE_TONE[value] : undefined}
                  onClick={() => onChange(key, selected === value ? null : value)}
                >
                  {label_of ? label_of(value) : value}
                  <span className="font-mono text-[10px] text-ink-400">{count}</span>
                </Chip>
              ))}
              {limit && values.length > limit && (
                <button
                  className="px-1 text-[12px] text-ink-400 hover:text-signal"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                >
                  {expanded.has(key) ? 'less' : `+${values.length - limit} more`}
                </button>
              )}
            </div>
          </div>
        )
      })}
      {active && (
        <div className="pl-[68px]">
          <button className="text-[12px] text-ink-400 hover:text-signal" onClick={onClear}>
            Clear filters
          </button>
        </div>
      )}
    </div>
  )
}
