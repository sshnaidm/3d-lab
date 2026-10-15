import { create } from 'zustand'
import {
  ApiError,
  addServer as apiAddServer,
  bulkRefresh as apiBulkRefresh,
  detectMode,
  getJob,
  loadFleet,
  refreshServer as apiRefreshServer,
  serviceHealth,
  type AddServerInput,
  type DataMode,
} from '../topology/load'
import type { FleetHost, Job, SearchMatch, ServiceHealth } from '../topology/types'
import { useExplorer } from '../ui/store'

/** Filter keys kept in the fleet URL (#/?lab=…). `flag` holds the quick toggles. */
export const FILTER_KEYS = ['lab', 'rack', 'model', 'vendor', 'tag', 'health', 'state', 'layout', 'flag'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type Filters = Partial<Record<FilterKey, string>>

export const FLAGS: Record<string, { label: string; test: (h: FleetHost) => boolean }> = {
  warnings: { label: 'has warnings', test: (h) => (h.warnings?.length ?? 0) > 0 || isUnhealthy(h.health) },
  nolink: { label: 'no link up', test: (h) => (h.ports_total ?? 0) > 0 && (h.ports_up ?? 0) === 0 },
  generic: { label: 'generic layout', test: (h) => h.layout === 'generic' },
  adhoc: { label: 'added by IP', test: (h) => h.source === 'adhoc' },
  cabled_down: { label: 'cabled, no link', test: (h) => (h.cabled_down ?? 0) > 0 },
  unknown_peer: { label: 'link to unknown switch', test: (h) => (h.unknown_peer ?? 0) > 0 },
}

const isUnhealthy = (health: string | null | undefined) => health === 'Warning' || health === 'Critical'

export interface Notice {
  kind: 'info' | 'error'
  text: string
}

interface FleetState {
  mode: DataMode | null
  health: ServiceHealth | null
  hosts: FleetHost[]
  loaded: boolean
  error: string | null

  /** Component search results from /api/search, keyed by host; null when no search is active. */
  searchHits: Map<string, SearchMatch[]> | null
  searching: boolean

  /** Jobs started from this browser, polled until done. */
  jobs: Record<string, Job>
  /** Latest job per host started from this browser. */
  hostJobs: Record<string, string>

  /** The fleet page's query (filters + search), kept so the host view can go back and step through it. */
  fleetQuery: string

  notice: Notice | null
  /** Set when a write needs an API token; the dialog calls `retry` after saving one. */
  tokenPrompt: { retry: () => void } | null
  askToken: (retry: () => void) => void

  load: () => Promise<void>
  setSearchHits: (hits: Map<string, SearchMatch[]> | null, searching?: boolean) => void
  setFleetQuery: (query: string) => void
  refresh: (id: string, force?: boolean) => Promise<void>
  bulkRefresh: (ids: string[], staleOnly: boolean) => Promise<void>
  /** Throws ApiError; the dialog shows it (and asks for a token on 401). */
  addServer: (input: AddServerInput) => Promise<Job>
  notify: (notice: Notice | null) => void
  closeTokenPrompt: () => void
}

const POLL_MS = 1500
const BUSY_POLL_MS = 5000
let busyTimer: number | undefined

export const useFleet = create<FleetState>((set, get) => {
  /** Run a write; on 401 ask for a token and retry, on other errors show a notice. */
  async function write<T>(fn: () => Promise<T>, retry: () => void): Promise<T | null> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ tokenPrompt: { retry } })
      else set({ notice: { kind: 'error', text: e instanceof Error ? e.message : String(e) } })
      return null
    }
  }

  function track(job: Job) {
    set((s) => {
      const hostJobs = { ...s.hostJobs }
      for (const h of Object.keys(job.hosts ?? {})) hostJobs[h] = job.id
      return { jobs: { ...s.jobs, [job.id]: job }, hostJobs }
    })
    const poll = async () => {
      let current: Job
      try {
        current = await getJob(job.id)
      } catch {
        return // job list is in memory on the service; a restart forgets it
      }
      set((s) => ({ jobs: { ...s.jobs, [job.id]: current } }))
      if (current.state !== 'done') {
        window.setTimeout(poll, POLL_MS)
        return
      }
      await get().load()
      const hosts = Object.keys(current.hosts ?? {})
      void useExplorer.getState().reloadIfOpen(hosts)
      if (current.kind === 'bulk' || current.total > 1)
        set({ notice: { kind: 'info', text: `Refresh finished: ${current.succeeded} ok, ${current.failed} failed` } })
      else if (current.failed && current.kind !== 'add') {
        // the Add dialog shows its own result
        const r = current.hosts?.[hosts[0]]
        set({ notice: { kind: 'error', text: `${hosts[0]}: ${r?.kind ?? 'error'} — ${r?.message ?? 'refresh failed'}` } })
      }
    }
    window.setTimeout(poll, POLL_MS)
  }

  return {
    mode: null,
    health: null,
    hosts: [],
    loaded: false,
    error: null,
    searchHits: null,
    searching: false,
    jobs: {},
    hostJobs: {},
    fleetQuery: '',
    notice: null,
    tokenPrompt: null,

    load: async () => {
      try {
        const mode = await detectMode()
        const hosts = await loadFleet()
        set({ mode, health: serviceHealth(), hosts, loaded: true, error: null })
        // Pick up refreshes started elsewhere (another browser, the CLI, chat) while hosts are busy.
        window.clearTimeout(busyTimer)
        if (hosts.some((h) => h.busy)) busyTimer = window.setTimeout(() => void get().load(), BUSY_POLL_MS)
      } catch (e) {
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) })
      }
    },

    setSearchHits: (searchHits, searching = false) => set({ searchHits, searching }),
    setFleetQuery: (fleetQuery) => set({ fleetQuery }),

    refresh: async (id, force = false) => {
      const job = await write(() => apiRefreshServer(id, force), () => void get().refresh(id, force))
      if (!job) return
      set((s) => ({ hosts: s.hosts.map((h) => (h.id === id ? { ...h, busy: true } : h)) }))
      track(job)
    },

    bulkRefresh: async (ids, staleOnly) => {
      const job = await write(() => apiBulkRefresh(ids, staleOnly), () => void get().bulkRefresh(ids, staleOnly))
      if (!job) return
      set({ notice: { kind: 'info', text: `Refreshing ${job.total} host(s)…` } })
      await get().load()
      // Bulk responses omit per-host details; fetch them so rows can show progress.
      track(await getJob(job.id).catch(() => job))
    },

    addServer: async (input) => {
      const { server, job } = await apiAddServer(input)
      set((s) => ({
        hosts: s.hosts.some((h) => h.id === server.id)
          ? s.hosts
          : [...s.hosts, { ...server, state: 'pending', configured: true, busy: true }],
      }))
      track(job)
      return job
    },

    notify: (notice) => set({ notice }),
    askToken: (retry) => set({ tokenPrompt: { retry } }),
    closeTokenPrompt: () => set({ tokenPrompt: null }),
  }
})

