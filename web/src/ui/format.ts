const LABELS: Record<string, [string, (v: unknown) => string]> = {
  model: ['Model', String],
  manufacturer: ['Manufacturer', String],
  cores: ['Cores', String],
  threads: ['Threads', String],
  max_speed_mhz: ['Max speed', (v) => `${v} MHz`],
  capacity_gib: ['Capacity', (v) => `${v} GB`],
  speed_mts: ['Speed', (v) => `${v} MT/s`],
  type: ['Type', String],
  part_number: ['Part number', String],
  serial_number: ['Serial', String],
  capacity_w: ['Capacity', (v) => `${v} W`],
  input_voltage: ['Input', (v) => `${v} V`],
  firmware: ['Firmware', String],
  capacity_gb: ['Capacity', (v) => (Number(v) >= 1000 ? `${Number(v) / 1000} TB` : `${v} GB`)],
  media_type: ['Media', String],
  protocol: ['Protocol', String],
  category: ['Category', String],
  pcie_type: ['PCIe', String],
  lanes: ['Lanes', (v) => `x${v}`],
  form: ['Form factor', (v) => String(v).replace('_', ' ')],
  rpm: ['Speed', (v) => (Array.isArray(v) ? v.map((r) => `${r}`).join(' / ') + ' RPM' : `${v} RPM`)],
  cache_mb: ['Cache', (v) => `${v} MB`],
}

const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** Friendly [label, value] rows for a summary, skipping empties and nested structures handled elsewhere. */
export function summaryRows(summary: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  for (const [k, v] of Object.entries(summary)) {
    if (v === null || v === undefined || v === '' || k === 'ports') continue
    if (typeof v === 'object' && !Array.isArray(v)) continue
    const [label, fmt] = LABELS[k] ?? [titleCase(k), (x: unknown) => (Array.isArray(x) ? x.join(', ') : String(x))]
    rows.push([label, fmt(v)])
  }
  return rows
}

export function formatSpeed(mbps: number | null | undefined): string {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`
}

/** "3 days ago", "just now"; null-safe. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '?'
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [86400 * 30, 'month'],
    [86400 * 365, 'year'],
  ]
  let [size, name] = units[0]
  for (const u of units) if (s >= u[0]) [size, name] = u
  const n = Math.floor(s / size)
  return `${n} ${name}${n === 1 ? '' : 's'} ago`
}

/** History snapshot name (20260412T101500Z) as a local date. */
export function formatTs(ts: string): string {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return ts
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString()
}

export function formatMemory(gib: number | null | undefined): string {
  if (!gib) return '—'
  return gib >= 1024 ? `${+(gib / 1024).toFixed(1)} TB` : `${gib} GB`
}
