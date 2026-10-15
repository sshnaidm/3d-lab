import { hostHref } from '../app/router'
import { healthLevel, type FleetHost, type SearchMatch } from '../topology/types'
import { formatMemory, timeAgo } from '../ui/format'
import { activeJobFor, useFleet, type HostGroup } from './store'

const DOT = { ok: 'bg-emerald-400', warning: 'bg-amber-400', critical: 'bg-red-500', unknown: 'bg-ink-600' }

const FIELD_LABELS: Record<string, string> = {
  id: 'host',
  mac: 'MAC',
  part_number: 'part',
  slot: 'slot',
  cpu_model: 'CPU',
  switch: 'switch',
}

export function StateCell({ host }: { host: FleetHost }) {
  const job = useFleet((s) => activeJobFor(s, host.id))
  const isStatic = useFleet((s) => s.mode === 'static')
  if (isStatic) return <span className="text-ink-600">snapshot</span>
  if (host.busy || job) return <span className="animate-pulse text-signal">collecting…</span>
  const age = timeAgo(host.captured_at)
  switch (host.state) {
    case 'pending':
      return <span className="text-ink-400">not collected</span>
    case 'error':
      return (
        <span className="text-red-300" title={host.last_error?.message}>
          {host.last_error?.kind ?? 'error'}
          {host.captured_at && <span className="text-ink-400"> · data {age}</span>}
        </span>
      )
    case 'stale':
      return <span className="text-amber-300">{age}</span>
    default:
      return <span className="text-ink-300">{age}</span>
  }
}

export function RefreshButton({ host, compact = false }: { host: FleetHost; compact?: boolean }) {
  const refresh = useFleet((s) => s.refresh)
  const busy = useFleet((s) => host.busy || !!activeJobFor(s, host.id))
  const canWrite = useFleet((s) => s.mode === 'api') && host.configured
  if (!canWrite) return null
  return (
    <button
      disabled={busy}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void refresh(host.id)
      }}
      title={busy ? 'Collecting from the BMC…' : 'Collect from the BMC now'}
      className={`rounded-md border border-ink-700 font-mono text-[11px] transition-colors hover:border-signal/60 hover:text-signal disabled:cursor-default disabled:border-ink-800 disabled:text-ink-600 ${
        compact ? 'px-1.5 py-0.5' : 'px-2.5 py-1'
      }`}
    >
      <span className={busy ? 'inline-block animate-spin' : ''}>↻</span>
      {!compact && <span className="ml-1">{busy ? 'Collecting' : 'Refresh'}</span>}
    </button>
  )
}

function Matches({ host, matches }: { host: FleetHost; matches: SearchMatch[] }) {
  // A part often matches on several fields with the same text (name and model); show it once.
  const unique = matches.filter((m, i) => matches.findIndex((x) => x.value === m.value && x.component === m.component) === i)
  const shown = unique.slice(0, 4)
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {shown.map((m, i) => (
        <a
          key={i}
          href={hostHref(host.id, m.slot_key ?? m.component ?? null)}
          onClick={(e) => e.stopPropagation()}
          className="rounded border border-signal/30 bg-signal/5 px-1.5 py-px font-mono text-[10px] text-signal hover:bg-signal/15"
        >
          <span className="text-ink-400">{FIELD_LABELS[m.field] ?? m.field}</span> {m.value}
          {m.port && <span className="text-ink-400"> · port {m.port}</span>}
        </a>
      ))}
      {unique.length > shown.length && <span className="font-mono text-[10px] text-ink-400">+{unique.length - shown.length}</span>}
    </div>
  )
}

