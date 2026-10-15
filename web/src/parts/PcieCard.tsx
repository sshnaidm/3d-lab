import type { Vec3 } from '../layouts/types'
import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import { useFleet } from '../fleet/store'
import { healthLevel, type Peer, type Port } from '../topology/types'
import { labelTexture } from './labelTexture'
import { LED_COLORS, ledMaterial, M } from './materials'
import { Cable, type PortKind } from './Cable'
import { B, Ghost, Led, mergedBoxes, Sticker } from './prim'
import { str, type PartProps } from './types'

/** Redfish reports "Up" (DMTF) or "LinkUp" (Dell iDRAC). */
export const isLinkUp = (port: Port | undefined) => /^(link)?up$/i.test(port?.link_status ?? '')

export function portsOf(summary: Record<string, unknown> | undefined): Port[] {
  return Array.isArray(summary?.ports) ? (summary.ports as Port[]) : []
}

export const peerLabel = (peer: Peer) => `${peer.switch} ${peer.port}${peer.vlan ? ` · VLAN ${peer.vlan}` : ''}`

/** Floating tag at the end of a cable: where it goes, or "?" for a live link no wiring file accounts for. */
function PortTag({ x, y, z, port, down }: { x: number; y: number; z: number; port: Port; down: boolean }) {
  const tone = !port.peer ? 'border-ink-600 text-ink-300' : down ? 'border-amber-400/60 text-amber-200' : 'border-signal/50 text-ink-100'
  return (
    <Html position={[x, y, z]} zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`panel -translate-y-1/2 whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10px] ${tone}`}>
        {port.peer ? `→ ${peerLabel(port.peer)}${down ? ' · no link' : ''}` : '→ ?'}
      </div>
    </Html>
  )
}

/** Row of port cages on a bracket face at z = `z`, spread along x within `span`. */
export function PortRow({
  ports,
  span,
  y,
  z,
  kind,
  active = false,
}: {
  ports: Port[]
  span: number
  y: number
  z: number
  kind: PortKind
  /** The card is hovered or selected: show where each cable goes. */
  active?: boolean
}) {
  const wiring = useFleet((s) => !!s.health?.wiring)
  const n = Math.max(ports.length, 1)
  const pitch = Math.min(span / n, kind === 'sfp' ? 15 : 17)
  const [pw, ph] = kind === 'sfp' ? [13, 9] : [15, 13]
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const x = (i - (n - 1) / 2) * pitch
        const port = ports[i]
        const up = isLinkUp(port)
        const cabledDown = !up && !!port?.peer
        return (
          <group key={i}>
            <B p={[x, y, z + 2.5]} s={[pw, ph, 5]} m={M.steel} />
            <B p={[x, y, z + 5.1]} s={[pw - 3, ph - 3, 0.3]} m={M.port} />
            <Led
              p={[x - pw / 2 + 2, y + ph / 2 + 1.5, z + 1]}
              d={1.8}
              m={ledMaterial(up ? LED_COLORS.ok : '#30353b', up ? 3 : 1)}
            />
            {cabledDown && <Led p={[x + pw / 2 - 2, y + ph / 2 + 1.8, z + 1]} d={2.6} m={ledMaterial(LED_COLORS.warning, 3)} />}
            {(up || cabledDown) && <Cable kind={kind} x={x} y={y} z={z + 5} dim={cabledDown} />}
            {active && port && (port.peer || (up && wiring)) && (
              // Staggered down the cable run so neighbouring ports' tags do not sit on top of each other.
              <PortTag x={x} y={y - 18 - i * 14} z={z + 70} port={port} down={cabledDown} />
            )}
          </group>
        )
      })}
    </group>
  )
}

export function PcieCard({ size, component, present, active }: PartProps) {
  const [slotW, t, len] = size
  const s = component?.summary ?? {}
  const lowProfile = s.form === 'low_profile'
  const w = lowProfile ? Math.min(slotW, 69) : slotW
  const x0 = -slotW / 2 + w / 2 // cards hang from the riser side (-x)
  const rear = len / 2
  const pcbY = -t / 2 + 2
  const category = str(s.category) ?? 'other'
  const label = useMemo(
    () =>
      labelTexture([str(s.model) ?? component?.name ?? 'PCIe', str(s.manufacturer) ?? ''], {
        width: 512,
        height: 160,
        background: '#e9ebed',
      }),
    [s.model, s.manufacturer, component?.name],
  )
  const ports = portsOf(s)
  const bracket = <B p={[x0, 0, rear - 0.5]} s={[w + 6, t + 2, 1]} m={M.steel} />

  if (!present)
    return (
      <group>
        <B p={[0, 0, rear - 0.5]} s={[slotW, t + 2, 1]} m={M.steelDark} />
        <Ghost s={[slotW, t, len]} fill={M.emptyGhost} />
      </group>
    )

  const pcb = category === 'storage' ? M.pcbDark : category === 'network' ? M.pcb : M.pcbBlue
  return (
    <group>
      <B p={[x0, pcbY, 0]} s={[w, 1.6, len - 2]} m={pcb} />
      <B p={[-slotW / 2 + 1, pcbY, -len * 0.05]} s={[2, 1.7, len * 0.55]} m={M.gold} />
      {bracket}
      {category === 'gpu' ? (
        <B p={[x0, pcbY + t / 2, 0]} s={[w - 4, t - 4, len - 12]} m={M.gunmetal} />
      ) : (
        <group>
          {/* controller heatsink */}
          <B p={[x0, pcbY + 1.5, -len * 0.08]} s={[w * 0.42, 1.5, len * 0.32]} m={M.aluminum} />
          <mesh
            geometry={mergedBoxes(
              `pcie-fins:${x0}:${w}:${pcbY}:${len}`,
              Array.from({ length: 9 }, (_, i) => ({
                p: [x0 - w * 0.19 + (i * w * 0.38) / 8, pcbY + 5, -len * 0.08] as Vec3,
                s: [0.6, 7, len * 0.32] as Vec3,
              })),
            )}
            material={M.aluminum}
            castShadow
          />
          <Sticker p={[x0, pcbY + 8.6, -len * 0.08]} w={w * 0.4} h={len * 0.12} face="top" map={label} />
          {/* a few passives */}
          {[0.25, 0.32, 0.39].map((f) => (
            <B key={f} p={[x0 + w * 0.3, pcbY + 1.5, len * f - len / 2]} s={[5, 1.4, 4]} m={M.chip} />
          ))}
        </group>
      )}
      {category === 'network' && <PortRow ports={ports} span={w} y={pcbY + 5} z={rear - 0.2} kind="sfp" active={active} />}
      <Led
        p={[x0 + w / 2 - 4, pcbY + 1.5, rear - 4]}
        d={1.8}
        m={ledMaterial(LED_COLORS[healthLevel(component?.health)], 2.5)}
      />
    </group>
  )
}
