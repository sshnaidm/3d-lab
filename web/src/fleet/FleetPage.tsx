import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { fleetHref, replaceRoute } from '../app/router'
import { searchFleet } from '../topology/load'
import type { SearchMatch } from '../topology/types'
import { AddServerDialog } from './AddServerDialog'
import { Filters } from './Filters'
import { HostTable } from './HostTable'
import {
  filterHosts,
  filtersFromQuery,
  groupHosts,
  queryFromFilters,
  useFleet,
  type FilterKey,
  type Filters as FilterMap,
} from './store'

function Stat({ value, label, tone, onClick }: { value: number; label: string; tone?: string; onClick?: () => void }) {
  if (!value && onClick) return null // clickable stats are filters; hide the empty ones
  const body = (
    <>
      <span className={`font-mono text-[15px] ${tone ?? 'text-white'}`}>{value}</span>
      <span className="text-[12px] text-ink-400">{label}</span>
    </>
  )
  return onClick ? (
    <button onClick={onClick} className="flex items-baseline gap-1.5 rounded px-1.5 py-0.5 hover:bg-ink-800">
      {body}
    </button>
  ) : (
    <span className="flex items-baseline gap-1.5 px-1.5 py-0.5">{body}</span>
  )
}

const SEARCH_DELAY_MS = 300

/** Ask the service for component-level matches (serials, MACs, part numbers, part names). */
function useServiceSearch(q: string, enabled: boolean) {
  const setSearchHits = useFleet((s) => s.setSearchHits)
  const notify = useFleet((s) => s.notify)
  useEffect(() => {
    const text = q.trim()
    if (!enabled || text.length < 2) {
      setSearchHits(null)
      return
    }
    const ctrl = new AbortController()
    setSearchHits(useFleet.getState().searchHits, true)
    const t = window.setTimeout(async () => {
      try {
        const results = await searchFleet(text, ctrl.signal)
        setSearchHits(new Map<string, SearchMatch[]>(results.map((r) => [r.id, r.matches])))
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setSearchHits(null)
          notify({ kind: 'error', text: `Search failed: ${e instanceof Error ? e.message : e}` })
        }
      }
    }, SEARCH_DELAY_MS)
    return () => {
      ctrl.abort()
      window.clearTimeout(t)
    }
  }, [q, enabled, setSearchHits, notify])
}

