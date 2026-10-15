import type { Topology } from '../topology/types'
import { BOARD_TOP, type Anchor, type Vec3 } from './types'
import { slotNumber } from './util'

// Shared pieces of the Dell PowerEdge rack families (dell-1u.ts, dell-2u.ts). Generation differences are
// parameters: DIMM count and order per CPU, network mezzanine (rNDC on 14G, OCP 3.0 from 15G), fan count.

export type DimmScheme =
  /** 14G Intel (Skylake/Cascade Lake): 6 channels × 2, A1–A12; slots 1–6 white latches, 7–12 black. */
  | 'intel-12'
  /** 15G/16G Intel (Ice Lake, Sapphire/Emerald Rapids): 8 channels × 2, A1–A16; 1–8 white, 9–16 black. */
  | 'intel-16'
  /** AMD EPYC 9004 (R7625 and friends): 12 channels × 1, A1–A12, six on each side of the socket. */
  | 'amd-12'

export interface DellModel {
  id: string
  name: string
  generation: 14 | 15 | 16
  dimms: DimmScheme
  /** Fan positions the chassis has; more fans reported by the BMC widen the row. */
  fans: number
  /** PCIe slot numbers the riser options can populate. */
  pcieSlots: number[]
}

// Per-CPU slot order walking outward from the socket: [towards the chassis wall, towards the centre].
const DIMM_ORDER: Record<DimmScheme, [number[], number[]]> = {
  // Channels hold two slots: the white-latch slot sits farther from the CPU than its black-latch pair.
  'intel-16': [
    [9, 1, 10, 2, 11, 3, 12, 4],
    [13, 5, 14, 6, 15, 7, 16, 8],
  ],
  'intel-12': [
    [7, 1, 8, 2, 9, 3],
    [10, 4, 11, 5, 12, 6],
  ],
  'amd-12': [
    [1, 2, 3, 4, 5, 6],
    [7, 8, 9, 10, 11, 12],
  ],
}

/** DIMM slots per CPU (A… for CPU1, B… for CPU2), split on both sides of each socket. */
export function dellDimmAnchors(
  scheme: DimmScheme,
  cpuX: Record<number, number>,
  cpuZ: number,
  size: Vec3,
  bankGap: number,
  pitch: number,
): Anchor[] {
  const [outer, inner] = DIMM_ORDER[scheme]
  const firstBlack = scheme === 'intel-16' ? 9 : 7
  const out: Anchor[] = []
  for (const socket of [1, 2]) {
    const bank = socket === 1 ? 'A' : 'B'
    const cx = cpuX[socket]
    const outward = Math.sign(cx) // outer bank lies towards the chassis wall
    const place = (order: number[], dir: number) =>
      order.forEach((n, i) => {
        out.push({
          slot_key: `dimm:${bank}${n}`,
          kind: 'dimm',
          label: `${bank}${n}`,
          pos: [cx + dir * (bankGap + pitch / 2 + i * pitch), BOARD_TOP + size[1] / 2, cpuZ],
          size,
          // AMD boards have one slot per channel, all with the same latch colour.
          variant: scheme === 'amd-12' || n < firstBlack ? 'primary' : 'secondary',
        })
      })
    place(outer, outward)
    place(inner, -outward)
  }
  return out
}

export function cpuAnchors(cpuX: Record<number, number>, cpuZ: number, size: Vec3): Anchor[] {
  return [1, 2].map((s) => ({
    slot_key: `cpu:${s}`,
    kind: 'cpu' as const,
    label: `CPU${s}`,
    pos: [cpuX[s], BOARD_TOP + size[1] / 2, cpuZ] as Vec3,
    size,
  }))
}

/** Highest fan number the BMC reports (fan:6 → 6), so a chassis with more fans than expected still places them. */
export function fanCount(topo: Topology, expected: number): number {
  let n = expected
  for (const c of topo.components) if (c.kind === 'fan' && c.slot_key) n = Math.max(n, slotNumber(c.slot_key) ?? 0)
  return n
}

/** A row of `count` fans across `span`, centred, fan 1 on the left when viewed from the front. */
export function fanAnchors(count: number, span: number, z: number, size: Vec3, lift = 0): Anchor[] {
  const pitch = span / count
  const w = Math.min(size[0], pitch - 4)
  return Array.from({ length: count }, (_, i) => ({
    slot_key: `fan:${i + 1}`,
    kind: 'fan' as const,
    label: `Fan ${i + 1}`,
    pos: [-span / 2 + pitch * (i + 0.5), BOARD_TOP + size[1] / 2 + lift, z] as Vec3,
    size: [w, size[1], size[2]] as Vec3,
  }))
}

export function psuAnchors(x: Record<number, number>, size: Vec3, rear: number): Anchor[] {
  return [1, 2].map((p) => ({
    slot_key: `psu:${p}`,
    kind: 'psu' as const,
    label: `PSU${p}`,
    pos: [x[p], size[1] / 2 + 1, rear - size[2] / 2 + 8] as Vec3,
    size,
  }))
}

export const hasKind = (topo: Topology, kind: string) => topo.components.some((c) => c.kind === kind)

/**
 * Network mezzanine and onboard ports. Dell reports the mezzanine as NIC.Integrated.1 (ocp:1): an rNDC
 * daughter card on 14G, an OCP 3.0 card from 15G. Onboard LOM ports (NIC.Embedded) exist from 15G.
 */
export function networkAnchors(
  model: DellModel,
  topo: Topology,
  ocp: { x: number; y: number; size: Vec3 },
  lom: { x: number; size: Vec3 },
  rear: number,
): Anchor[] {
  const out: Anchor[] = [
    {
      slot_key: 'ocp:1',
      kind: 'ocp',
      label: model.generation >= 15 ? 'OCP 3.0' : 'rNDC',
      pos: [ocp.x, ocp.y, rear - ocp.size[2] / 2],
      size: ocp.size,
    },
  ]
  if (model.generation >= 15 || hasKind(topo, 'lom'))
    out.push({
      slot_key: 'lom:1',
      kind: 'lom',
      label: 'Rear I/O',
      pos: [lom.x, BOARD_TOP + lom.size[1] / 2, rear - lom.size[2] / 2],
      size: lom.size,
    })
  return out
}
