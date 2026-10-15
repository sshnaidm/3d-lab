import { useMemo, useState } from 'react'
import { KIND_COLORS } from '../scene/colors'
import { healthLevel, KIND_LABELS, type Kind } from '../topology/types'
import { placementId, useExplorer } from './store'

interface Row {
  id: string
  kind: Kind
  label: string
  name: string
  present: boolean
  health: string | null
}

const ORDER: Kind[] = ['cpu', 'dimm', 'pcie', 'ocp', 'lom', 'drive', 'storage', 'psu', 'fan']
const DOT = { ok: 'bg-emerald-400', warning: 'bg-amber-400', critical: 'bg-red-500', unknown: 'bg-ink-600' }

export function ComponentTree() {
  const scene = useExplorer((s) => s.scene)
  const selectedId = useExplorer((s) => s.selectedId)
  const hoveredId = useExplorer((s) => s.hoveredId)
  const select = useExplorer((s) => s.select)
  const hover = useExplorer((s) => s.hover)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['fan']))

  const groups = useMemo(() => {
    if (!scene) return []
    const byLabel = (a: Row, b: Row) => a.label.localeCompare(b.label, undefined, { numeric: true })
    const rows: Row[] = scene.placements.map((p) => ({
      id: placementId(p),
      kind: p.anchor.kind,
      label: p.anchor.label,
      name: p.component?.present ? p.component.name : 'Empty',
      present: !!p.component?.present,
      health: p.component?.health ?? null,
    })).sort(byLabel)
    const unplaced: Row[] = scene.unplaced.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.slot_label ?? c.id,
      name: c.name,
      present: c.present,
      health: c.health,
    }))
    const q = query.trim().toLowerCase()
    const match = (r: Row) => !q || `${r.label} ${r.name} ${r.kind}`.toLowerCase().includes(q)
    const out: { key: string; title: string; color: string; rows: Row[]; filled: number; total: number }[] = ORDER.map((kind) => {
      const all = rows.filter((r) => r.kind === kind)
      return { key: kind, title: KIND_LABELS[kind], color: KIND_COLORS[kind], rows: all.filter(match), filled: all.filter((r) => r.present).length, total: all.length }
    }).filter((g) => g.total > 0)
    if (unplaced.length)
      out.push({ key: 'unplaced', title: 'Not placed', color: '#6b7a8a', rows: unplaced.filter(match), filled: unplaced.length, total: unplaced.length })
    return out
  }, [scene, query])

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <aside className="panel pointer-events-auto flex min-h-0 flex-1 flex-col rounded-xl">
      <div className="border-b border-ink-700 p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter components…"
          className="w-full rounded-md border border-ink-700 bg-ink-950/60 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-400 outline-none focus:border-signal"
        />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map((g) => (
          <section key={g.key} className="mb-1">
            <button
              onClick={() => toggle(g.key)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-800"
            >
              <span className="h-2 w-2 rounded-sm" style={{ background: g.color }} />
              <span className="flex-1 text-[13px] font-medium text-ink-100">{g.title}</span>
              <span className="font-mono text-[11px] text-ink-400">
                {g.filled}/{g.total}
              </span>
              <span className="font-mono text-[10px] text-ink-400">{collapsed.has(g.key) && !query ? '+' : '−'}</span>
            </button>
            {(!collapsed.has(g.key) || query) &&
              g.rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => select(r.id)}
                  onMouseEnter={() => hover(r.id)}
                  onMouseLeave={() => hover(null)}
                  className={`ml-4 flex w-[calc(100%-1rem)] items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                    selectedId === r.id ? 'bg-signal/15 text-white' : hoveredId === r.id ? 'bg-ink-800' : ''
                  } ${r.present ? 'text-ink-100' : 'text-ink-400'}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.present ? DOT[healthLevel(r.health)] : 'border border-ink-600'}`} />
                  <span className="w-20 shrink-0 truncate font-mono text-[11px] text-ink-300" title={r.label}>{r.label}</span>
                  <span className="truncate">{r.name}</span>
                </button>
              ))}
          </section>
        ))}
      </div>
    </aside>
  )
}
