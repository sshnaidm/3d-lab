import type { Vec3 } from '../layouts/types'
import { M } from './materials'
import { PortRow, portsOf } from './PcieCard'
import { B, Ghost, mergedBoxes } from './prim'
import type { PartProps } from './types'

export function OcpCard({ size, component, present, active }: PartProps) {
  const [w, h, d] = size
  const rear = d / 2
  if (!present)
    return (
      <group>
        <B p={[0, 0, rear - 1]} s={[w, h, 2]} m={M.steelDark} />
        <Ghost s={[w, h, d]} fill={M.emptyGhost} />
      </group>
    )
  const ports = portsOf(component?.summary)
  const rj45 = ports.some((p) => (p.speed_mbps ?? 0) > 0 && (p.speed_mbps ?? 0) <= 10000)
  return (
    <group>
      {/* OCP 3.0 sled: carrier tray, PCB, heatsink, faceplate with pull tab */}
      <B p={[0, -h / 2 + 0.6, 0]} s={[w, 1.2, d]} m={M.steel} />
      <B p={[0, -h / 2 + 2, -2]} s={[w - 4, 1.6, d - 6]} m={M.pcb} />
      <mesh
        geometry={mergedBoxes(
          `ocp-fins:${w}:${h}:${d}`,
          Array.from({ length: 7 }, (_, i) => ({
            p: [-w * 0.18 + i * w * 0.06, -h / 2 + 6, -d * 0.1] as Vec3,
            s: [0.6, 6, d * 0.35] as Vec3,
          })),
        )}
        material={M.aluminum}
        castShadow
      />
      <B p={[0, 0, rear - 1]} s={[w, h, 2]} m={M.steel} />
      <PortRow ports={ports} span={w * 0.75} y={0} z={rear - 0.2} kind={rj45 ? 'rj45' : 'sfp'} active={active} />
      <B p={[w / 2 - 5, h / 2 - 3, rear + 5]} s={[6, 4, 10]} m={M.touchBlue} />
    </group>
  )
}