export function FleetPage({ query }: { query: URLSearchParams }) {
  const { hosts, loaded, error, mode, health, searchHits, searching, load, bulkRefresh, setFleetQuery } = useFleet()
  const queryString = query.toString()
  const { filters, q: urlQ } = useMemo(() => filtersFromQuery(new URLSearchParams(queryString)), [queryString])
  // The input is local so typing stays responsive; the URL follows it.
  const [q, setQ] = useState(urlQ)
  const [adding, setAdding] = useState(false)

  useEffect(() => void load(), [load])
  useEffect(() => setFleetQuery(queryString), [queryString, setFleetQuery])
  useEffect(() => {
    const t = window.setTimeout(() => replaceRoute(fleetHref(queryFromFilters(filters, q))), 250)
    return () => window.clearTimeout(t)
  }, [q, filters])
  useServiceSearch(q, mode === 'api')

  const setFilter = (key: FilterKey, value: string | null) => {
    const next: FilterMap = { ...filters, [key]: value ?? undefined }
    if (key === 'lab' && value !== filters.lab) delete next.rack // racks are per lab
    replaceRoute(fleetHref(queryFromFilters(next, q)))
  }

  const visible = useMemo(() => filterHosts(hosts, filters, q, searchHits), [hosts, filters, q, searchHits])
  // Facet counts follow the search text, so chips show what is left to narrow down.
  const searched = useMemo(() => filterHosts(hosts, {}, q, searchHits), [hosts, q, searchHits])
  const groups = useMemo(() => groupHosts(visible), [visible])
  const api = mode === 'api'
  const count = (pred: (h: (typeof visible)[number]) => boolean) => visible.filter(pred).length
  const genericModels = new Set(visible.filter((h) => h.layout === 'generic' && h.model).map((h) => h.model)).size
  const refreshable = visible.filter((h) => h.configured).map((h) => h.id)
  const needsRefresh = count((h) => h.configured && h.state !== 'ok')

  let body: ReactNode
  if (!loaded) body = <p className="animate-pulse font-mono text-sm text-signal">Loading fleet…</p>
  else if (error) body = <p className="font-mono text-sm text-red-300">Failed to load the fleet: {error}</p>
  else if (hosts.length === 0)
    body = (
      <p className="text-sm text-ink-300">
        No servers yet. Add servers to <code className="font-mono text-signal">redfish_servers.yaml</code>
        {health?.adhoc ? ' or use “Add server”.' : '.'}
      </p>
    )
  else if (visible.length === 0) body = <p className="text-sm text-ink-300">No hosts match.{searching && ' Searching parts…'}</p>
  else body = <HostTable groups={groups} searchHits={q.trim().length >= 2 ? searchHits : null} />

  return (
    <div className="scroll-thin fleet-bg h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-400">3d lab</div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Fleet</h1>
          </div>
          <div className="relative min-w-[260px] flex-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={api ? 'Search hosts and parts: ConnectX-6, serial, MAC, Critical…' : 'Filter hosts…'}
              className="w-full rounded-lg border border-ink-700 bg-ink-900/80 px-4 py-2 text-sm text-ink-100 placeholder:text-ink-400 outline-none focus:border-signal"
            />
            {searching && <span className="absolute top-2.5 right-3 animate-pulse font-mono text-[11px] text-signal">searching…</span>}
          </div>
          {api && (
            <div className="flex items-center gap-2">
              <button
                disabled={needsRefresh === 0}
                onClick={() => void bulkRefresh(refreshable, true)}
                title="Collect hosts in this view that are stale, failed or never collected"
                className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-100 hover:border-signal/60 hover:text-signal disabled:border-ink-800 disabled:text-ink-600"
              >
                ↻ Refresh stale{needsRefresh ? ` (${needsRefresh})` : ''}
              </button>
              <button
                disabled={refreshable.length === 0}
                onClick={() => {
                  if (refreshable.length <= 5 || confirm(`Collect all ${refreshable.length} hosts in this view from their BMCs?`))
                    void bulkRefresh(refreshable, false)
                }}
                title="Collect every host in this view"
                className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:border-signal/60 hover:text-signal disabled:border-ink-800 disabled:text-ink-600"
              >
                All shown
              </button>
              {health?.adhoc && (
                <button
                  onClick={() => setAdding(true)}
                  className="rounded-lg bg-signal/20 px-3 py-2 text-sm font-medium text-signal ring-1 ring-signal/50 hover:bg-signal/30"
                >
                  + Add server
                </button>
              )}
            </div>
          )}
        </header>

        {mode === 'static' && (
          <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-4 py-2 text-[12px] text-ink-300">
            Static snapshot: showing files from <code className="font-mono">topology/</code>. Refresh, history and part search
            need the fleet service (<code className="font-mono">3d-lab</code>).
          </div>
        )}

        {loaded && !error && hosts.length > 0 && (
          <>
            <div className="panel flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2">
              <Stat value={visible.length} label={visible.length === hosts.length ? 'hosts' : `of ${hosts.length} hosts`} />
              {api && (
                <>
                  <Stat value={count((h) => (h.warnings?.length ?? 0) > 0 || h.health === 'Warning' || h.health === 'Critical')} label="with warnings" tone="text-amber-300" onClick={() => setFilter('flag', 'warnings')} />
                  <Stat value={count((h) => (h.cabled_down ?? 0) > 0)} label="cabled, no link" tone="text-amber-300" onClick={() => setFilter('flag', 'cabled_down')} />
                  <Stat value={count((h) => h.state === 'error')} label="failed" tone="text-red-300" onClick={() => setFilter('state', 'error')} />
                  <Stat value={count((h) => h.state === 'stale')} label="stale" tone="text-amber-300" onClick={() => setFilter('state', 'stale')} />
                  <Stat value={count((h) => h.state === 'pending')} label="not collected" tone="text-ink-300" onClick={() => setFilter('state', 'pending')} />
                  <Stat value={genericModels} label={genericModels === 1 ? 'model without layout' : 'models without layout'} tone="text-ink-300" onClick={() => setFilter('flag', 'generic')} />
                </>
              )}
            </div>
            <Filters
              hosts={searched}
              filters={filters}
              onChange={setFilter}
              onClear={() => replaceRoute(fleetHref(queryFromFilters({}, q)))}
            />
          </>
        )}

        {body}
      </div>
      {adding && <AddServerDialog onClose={() => setAdding(false)} />}
    </div>
  )
}
