import { useMemo } from 'react'
import { healthLevel } from '../topology/types'
import { labelTexture } from './labelTexture'
import { LED_COLORS, ledMaterial, M } from './materials'
import { B, Led, Sticker } from './prim'
import { num, str, type PartProps } from './types'

function capacityText(gb: number | undefined): string {
  if (!gb) return ''
  return gb >= 1000 ? `${(gb / 1000).toFixed(gb % 1000 ? 1 : 0)}TB` : `${gb}GB`
}

export function DriveSled({ size, component, variant, present }: PartProps) {
  const [w, h, d] = size
  const front = -d / 2
  const vertical = variant === '2.5v'
  const s = component?.summary ?? {}
  const label = useMemo(
    () =>
      labelTexture([capacityText(num(s.capacity_gb)), [str(s.protocol), str(s.media_type)].filter(Boolean).join(' ')], {
        width: 256,
        height: 256,
        background: '#1b1f24',
        color: '#e6eaee',
        align: 'center',
      }),
    [s.capacity_gb, s.protocol, s.media_type],
  )

  if (!present)
    return (
      <group>
        {/* drive blank */}
        <B p={[0, 0, front + 5]} s={[w, h, 10]} m={M.plastic} />
        <B p={[0, 0, front - 0.2]} s={[w * 0.6, h * 0.6, 0.6]} m={M.honeycomb} />
      </group>
    )

  const led = ledMaterial(LED_COLORS[healthLevel(component?.health)])
  const [lw, lh] = vertical ? [w * 0.8, w * 0.8] : [h * 0.9, h * 0.9]
  return (
    <group>
      {/* carrier + drive body */}
      <B p={[0, 0, 6]} s={[w - 1, h - 1, d - 12]} m={M.gunmetal} />
      {/* bezel with vent and release latch */}
      <B p={[0, 0, front + 6]} s={[w, h, 12]} m={M.plastic} />
      <B
        p={vertical ? [0, h * 0.1, front - 0.1] : [-w * 0.1, 0, front - 0.1]}
        s={vertical ? [w * 0.7, h * 0.45, 0.4] : [w * 0.55, h * 0.7, 0.4]}
        m={M.honeycomb}
      />
      <B
        p={vertical ? [0, -h / 2 + 7, front - 1] : [w / 2 - 7, 0, front - 1]}
        s={vertical ? [w * 0.7, 7, 2] : [7, h * 0.7, 2]}
        m={M.touchBlue}
      />
      <Sticker
        p={vertical ? [0, h / 2 - lh / 2 - 3, front - 0.3] : [-w / 2 + lw / 2 + 3, 0, front - 0.3]}
        w={lw}
        h={lh}
        face="front"
        map={label}
      />
      <Led p={vertical ? [0, -h / 2 + 13, front - 0.8] : [w / 2 - 14, h / 2 - 3, front - 0.8]} d={2} m={led} />
    </group>
  )
}
