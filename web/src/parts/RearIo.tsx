import { M } from './materials'
import { PortRow, portsOf } from './PcieCard'
import { B } from './prim'
import type { PartProps } from './types'

/** Onboard rear I/O block: LOM RJ45s, BMC port, USB and VGA. */
export function RearIo({ size, component, present, active }: PartProps) {
  const [w, h, d] = size
  const rear = d / 2
  const ports = portsOf(component?.summary)
  return (
    <group>
      <B p={[0, 0, rear - 1]} s={[w, h, 2]} m={M.steelDark} />
      <B p={[0, -h / 2 + 3, 0]} s={[w, 6, d]} m={M.pcbDark} />
      {present && (
        <PortRow ports={ports.length ? ports : [{}, {}]} span={w * 0.4} y={-h / 2 + 11} z={rear - 0.2} kind="rj45" active={active} />
      )}
      {/* BMC dedicated port */}
      <B p={[w * 0.32, -h / 2 + 11, rear + 1.5]} s={[15, 13, 5]} m={M.steel} />
      {/* USB ×2 */}
      <B p={[w * 0.32, h / 2 - 7, rear + 1.5]} s={[13, 5, 4]} m={M.touchBlue} />
      {/* VGA */}
      <B p={[-w * 0.3, h / 2 - 8, rear + 1.5]} s={[31, 11, 4]} m={M.touchBlue} />
    </group>
  )
}
