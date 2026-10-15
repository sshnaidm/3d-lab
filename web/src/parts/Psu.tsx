import { useMemo } from 'react'
import { healthLevel } from '../topology/types'
import { labelTexture } from './labelTexture'
import { LED_COLORS, ledMaterial, M } from './materials'
import { B, Ghost, Led, Sticker } from './prim'
import { num, str, type PartProps } from './types'

export function Psu({ size, component, present }: PartProps) {
  const [w, h, d] = size
  const rear = d / 2
  const watts = num(component?.summary.capacity_w)
  const label = useMemo(
    () =>
      labelTexture([watts ? `${watts}W` : 'PSU', str(component?.summary.model) ?? '', '80 PLUS PLATINUM'], {
        width: 512,
        height: 320,
        background: '#dcdfe2',
      }),
    [watts, component?.summary.model],
  )
  const led = ledMaterial(LED_COLORS[healthLevel(component?.health)])

  if (!present)
    return (
      <group>
        <B p={[0, 0, rear - 1.5]} s={[w, h, 3]} m={M.steelDark} />
        <Ghost s={[w, h, d]} fill={M.emptyGhost} />
      </group>
    )

  return (
    <group>
      <B s={[w, h, d]} m={M.steel} />
      <Sticker p={[0, h / 2 + 0.05, -d * 0.1]} w={w * 0.8} h={d * 0.45} face="top" map={label} />
      {/* rear face: fan grille, AC inlet, handle, release tab, LED */}
      <B p={[-w * 0.18, 0, rear + 0.6]} s={[w * 0.5, h * 0.8, 1.2]} m={M.honeycomb} />
      <B p={[w * 0.24, -h * 0.12, rear + 2]} s={[w * 0.26, h * 0.42, 4]} m={M.plastic} />
      <B p={[w * 0.24, -h * 0.12, rear + 4.1]} s={[w * 0.18, h * 0.28, 0.4]} m={M.port} />
      <B p={[0, h * 0.25, rear + 14]} s={[w * 0.7, 5, 5]} m={M.plastic} />
      <B p={[-w * 0.35, h * 0.25, rear + 7]} s={[5, 5, 14]} m={M.plastic} />
      <B p={[w * 0.35, h * 0.25, rear + 7]} s={[5, 5, 14]} m={M.plastic} />
      <B p={[w * 0.42, h * 0.3, rear + 3]} s={[5, 10, 6]} m={M.hotOrange} />
      <Led p={[w * 0.24, h * 0.3, rear + 1]} m={led} d={3} />
    </group>
  )
}