/** The job (started from this browser) currently running for a host, if any. */
export function activeJobFor(s: FleetState, id: string): Job | null {
  const job = s.hostJobs[id] ? s.jobs[s.hostJobs[id]] : undefined
  return job && job.state !== 'done' ? job : null
}

// ---------------------------------------------------------------------------
// Filtering and grouping (client side: the whole index is small)
// ---------------------------------------------------------------------------

export function filtersFromQuery(query: URLSearchParams): { filters: Filters; q: string } {
  const filters: Filters = {}
  for (const k of FILTER_KEYS) {
    const v = query.get(k)
    if (v) filters[k] = v
  }
  return { filters, q: query.get('q') ?? '' }
}

export function queryFromFilters(filters: Filters, q: string): URLSearchParams {
  const out = new URLSearchParams()
  for (const k of FILTER_KEYS) if (filters[k]) out.set(k, filters[k]!)
  if (q.trim()) out.set('q', q.trim())
  return out
}

export function filterValue(h: FleetHost, key: FilterKey): string | null {
  if (key === 'tag' || key === 'flag') return null
  const v = h[key as keyof FleetHost]
  return typeof v === 'string' ? v : null
}

function matchesFilters(h: FleetHost, filters: Filters, skip?: FilterKey): boolean {
  for (const k of FILTER_KEYS) {
    const wanted = filters[k]
    if (!wanted || k === skip) continue
    if (k === 'tag') {
      if (!h.tags.some((t) => t.toLowerCase() === wanted.toLowerCase())) return false
    } else if (k === 'flag') {
      if (!FLAGS[wanted]?.test(h)) return false
    } else if ((filterValue(h, k) ?? '').toLowerCase() !== wanted.toLowerCase()) return false
  }
  return true
}

/** Hosts whose own fields contain the text (the service search adds component matches). */
function textMatch(h: FleetHost, q: string): boolean {
  const hay = [h.id, h.model, h.lab, h.rack, h.cpu_model, h.description, h.serial, ...h.tags]
  return hay.some((v) => v && v.toLowerCase().includes(q))
}

export function filterHosts(
  hosts: FleetHost[],
  filters: Filters,
  q: string,
  searchHits: Map<string, SearchMatch[]> | null,
): FleetHost[] {
  const text = q.trim().toLowerCase()
  return hosts.filter(
    (h) => matchesFilters(h, filters) && (!text || textMatch(h, text) || (searchHits?.has(h.id) ?? false)),
  )
}

/** Value counts for a facet among hosts matching every *other* filter, so chips show what selecting adds. */
export function facetCounts(hosts: FleetHost[], filters: Filters, key: FilterKey): [string, number][] {
  const counts = new Map<string, number>()
  for (const h of hosts) {
    if (!matchesFilters(h, filters, key)) continue
    const values = key === 'tag' ? h.tags : key === 'flag' ? Object.keys(FLAGS).filter((f) => FLAGS[f].test(h)) : [filterValue(h, key)]
    for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
}

export interface HostGroup {
  lab: string
  racks: { rack: string; hosts: FleetHost[] }[]
  count: number
}

const NONE = '—'
const byName = (a: string, b: string) => (a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b, undefined, { numeric: true }))

/** Lab → rack → hosts, sorted naturally; hosts without a lab or rack go last. */
export function groupHosts(hosts: FleetHost[]): HostGroup[] {
  const labs = new Map<string, Map<string, FleetHost[]>>()
  for (const h of hosts) {
    const racks = labs.get(h.lab ?? NONE) ?? new Map<string, FleetHost[]>()
    labs.set(h.lab ?? NONE, racks)
    const list = racks.get(h.rack ?? NONE) ?? []
    racks.set(h.rack ?? NONE, list)
    list.push(h)
  }
  return [...labs.keys()].sort(byName).map((lab) => {
    const racks = labs.get(lab)!
    return {
      lab,
      count: [...racks.values()].reduce((n, l) => n + l.length, 0),
      racks: [...racks.keys()].sort(byName).map((rack) => ({
        rack,
        hosts: racks.get(rack)!.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
      })),
    }
  })
}

/** Host ids in display order, for previous/next navigation in the host view. */
export const orderedIds = (hosts: FleetHost[]) => groupHosts(hosts).flatMap((g) => g.racks.flatMap((r) => r.hosts.map((h) => h.id)))
