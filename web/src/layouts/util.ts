import type { Topology } from '../topology/types'

/** Trailing integer of a slot key, e.g. "pcie:3" → 3, "dimm:P1-A1" → 1. */
export function slotNumber(slotKey: string): number | null {
  const m = /(\d+)$/.exec(slotKey)
  return m ? Number(m[1]) : null
}

export function maxBayIndex(topo: Topology): number {
  let max = -1
  for (const c of topo.components) {
    if (c.kind !== 'drive' || !c.slot_key) continue
    const n = slotNumber(c.slot_key)
    if (n !== null) max = Math.max(max, n)
  }
  return max
}
