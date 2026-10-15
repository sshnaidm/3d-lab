import { isLinkUp, portsOf } from '../parts/PcieCard'
import type { Peer } from '../topology/types'
import { Fragment, useEffect, useState } from 'react'
import { useFleet } from '../fleet/store'
import { loadRaw } from '../topology/load'
import { KIND_COLORS } from '../scene/colors'
import { KIND_LABELS } from '../topology/types'
import { formatSpeed, formatTs, summaryRows } from './format'
import { HealthPill } from './HealthPill'
import { placementId, useExplorer } from './store'

/** Switch port from the wiring files; flags a cable whose link is down and a live link nobody documented. */
function PeerCell({ peer, up }: { peer: Peer | undefined; up: boolean }) {
  if (!peer)
    return (
      <td colSpan={3} className="pb-1 pl-3 text-ink-600" title={up ? 'Link is up but no wiring file names the switch port' : undefined}>
        → {up ? 'unknown switch port' : 'no wiring entry'}
      </td>
    )
  const detail = [
    peer.status && `status: ${peer.status}`,
    peer.observed_at ? `observed ${formatTs(peer.observed_at)}` : 'planned (not observed)',
    peer.interface && `host interface: ${peer.interface}`,
    peer.cable_type && `cable: ${peer.cable_type}`,
    peer.notes,
    `matched by ${peer.matched_by.toUpperCase()} in ${peer.source}`,
  ]
  return (
    <td colSpan={3} className={`pb-1 pl-3 ${up ? 'text-ink-100' : 'text-amber-300'}`} title={detail.filter(Boolean).join('\n')}>
      → {!up && <span title="Cabled per the wiring files, but the BMC reports no link">⚠ </span>}
      {peer.switch} {peer.port}
      {peer.vlan && <span className="text-ink-400"> · VLAN {peer.vlan}</span>}
      {!peer.observed_at && <span className="text-ink-400"> · planned</span>}
    </td>
  )
}

