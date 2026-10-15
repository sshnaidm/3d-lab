// Topology schema v1 — emitted by lab3d/topology.py (`build_topology`).

export type Kind = 'cpu' | 'dimm' | 'pcie' | 'ocp' | 'lom' | 'psu' | 'fan' | 'drive' | 'storage'

export interface Component {
  id: string
  kind: Kind
  slot_key: string | null
  slot_label: string | null
  present: boolean
  health: string | null
  name: string
  summary: Record<string, unknown>
  /** Redfish source; the fleet service leaves it out and serves it lazily (see loadRaw). */
  raw?: Record<string, unknown>
  serial?: string | null
}

/** Switch port a NIC port is cabled to, from the service's wiring files. */
export interface Peer {
  switch: string
  port: string
  vlan?: string
  status?: string
  switch_link_state?: string
  observed_at?: string
  interface?: string
  cable_id?: string
  cable_type?: string
  notes?: string
  source: string
  matched_by: 'mac' | 'fqdd' | 'slot'
}

export interface Port {
  id?: string
  link_status?: string | null
  speed_mbps?: number | null
  mac?: string | null
  peer?: Peer
}

export interface Topology {
  schema_version: 1
  server_id: string
  captured_at: string
  system: {
    vendor: string
    model: string
    serial: string | null
    health: string | null
    power_state: string | null
    bios: string | null
    bmc: string | null
  }
  chassis: { model: string | null; u_height: number | null }
  components: Component[]
}

export interface ServerIndexEntry {
  id: string
  model: string
}

export type HostState = 'ok' | 'stale' | 'error' | 'pending'

/** One row of the fleet service's /api/servers (inventory joined with the store index). */
export interface FleetHost {
  id: string
  model: string | null
  lab: string | null
  rack: string | null
  tags: string[]
  state: HostState
  configured: boolean
  busy: boolean
  description?: string | null
  source?: 'config' | 'adhoc' | 'store'
  vendor?: string | null
  serial?: string | null
  health?: string | null
  power_state?: string | null
  captured_at?: string | null
  changed_at?: string | null
  last_attempt_at?: string | null
  last_error?: { kind: string; message: string; at: string } | null
  layout?: string | null
  memory_gib?: number | null
  cpu_model?: string | null
  counts?: Partial<Record<Kind, { present: number; empty: number }>>
  ports_up?: number
  ports_total?: number
  /** From wiring files: cabled ports, cabled with the link down, link up with no known switch port. */
  cabled?: number
  cabled_down?: number
  unknown_peer?: number
  warnings?: { id: string; name: string; health: string }[]
}

export interface ServiceHealth {
  status: 'ok'
  hosts: number
  active_jobs: number
  writes: 'token' | 'local-only'
  adhoc: boolean
  /** Wiring files are configured: ports without a peer are "unknown", not just "not modelled". */
  wiring?: boolean
}

export interface JobHostResult {
  status: 'pending' | 'success' | 'error'
  kind?: string
  message?: string
  model?: string
  history?: string | null
  seconds?: number
}

export interface Job {
  id: string
  kind: string
  state: 'queued' | 'running' | 'done'
  requested_by: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  total: number
  done: number
  succeeded: number
  failed: number
  hosts?: Record<string, JobHostResult>
}

export interface HistoryEntry {
  ts: string
  captured_at: string | null
  reasons?: string[]
}

interface DiffRef {
  id: string
  slot_key: string | null
  kind: Kind
  name: string
}

export interface TopologyDiff {
  from: string | null
  to: string | null
  system: Record<string, { old: unknown; new: unknown }>
  added: DiffRef[]
  removed: DiffRef[]
  changed: { id: string; slot_key: string | null; fields: Record<string, { old: unknown; new: unknown }> }[]
}

export interface SearchMatch {
  field: string
  value: string
  component?: string
  slot_key?: string | null
  port?: string
}

export interface SearchResult {
  id: string
  model: string | null
  lab: string | null
  matches: SearchMatch[]
}

export interface CoverageModel {
  model: string
  vendor: string | null
  layout: string
  hosts: string[]
  count: number
}

export const KIND_LABELS: Record<Kind, string> = {
  cpu: 'Processors',
  dimm: 'Memory',
  pcie: 'PCIe cards',
  ocp: 'OCP',
  lom: 'Onboard NIC',
  psu: 'Power supplies',
  fan: 'Fans',
  drive: 'Drives',
  storage: 'Storage controllers',
}

export type HealthLevel = 'ok' | 'warning' | 'critical' | 'unknown'

export function healthLevel(health: string | null | undefined): HealthLevel {
  switch ((health ?? '').toLowerCase()) {
    case 'ok':
      return 'ok'
    case 'warning':
      return 'warning'
    case 'critical':
      return 'critical'
    default:
      return 'unknown'
  }
}
