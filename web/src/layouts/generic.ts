import type { Component, Kind, Topology } from '../topology/types'
import { BOARD_TOP, type Anchor, type Layout, type Riser, type Vec3 } from './types'
import { maxBayIndex, slotNumber } from './util'

// Fallback layout for chassis without a hand-made template. Components are arranged in the
// usual airflow order (drives → fans → CPUs/DIMMs → PSUs/cards) and sized from the U height.
const WIDTH = 434
const EAR_WIDTH = 482
const U = 43.6

function byKind(topo: Topology, kind: Kind): Component[] {
  return topo.components
    .filter((c) => c.kind === kind && c.slot_key)
    .sort((a, b) => (a.slot_key ?? '').localeCompare(b.slot_key ?? '', undefined, { numeric: true }))
}

/** DIMM socket index: "P2-A1" → 2, "B3" → 2; defaults to 1. */
function dimmCpu(slotKey: string, cpuCount: number): number {
  const label = slotKey.replace(/^dimm:/, '')
  const p = /^P(\d+)/i.exec(label) ?? /CPU(\d+)/i.exec(label)
  if (p) return Math.min(Number(p[1]), cpuCount)
  const letter = /^([A-Z])\d+$/i.exec(label)
  if (letter && cpuCount > 1) return Math.min(letter[1].toUpperCase().charCodeAt(0) - 64, cpuCount)
  return 1
}

