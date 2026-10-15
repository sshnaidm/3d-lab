import { useMemo } from 'react'
import { labelTexture } from './labelTexture'
import { M } from './materials'
import type { Vec3 } from '../layouts/types'
import { B, Ghost, mergedBoxes, Sticker } from './prim'
import { num, str, type PartProps } from './types'

const CHIPS_PER_SIDE = 9

export function Dimm({ size, component, variant, present }: PartProps) {
  const [t, h, len] = size
  const base = -h / 2
  const latch = variant === 'secondary' ? M.plastic : M.socketWhite
  const s = component?.summary ?? {}
  const label = useMemo(
    () =>
      labelTexture(
        [
          `${num(s.capacity_gib) ?? '?'}GB ${str(s.type) ?? 'DDR'}`,
          `${num(s.speed_mts) ?? ''} MT/s`,
          str(s.part_number) ?? '',
        ],
        { width: 512, height: 128, headline: true },
      ),
    [s.capacity_gib, s.type, s.speed_mts, s.part_number],
  )

  const pcbH = h - 6
  const pcbY = base + 5 + pcbH / 2
  const chipZ = (len - 12) / CHIPS_PER_SIDE
  // 18 DRAM packages as one mesh: one draw call per module instead of eighteen.
  const chips = useMemo(
    () =>
      mergedBoxes(
        `dimm-chips:${len}:${pcbY}`,
        [-1, 1].flatMap((side) =>
          Array.from({ length: CHIPS_PER_SIDE }, (_, i) => ({
            p: [side * 1.1, pcbY + 4, -len / 2 + 6 + chipZ * (i + 0.5)] as Vec3,
            s: [0.9, 10, chipZ - 2.5] as Vec3,
          })),
        ),
      ),
    [len, pcbY, chipZ],
  )
  return (
    <group>
      {/* socket; latches stand upright when a module is seated and swing open when the slot is empty */}
      <B p={[0, base + 3, 0]} s={[t + 2, 6, len + 4]} m={M.plastic} />
      {[-1, 1].map((end) => (
        <group key={end} position={[0, base + 1, end * (len / 2 + 3)]} rotation={[present ? 0 : end * 0.6, 0, 0]}>
          <B p={[0, 5, 0]} s={[t + 2, 10, 4]} m={latch} />
        </group>
      ))}
      {!present && (
        <group>
          {/* open groove with the gold contacts showing */}
          <B p={[0, base + 6.05, 0]} s={[1.6, 0.2, len - 4]} m={M.chip} />
          <B p={[0, base + 6.1, 0]} s={[0.6, 0.2, len - 8]} m={M.gold} />
          <Ghost p={[0, pcbY, 0]} s={[1.3, pcbH, len]} fill={M.emptyGhost} />
        </group>
      )}
      {present && (
        <group>
          <B p={[0, pcbY, 0]} s={[1.3, pcbH, len]} m={M.pcb} />
          <B p={[0, base + 5.5, 0]} s={[1.35, 3, len - 6]} m={M.gold} />
          <mesh geometry={chips} material={M.chip} castShadow />
          <Sticker p={[1.6, pcbY - 7, 0]} w={34} h={8.5} face="right" map={label} />
        </group>
      )}
    </group>
  )
}
