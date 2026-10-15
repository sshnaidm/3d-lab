import type {
  CoverageModel,
  FleetHost,
  HistoryEntry,
  Job,
  SearchResult,
  ServerIndexEntry,
  ServiceHealth,
  Topology,
  TopologyDiff,
} from './types'

/**
 * Data access for the viewer. Two modes:
 *  - "api": served by the fleet service (`3d-lab`): live index, refresh, history, search.
 *  - "static": plain files under `topology/` (index.json + <id>.json) for sharing snapshots without a service.
 * All URLs are relative to the page, so the viewer works from any path.
 */
export type DataMode = 'api' | 'static'

const BASE = import.meta.env.BASE_URL
let mode: DataMode | null = null
let health: ServiceHealth | null = null

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

// API token for services started with VIEWER_API_TOKEN. Kept for this browser tab only unless the
// user asks to remember it; storage may be unavailable (private mode), so failures are ignored.
const TOKEN_KEY = 'viewer.apiToken'
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token: string | null, remember = false) {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_KEY)
    if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
  } catch {
    // ignore
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.method && init.method !== 'GET') {
    headers.set('X-Viewer-Request', '1') // lets a token-less service accept writes from a local browser
    if (init.body) headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const retry = Number(res.headers.get('Retry-After')) || undefined
    throw new ApiError((body && body.error) || `${path}: HTTP ${res.status}`, res.status, retry)
  }
  return body as T
}

/** Detect the mode once: the service answers /api/health, a static copy does not. */
export async function detectMode(): Promise<DataMode> {
  if (mode) return mode
  try {
    const res = await fetch(`${BASE}api/health`, { headers: authHeaders() })
    const body = res.ok ? ((await res.json()) as ServiceHealth) : null
    if (body?.status === 'ok') {
      health = body
      return (mode = 'api')
    }
  } catch {
    // no service
  }
  return (mode = 'static')
}

function authHeaders(): HeadersInit {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export const serviceHealth = () => health

function checkSchema(id: string, topo: Topology): Topology {
  if (topo.schema_version !== 1) throw new Error(`${id}: unsupported schema_version ${topo.schema_version}`)
  return topo
}

export async function loadFleet(): Promise<FleetHost[]> {
  if ((await detectMode()) === 'api') return (await request<{ servers: FleetHost[] }>('api/servers')).servers
  const res = await fetch(`${BASE}topology/index.json`)
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`)
  const body = (await res.json()) as { servers?: ServerIndexEntry[] }
  return (body.servers ?? []).map((s) => ({
    id: s.id,
    model: s.model,
    tags: [],
    lab: null,
    rack: null,
    state: 'ok',
    configured: false,
    busy: false,
  }))
}

export async function loadTopology(id: string): Promise<Topology> {
  if ((await detectMode()) === 'api') return checkSchema(id, await request<Topology>(`api/servers/${enc(id)}`))
  const res = await fetch(`${BASE}topology/${enc(id)}.json`)
  if (!res.ok) throw new ApiError(`${id}.json: HTTP ${res.status}`, res.status)
  return checkSchema(id, (await res.json()) as Topology)
}

const enc = encodeURIComponent

export const refreshServer = (id: string, force = false) =>
  request<Job>(`api/servers/${enc(id)}/refresh${force ? '?force=1' : ''}`, { method: 'POST' })

export const bulkRefresh = (ids: string[], staleOnly: boolean) =>
  request<Job>('api/refresh', { method: 'POST', body: JSON.stringify({ ids, stale_only: staleOnly }) })

export const getJob = (id: string) => request<Job>(`api/jobs/${enc(id)}`)

export const listJobs = () => request<{ jobs: Job[] }>('api/jobs')

export const loadHistory = (id: string) =>
  request<{ history: HistoryEntry[] }>(`api/servers/${enc(id)}/history`).then((r) => r.history)

export const loadDiff = (id: string, ts: string) =>
  request<TopologyDiff>(`api/servers/${enc(id)}/history/${enc(ts)}/diff`)

export const loadRaw = (id: string, componentId: string) =>
  request<Record<string, unknown>>(`api/servers/${enc(id)}/raw?component=${enc(componentId)}`)

export const searchFleet = (q: string, signal?: AbortSignal) =>
  request<{ results: SearchResult[] }>(`api/search?q=${enc(q)}&limit=500`, { signal }).then((r) => r.results)

export const loadCoverage = () => request<{ models: CoverageModel[] }>('api/coverage').then((r) => r.models)

export interface AddServerInput {
  name: string
  bmc_ip: string
  username: string
  password: string
  vendor?: string
  lab?: string
  rack?: string
  tags?: string
  remember?: boolean
}

export const addServer = (input: AddServerInput) =>
  request<{ server: FleetHost; job: Job }>('api/servers', { method: 'POST', body: JSON.stringify(input) })
