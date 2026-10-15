import type { Kind, Topology } from '../topology/types'

/** [x, y, z] in millimetres. x = right (viewed from front), y = up, z = front(-) → rear(+). */
export type Vec3 = [number, number, number]

/** A physical slot in the chassis. `pos` is the centre of the part's bounding box, `size` its extent. */
export interface Anchor {
  slot_key: string
  kind: Kind
  label: string
  pos: Vec3
  size: Vec3
  /** Part-specific hint, e.g. drive form factor ('2.5v', '2.5h', '3.5') or DIMM tab colour ('primary'). */
  variant?: string
}

export interface Riser {
  x: number
  y0: number
  y1: number
  z0: number
  z1: number
}

export interface Layout {
  id: string
  name: string
  /** True when coordinates are estimates rather than measured from vendor drawings. */
  approximate: boolean
  chassis: { width: number; height: number; depth: number; earWidth: number }
  board: { x0: number; x1: number; z0: number; z1: number }
  driveCage?: { z0: number; z1: number }
  fanWall?: { z: number; depth: number }
  risers: Riser[]
  anchors: Anchor[]
}

export type LayoutFactory = (topo: Topology) => Layout

export const BOARD_TOP = 3.2