function HostRow({ host, matches }: { host: FleetHost; matches?: SearchMatch[] }) {
  const level = host.captured_at ? healthLevel(host.health) : 'unknown'
  const warnings = host.warnings ?? []
  return (
    <tr
      className="group cursor-pointer border-t border-ink-800/80 align-top hover:bg-ink-800/50"
      onClick={() => (location.hash = hostHref(host.id))}
    >
      <td className="py-2 pr-2 pl-3">
        <span className={`mt-1.5 inline-block h-2 w-2 rounded-full ${DOT[level]}`} title={host.health ?? 'unknown health'} />
      </td>
      <td className="py-2 pr-4">
        <a href={hostHref(host.id)} className="font-mono text-[13px] text-white group-hover:text-signal">
          {host.id}
        </a>
        {host.source === 'adhoc' && <span className="ml-2 rounded bg-ink-800 px-1 font-mono text-[10px] text-ink-400">by IP</span>}
        {host.description && <div className="max-w-[260px] truncate text-[11px] text-ink-400">{host.description}</div>}
        {warnings.length > 0 && (
          <div className="mt-0.5 max-w-[320px] truncate text-[11px] text-amber-300/90" title={warnings.map((w) => `${w.name}: ${w.health}`).join('\n')}>
            ⚠ {warnings.map((w) => w.name).join(', ')}
          </div>
        )}
        {matches && <Matches host={host} matches={matches} />}
      </td>
      <td className="truncate py-2 pr-4 text-[13px] text-ink-100">
        {host.model ?? <span className="text-ink-600">—</span>}
        {host.layout === 'generic' && (
          <span className="ml-2 rounded border border-amber-500/30 px-1 font-mono text-[9px] uppercase text-amber-300/80" title="No dedicated 3D layout for this model yet">
            generic
          </span>
        )}
      </td>
      <td className="truncate py-2 pr-4 text-[12px] text-ink-300" title={host.cpu_model ?? undefined}>
        {host.counts?.cpu ? `${host.counts.cpu.present}× ` : ''}
        {host.cpu_model?.replace(/\(R\)|\(TM\)|CPU /g, '').replace(/\s+@.*/, '') ?? '—'}
      </td>
      <td className="py-2 pr-4 text-right font-mono text-[12px] text-ink-300">{formatMemory(host.memory_gib)}</td>
      <td className="py-2 pr-4 text-right font-mono text-[12px]">
        {host.ports_total ? (
          <span
            className={host.ports_up && !host.cabled_down ? 'text-ink-300' : 'text-amber-300'}
            title={[
              'ports with link up / all NIC ports',
              host.cabled_down ? `${host.cabled_down} cabled per wiring but link down` : '',
              host.unknown_peer ? `${host.unknown_peer} up with no known switch port` : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {host.cabled_down ? '⚠ ' : ''}
            {host.ports_up}/{host.ports_total}
          </span>
        ) : (
          <span className="text-ink-600">—</span>
        )}
      </td>
      <td className="py-2 pr-4 font-mono text-[11px] whitespace-nowrap">
        <StateCell host={host} />
      </td>
      <td className="py-2 pr-3 text-right">
        <RefreshButton host={host} compact />
      </td>
    </tr>
  )
}

export function HostTable({ groups, searchHits }: { groups: HostGroup[]; searchHits: Map<string, SearchMatch[]> | null }) {
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.lab} className="panel overflow-hidden rounded-xl">
          <header className="flex items-baseline gap-3 border-b border-ink-700 px-4 py-2.5">
            <h2 className="text-[15px] font-semibold text-white">{g.lab === '—' ? 'No lab' : g.lab}</h2>
            <span className="font-mono text-[11px] text-ink-400">{g.count} hosts</span>
          </header>
          <table className="w-full table-fixed">
            <colgroup>
              <col className="w-7" />
              <col />
              <col className="w-[200px]" />
              <col className="w-[230px]" />
              <col className="w-[90px]" />
              <col className="w-[70px]" />
              <col className="w-[150px]" />
              <col className="w-12" />
            </colgroup>
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-400">
                <th className="w-6" />
                <th className="py-1.5 pr-4 text-left font-normal">Host</th>
                <th className="pr-4 text-left font-normal">Model</th>
                <th className="pr-4 text-left font-normal">CPU</th>
                <th className="pr-4 text-right font-normal">Memory</th>
                <th className="pr-4 text-right font-normal">Links</th>
                <th className="pr-4 text-left font-normal">Collected</th>
                <th className="w-10" />
              </tr>
            </thead>
            {g.racks.map((r) => (
              <tbody key={r.rack}>
                {(g.racks.length > 1 || r.rack !== '—') && (
                  <tr>
                    <td colSpan={8} className="bg-ink-950/40 px-4 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-400">
                      {r.rack === '—' ? 'no rack' : `rack ${r.rack}`} <span className="text-ink-600">· {r.hosts.length}</span>
                    </td>
                  </tr>
                )}
                {r.hosts.map((h) => (
                  <HostRow key={h.id} host={h} matches={searchHits?.get(h.id)} />
                ))}
              </tbody>
            ))}
          </table>
        </section>
      ))}
    </div>
  )
}