export function genericLayout(topo: Topology): Layout {
  const cpus = byKind(topo, 'cpu')
  const dimms = byKind(topo, 'dimm')
  const uHeight = topo.chassis.u_height ?? (cpus.length > 1 || dimms.length > 16 ? 2 : 1)
  const height = uHeight * U - 0.8
  const depth = uHeight >= 2 ? 715 : 650
  const front = -depth / 2
  const rear = depth / 2
  const anchors: Anchor[] = []

  // Drives: 3.5" row for ≤4 bays, otherwise 2.5" (vertical in 2U+, horizontal in 1U).
  const bays = Math.max(maxBayIndex(topo) + 1, byKind(topo, 'drive').length)
  const cageDepth = bays > 0 ? 120 : 0
  if (bays > 0) {
    const threeFive = bays <= 4
    const vertical = !threeFive && uHeight >= 2
    const slots = threeFive ? 4 : vertical ? Math.max(bays, 8) : Math.max(bays, 10)
    const perRow = vertical ? slots : threeFive ? 4 : 10
    const colW = WIDTH / perRow
    const rowH = vertical ? height - 12 : threeFive ? 26 : 15
    for (let i = 0; i < slots; i++) {
      const col = i % perRow
      const row = Math.floor(i / perRow)
      anchors.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [-WIDTH / 2 + colW * (col + 0.5), 4 + row * (rowH + 1) + rowH / 2, front + cageDepth / 2],
        size: [colW - 2, rowH, cageDepth - 6],
        variant: threeFive ? '3.5' : vertical ? '2.5v' : '2.5h',
      })
    }
  }

  // Fans
  const fans = byKind(topo, 'fan')
  const fanSide = Math.min(uHeight >= 2 ? 64 : 40, height - 6, WIDTH / Math.max(fans.length, 1) - 6)
  const fanDepth = uHeight >= 2 ? 38 : 56
  const fanZ = front + cageDepth + 30 + fanDepth / 2
  fans.forEach((f, i) => {
    const pitch = WIDTH / fans.length
    anchors.push({
      slot_key: f.slot_key!,
      kind: 'fan',
      label: f.slot_label ?? `Fan ${i + 1}`,
      pos: [-WIDTH / 2 + pitch * (i + 0.5), BOARD_TOP + fanSide / 2 + 1, fanZ],
      size: [fanSide, fanSide, fanDepth],
    })
  })

  // CPUs with their DIMMs split on both sides
  const cpuCount = Math.max(cpus.length, 1)
  const cpuH = uHeight >= 2 ? 58 : 27
  const dimmH = Math.min(36, height - 6)
  const cpuZ = fanZ + fanDepth / 2 + 110
  const zoneW = WIDTH / cpuCount
  // Tighten the DIMM pitch when a CPU has more slots than fit in its zone at the usual 7.5 mm.
  const maxPerSide = Math.max(1, ...cpus.map((_, i) => Math.ceil(dimms.filter((d) => dimmCpu(d.slot_key!, cpuCount) === i + 1).length / 2)))
  const pitch = Math.min(7.5, (zoneW / 2 - 50 - 3) / maxPerSide)
  cpus.forEach((c, i) => {
    const cx = -WIDTH / 2 + zoneW * (i + 0.5)
    anchors.push({
      slot_key: c.slot_key!,
      kind: 'cpu',
      label: c.slot_label ?? `CPU${i + 1}`,
      pos: [cx, BOARD_TOP + cpuH / 2, cpuZ],
      size: [90, cpuH, 90],
    })
    const mine = dimms.filter((d) => dimmCpu(d.slot_key!, cpuCount) === i + 1)
    const half = Math.ceil(mine.length / 2)
    mine.forEach((d, j) => {
      const side = j < half ? -1 : 1
      const k = j < half ? half - 1 - j : j - half
      anchors.push({
        slot_key: d.slot_key!,
        kind: 'dimm',
        label: d.slot_label ?? d.slot_key!,
        pos: [cx + side * (50 + pitch / 2 + k * pitch), BOARD_TOP + dimmH / 2, cpuZ],
        size: [5.5, dimmH, 133],
        variant: 'primary',
      })
    })
  })

  // PSUs stacked side by side on the right rear
  const psus = byKind(topo, 'psu')
  const psuSize: Vec3 = [uHeight >= 2 ? 86 : 74, 40, 210]
  psus.forEach((p, i) => {
    const x = WIDTH / 2 - psuSize[0] / 2 - 2 - i * (psuSize[0] + 2)
    anchors.push({
      slot_key: p.slot_key!,
      kind: 'psu',
      label: p.slot_label ?? `PSU${i + 1}`,
      pos: [x, psuSize[1] / 2 + 1, rear - psuSize[2] / 2 + 8],
      size: psuSize,
    })
  })
  const psuLeftEdge = psus.length ? WIDTH / 2 - psus.length * (psuSize[0] + 2) : WIDTH / 2

  // Rear I/O and OCP along the bottom, riser cards lying flat above them
  const lom = byKind(topo, 'lom')
  const ocp = byKind(topo, 'ocp')
  let lowX = -WIDTH / 2 + 8
  for (const c of [...lom, ...ocp]) {
    // In 1U the riser cards lie flat just above the rear I/O, so the LOM block stays low.
    const size: Vec3 = c.kind === 'lom' ? [100, uHeight >= 2 ? Math.min(30, height - 12) : 14, 26] : [76, 14, 115]
    anchors.push({
      slot_key: c.slot_key!,
      kind: c.kind,
      label: c.slot_label ?? c.kind.toUpperCase(),
      pos: [lowX + size[0] / 2, BOARD_TOP + size[1] / 2 + 1, rear - size[2] / 2],
      size,
    })
    lowX += size[0] + 6
  }

  const cards = byKind(topo, 'pcie')
  const cardLen = 168
  const risers: Riser[] = []
  const cardY = [height - 14, height - 32].filter((y) => y > 36)
  const perColumn = Math.max(cardY.length, 1)
  // Low-profile width, narrowed when the columns would not fit between the left wall and the PSUs.
  const columns = Math.ceil(cards.length / perColumn)
  const cardW = Math.min(69, (psuLeftEdge - 8 + WIDTH / 2 - 4) / Math.max(columns, 1) - 12)
  cards.forEach((c, i) => {
    const col = Math.floor(i / perColumn)
    const row = i % perColumn
    const x = psuLeftEdge - 8 - cardW / 2 - col * (cardW + 12)
    if (row === 0)
      risers.push({ x: x - cardW / 2 - 4, y0: BOARD_TOP, y1: height - 4, z0: rear - cardLen + 10, z1: rear - 4 })
    anchors.push({
      slot_key: c.slot_key!,
      kind: 'pcie',
      label: c.slot_label ?? `Slot ${slotNumber(c.slot_key!) ?? i + 1}`,
      pos: [x, cardY[row] ?? height - 14, rear - cardLen / 2],
      size: [cardW, 14, cardLen],
    })
  })

  return {
    id: 'generic',
    name: `Generic ${uHeight}U`,
    approximate: true,
    chassis: { width: WIDTH, height, depth, earWidth: EAR_WIDTH },
    board: { x0: -WIDTH / 2 + 6, x1: WIDTH / 2 - 6, z0: fanZ + fanDepth / 2 + 8, z1: rear - 2 },
    driveCage: cageDepth ? { z0: front, z1: front + cageDepth } : undefined,
    fanWall: fans.length ? { z: fanZ, depth: fanDepth + 6 } : undefined,
    risers,
    anchors,
  }
}