export function DetailPanel() {
  const selectedId = useExplorer((s) => s.selectedId)
  const scene = useExplorer((s) => s.scene)
  const topo = useExplorer((s) => s.topology)
  const select = useExplorer((s) => s.select)
  const collapsed = useExplorer((s) => s.detailCollapsed)
  const setCollapsed = useExplorer((s) => s.setDetailCollapsed)
  const serverId = useExplorer((s) => s.serverId)
  const api = useFleet((s) => s.mode === 'api')
  const wiringOn = useFleet((s) => !!s.health?.wiring)
  const [showRaw, setShowRaw] = useState(false)
  // The fleet service sends topologies without Redfish source; fetch a component's on demand.
  const [lazyRaw, setLazyRaw] = useState<{ id: string; raw: Record<string, unknown> | string } | null>(null)
  const componentId = (selectedId && topo?.components.find((c) => c.id === selectedId)?.id) ?? null
  useEffect(() => {
    if (!showRaw || !api || !serverId || !componentId || lazyRaw?.id === componentId) return
    if (topo?.components.find((c) => c.id === componentId)?.raw) return
    let live = true
    loadRaw(serverId, componentId)
      .then((raw) => live && setLazyRaw({ id: componentId, raw }))
      .catch((e) => live && setLazyRaw({ id: componentId, raw: `Failed to load: ${e instanceof Error ? e.message : e}` }))
    return () => {
      live = false
    }
  }, [showRaw, api, serverId, componentId, lazyRaw?.id, topo])

  if (!selectedId || !scene || !topo) return null
  const placement = scene.placements.find((p) => placementId(p) === selectedId)
  const component = placement?.component ?? topo.components.find((c) => c.id === selectedId)
  const kind = placement?.anchor.kind ?? component?.kind
  if (!kind) return null
  const present = !!component?.present
  const slot = placement?.anchor.label ?? component?.slot_label ?? '—'
  const ports = portsOf(component?.summary)
  const wiring = wiringOn || ports.some((p) => p.peer)
  const title = present ? component!.name : 'Empty slot'
  const buttonClass = 'rounded px-1.5 text-ink-400 hover:bg-ink-800 hover:text-white'
  const closeButton = (
    <button onClick={() => select(null)} className={buttonClass} aria-label="Close" title="Close">
      ✕
    </button>
  )

  if (collapsed)
    return (
      <div className="panel pointer-events-auto flex max-w-[360px] items-center gap-2 rounded-xl py-2 pr-2 pl-3">
        <button
          onClick={() => setCollapsed(false)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label="Expand details"
          title="Expand details"
        >
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: KIND_COLORS[kind] }} />
          <span className="shrink-0 font-mono text-[11px] text-ink-400">{slot}</span>
          <span className="truncate text-[13px] text-white">{title}</span>
          <span className="shrink-0 text-ink-400">▾</span>
        </button>
        {closeButton}
      </div>
    )

  return (
    <div className="panel pointer-events-auto flex max-h-full w-[360px] flex-col rounded-xl">
      <div className="border-b border-ink-700 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <div
            className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]"
            style={{ color: KIND_COLORS[kind] }}
          >
            <span className="h-2 w-2 rounded-sm" style={{ background: KIND_COLORS[kind] }} />
            {KIND_LABELS[kind]} · {slot}
          </div>
          <div className="flex items-center">
            <button
              onClick={() => setCollapsed(true)}
              className={buttonClass}
              aria-label="Collapse details"
              title="Collapse details"
            >
              ▴
            </button>
            {closeButton}
          </div>
        </div>
        <h2 className="mt-2 text-lg leading-snug font-semibold text-white">{title}</h2>
        <div className="mt-2 flex gap-2">
          {present ? (
            <HealthPill health={component!.health} />
          ) : (
            <HealthPill health={null} label={component ? 'absent' : 'not reported'} />
          )}
          {!placement && (
            <span className="rounded border border-ink-700 px-2 py-0.5 font-mono text-[11px] text-ink-400">
              not placed in 3D
            </span>
          )}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {present ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {summaryRows(component!.summary).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-400">{k}</dt>
                <dd className="font-mono text-[12px] break-all text-ink-100">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-ink-300">
            {component ? 'The BMC reports this slot as absent.' : 'No device reported in this slot.'} Slot key{' '}
            <code className="font-mono text-signal">{placement?.anchor.slot_key}</code>.
          </p>
        )}

        {ports.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-400">Ports</div>
            <table className="w-full font-mono text-[11px]">
              <tbody>
                {ports.map((p, i) => {
                  const up = isLinkUp(p)
                  return (
                    <Fragment key={p.id ?? i}>
                      <tr className="border-t border-ink-800">
                        <td className="py-1 text-ink-300">{p.id ?? i + 1}</td>
                        <td className={up ? 'text-emerald-300' : 'text-ink-400'}>{p.link_status ?? '?'}</td>
                        <td className="text-right text-ink-100">{formatSpeed(p.speed_mbps)}</td>
                      </tr>
                      {wiring && (
                        <tr>
                          <PeerCell peer={p.peer} up={up} />
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {component && (Object.keys(component.raw ?? {}).length > 0 || (api && !component.raw)) && (
          <div className="mt-5">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-400 hover:text-signal"
            >
              {showRaw ? '▾' : '▸'} Redfish JSON
            </button>
            {showRaw && (
              <pre className="scroll-thin mt-2 max-h-72 overflow-auto rounded-md border border-ink-800 bg-ink-950/70 p-3 font-mono text-[11px] leading-relaxed text-ink-300">
                {component.raw
                  ? JSON.stringify(component.raw, null, 2)
                  : lazyRaw?.id === component.id
                    ? typeof lazyRaw.raw === 'string'
                      ? lazyRaw.raw
                      : JSON.stringify(lazyRaw.raw, null, 2)
                    : 'Loading…'}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
