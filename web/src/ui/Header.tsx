import { useEffect, useMemo, useState } from 'react'
import { fleetHref, hostHref } from '../app/router'
import { RefreshButton } from '../fleet/HostTable'
import { filterHosts, filtersFromQuery, orderedIds, useFleet } from '../fleet/store'
import { loadDiff, loadHistory } from '../topology/load'
import type { HistoryEntry } from '../topology/types'
import { formatTs, timeAgo } from './format'
import { HealthPill } from './HealthPill'
import { useExplorer } from './store'

/** Previous/next host within the fleet page's current filter (also on ← / → keys). */
function useNeighbours(id: string | null) {
  const hosts = useFleet((s) => s.hosts)
  const fleetQuery = useFleet((s) => s.fleetQuery)
  const searchHits = useFleet((s) => s.searchHits)
  return useMemo(() => {
    const { filters, q } = filtersFromQuery(new URLSearchParams(fleetQuery))
    let ids = orderedIds(filterHosts(hosts, filters, q, searchHits))
    if (id && !ids.includes(id)) ids = orderedIds(hosts) // opened directly or filtered out: step through all
    const i = id ? ids.indexOf(id) : -1
    return {
      index: i,
      total: ids.length,
      prev: i > 0 ? ids[i - 1] : null,
      next: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null,
    }
  }, [hosts, fleetQuery, searchHits, id])
}

function HistoryPicker({ serverId, capturedAt }: { serverId: string; capturedAt: string | undefined }) {
  const diff = useExplorer((s) => s.diff)
  const setDiff = useExplorer((s) => s.setDiff)
  const notify = useFleet((s) => s.notify)
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    let live = true
    loadHistory(serverId)
      .then((h) => live && setEntries(h))
      .catch(() => live && setEntries([]))
    return () => {
      live = false
    }
  }, [serverId, capturedAt])

  // The newest snapshot is the current hardware; comparing needs an older one.
  const older = entries.filter((e) => e.captured_at !== capturedAt)
  if (older.length === 0)
    return (
      <span className="font-mono text-[10px] text-ink-600" title="A snapshot is kept each time the hardware or firmware changes">
        {entries.length ? 'no hardware changes recorded' : ''}
      </span>
    )

  return (
    <select
      className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-800 px-2 py-1 font-mono text-[11px] text-ink-100 outline-none focus:border-signal"
      value={diff?.ts ?? ''}
      onChange={async (e) => {
        const ts = e.target.value
        if (!ts) return setDiff(null)
        try {
          setDiff(ts, await loadDiff(serverId, ts))
        } catch (err) {
          notify({ kind: 'error', text: `Diff failed: ${err instanceof Error ? err.message : err}` })
        }
      }}
    >
      <option value="">Compare with history… ({older.length})</option>
      {older.map((e) => (
        <option key={e.ts} value={e.ts}>
          {formatTs(e.ts)} · {(e.reasons ?? []).join(', ') || 'snapshot'}
        </option>
      ))}
    </select>
  )
}

export function Header() {
  const topo = useExplorer((s) => s.topology)
  const serverId = useExplorer((s) => s.serverId)
  const layout = useExplorer((s) => s.scene?.layout)
  const host = useFleet((s) => s.hosts.find((h) => h.id === serverId))
  const api = useFleet((s) => s.mode === 'api')
  const fleetQuery = useFleet((s) => s.fleetQuery)
  const { index, total, prev, next } = useNeighbours(serverId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      if (e.key === 'ArrowLeft' && prev) location.hash = hostHref(prev)
      if (e.key === 'ArrowRight' && next) location.hash = hostHref(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next])

  const crumb = 'text-ink-400 hover:text-signal'
  const step = 'rounded px-1.5 text-ink-300 hover:bg-ink-800 hover:text-white disabled:text-ink-700 disabled:hover:bg-transparent'

  return (
    <header className="panel pointer-events-auto rounded-xl px-5 py-4">
      <div className="flex items-center justify-between gap-3 font-mono text-[11px]">
        <nav className="flex min-w-0 items-center gap-1.5 truncate">
          <a href={fleetHref(new URLSearchParams(fleetQuery))} className={crumb}>
            ← Fleet
          </a>
          {host?.lab && (
            <>
              <span className="text-ink-600">›</span>
              <a href={fleetHref({ lab: host.lab })} className={crumb}>
                {host.lab}
              </a>
            </>
          )}
          {host?.rack && (
            <>
              <span className="text-ink-600">›</span>
              <a href={fleetHref({ ...(host.lab ? { lab: host.lab } : {}), rack: host.rack })} className={crumb}>
                {host.rack}
              </a>
            </>
          )}
        </nav>
        {total > 1 && (
          <div className="flex shrink-0 items-center gap-1 text-ink-400">
            <button className={step} disabled={!prev} onClick={() => prev && (location.hash = hostHref(prev))} title={prev ? `${prev} (←)` : undefined}>
              ‹
            </button>
            <span>
              {index + 1}/{total}
            </span>
            <button className={step} disabled={!next} onClick={() => next && (location.hash = hostHref(next))} title={next ? `${next} (→)` : undefined}>
              ›
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-400">{topo?.system.vendor ?? host?.vendor ?? 'server'}</div>
        <div className="truncate font-mono text-[13px] text-white">{serverId}</div>
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{topo?.system.model ?? host?.model ?? '—'}</h1>
      {topo && (
        <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-300">
          <HealthPill health={topo.system.health} />
          {topo.system.serial && <span className="rounded border border-ink-700 px-2 py-0.5">SN {topo.system.serial}</span>}
          <span className="rounded border border-ink-700 px-2 py-0.5">PWR {topo.system.power_state ?? '?'}</span>
        </div>
      )}
      {topo && (
        <div className="mt-2 font-mono text-[10px] text-ink-400">
          BIOS {topo.system.bios ?? '?'} · BMC {topo.system.bmc ?? '?'} ·{' '}
          <span title={new Date(topo.captured_at).toLocaleString()} className={host?.state === 'stale' ? 'text-amber-300' : undefined}>
            captured {timeAgo(topo.captured_at)}
          </span>
          {layout?.id === 'generic' ? (
            <span className="text-amber-300/80" title="No layout for this model yet: counts and data are right, positions are schematic">
              {' '}
              · generic layout
            </span>
          ) : (
            layout?.approximate && <span className="text-amber-300/70"> · layout: {layout.name} (approx.)</span>
          )}
        </div>
      )}
      {host?.last_error && (
        <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 font-mono text-[10px] text-red-300" title={host.last_error.message}>
          Last refresh failed {timeAgo(host.last_error.at)}: {host.last_error.kind}
          {topo ? ' — showing the previous data' : ''}
          <div className="truncate text-red-300/70">{host.last_error.message}</div>
        </div>
      )}
      {api && serverId && (host || topo) && (
        <div className="mt-3 flex items-center gap-2">
          {host && <RefreshButton host={host} />}
          {topo && <HistoryPicker serverId={serverId} capturedAt={topo.captured_at} />}
        </div>
      )}
    </header>
  )
}
