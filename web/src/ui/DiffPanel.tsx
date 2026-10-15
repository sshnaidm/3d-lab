import { formatTs } from './format'
import { changeMark, placementId, useExplorer } from './store'

const TONE = { added: 'text-emerald-300', removed: 'text-red-300', changed: 'text-amber-300' }
const SIGN = { added: '+', removed: '−', changed: '~' }

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Hardware changes between a history snapshot and the current topology; parts are highlighted in 3D. */
export function DiffPanel() {
  const diff = useExplorer((s) => s.diff)
  const scene = useExplorer((s) => s.scene)
  const topo = useExplorer((s) => s.topology)
  const setDiff = useExplorer((s) => s.setDiff)
  const select = useExplorer((s) => s.select)
  if (!diff || !scene) return null
  const { data } = diff
  const slotTarget = (slot: string | null, id: string) => {
    const p = slot ? scene.placements.find((x) => x.anchor.slot_key === slot) : undefined
    return p ? placementId(p) : id
  }
  const labelOf = (slot: string | null) => (slot && scene.placements.find((x) => x.anchor.slot_key === slot)?.anchor.label) ?? slot ?? ''
  const rows = [
    ...data.added.map((c) => ({ mark: 'added' as const, id: c.id, target: c.id, title: c.name, slot: c.slot_key, fields: null })),
    ...data.removed.map((c) => ({ mark: 'removed' as const, id: c.id, target: slotTarget(c.slot_key, c.id), title: c.name, slot: c.slot_key, fields: null })),
    ...data.changed.map((c) => {
      const name = topo?.components.find((x) => x.id === c.id)?.name
      const mark = changeMark(c.fields)
      // For a part that went absent, the old name is the interesting one.
      const title = mark === 'removed' ? String(c.fields.name?.old ?? name ?? c.id) : (name ?? c.id)
      return { mark, id: c.id, target: c.id, title, slot: c.slot_key, fields: c.fields }
    }),
  ]
  const system = Object.entries(data.system)
  const empty = rows.length === 0 && system.length === 0

  return (
    <section className="panel pointer-events-auto flex max-h-[38%] shrink-0 flex-col rounded-xl">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-400">
          Since {formatTs(diff.ts)}
          <span className="ml-2 normal-case tracking-normal">
            <span className={TONE.added}>+{rows.filter((r) => r.mark === 'added').length}</span>{' '}
            <span className={TONE.removed}>−{rows.filter((r) => r.mark === 'removed').length}</span>{' '}
            <span className={TONE.changed}>~{rows.filter((r) => r.mark === 'changed').length}</span>
          </span>
        </div>
        <button onClick={() => setDiff(null)} className="rounded px-1.5 text-ink-400 hover:bg-ink-800 hover:text-white" aria-label="Close comparison">
          ✕
        </button>
      </div>
      <div className="scroll-thin min-h-0 overflow-y-auto px-2 py-2 text-[12px]">
        {empty && <p className="px-2 text-ink-400">No hardware or firmware differences.</p>}
        {system.map(([k, v]) => (
          <div key={k} className="px-2 py-1">
            <span className={TONE.changed}>~ system {k}</span>{' '}
            <span className="font-mono text-[11px] text-ink-400">
              {show(v.old)} → <span className="text-ink-100">{show(v.new)}</span>
            </span>
          </div>
        ))}
        {rows.map((r) => (
          <button key={`${r.mark}:${r.id}`} onClick={() => select(r.target)} className="block w-full rounded px-2 py-1 text-left hover:bg-ink-800">
            <span className={TONE[r.mark]}>
              {SIGN[r.mark]} {labelOf(r.slot)}
            </span>{' '}
            <span className="text-ink-100">{r.title}</span>
            {r.fields &&
              Object.entries(r.fields).map(([k, v]) => (
                <div key={k} className="truncate pl-4 font-mono text-[10px] text-ink-400" title={`${show(v.old)} → ${show(v.new)}`}>
                  {k}: {show(v.old)} → <span className="text-ink-100">{show(v.new)}</span>
                </div>
              ))}
          </button>
        ))}
      </div>
    </section>
  )
}
