import type { Topology } from '../topology/types'
import { cpuAnchors, dellDimmAnchors, fanAnchors, fanCount, networkAnchors, psuAnchors, type DellModel } from './dell'
import { BOARD_TOP, type Anchor, type Layout, type LayoutFactory, type Riser, type Vec3 } from './types'
import { maxBayIndex } from './util'

// Dell PowerEdge 1U family: R640 (14G), R650 (15G), R660 (16G). All numbers are millimetres and APPROXIMATE,
// derived from public photos and chassis dimensions; the R650 is the reference. Calibrate against each
// model's system-board diagram in its Installation and Service Manual before relying on exact positions.
const WIDTH = 434 // internal width
const EAR_WIDTH = 482 // 19" rack ears
const HEIGHT = 42.8
const DEPTH = 700
const FRONT = -DEPTH / 2
const REAR = DEPTH / 2

const DRIVE_CAGE_DEPTH = 115
const FAN_Z = -190
// Four high-performance modules (R650/R660) or eight single-rotor fans (R640) across the same span.
const FAN_SIZE: Vec3 = [92, 36, 52]
const FAN_SPAN = 400

const CPU_Z = -40
// CPU1 sits on the right when viewed from the front, as on the 2U models (verify on the service manual).
const CPU_X: Record<number, number> = { 1: 108.5, 2: -108.5 }
const CPU_SIZE: Vec3 = [100, 26, 96] // 1U heatsink
const DIMM_PITCH = 7
const DIMM_SIZE: Vec3 = [5.5, 31, 133]
const BANK_GAP = 52.5

const PSU_SIZE: Vec3 = [86, 38, 200]
const PSU_X: Record<number, number> = { 1: -175, 2: 175 }

const CARD_LENGTH = 170
const CARD_THICKNESS = 14
const CARD_Y = 28 // riser cards lie flat above the board
// slot → [centre x, width]; slots 1–2 full height, slot 3 low profile. The three cards fit between the PSUs.
const PCIE_SLOTS: Record<number, [number, number]> = {
  1: [82, 100],
  2: [-18, 100],
  3: [-100, 64],
}
const OCP_SIZE: Vec3 = [76, 12, 115]
const OCP_X = 70
const LOM_SIZE: Vec3 = [110, 14, 26]
const LOM_X = -40

export const DELL_1U: Record<string, DellModel> = {
  'dell-r640': { id: 'dell-r640', name: 'Dell PowerEdge R640', generation: 14, dimms: 'intel-12', fans: 8, pcieSlots: [1, 2, 3] },
  'dell-r650': { id: 'dell-r650', name: 'Dell PowerEdge R650', generation: 15, dimms: 'intel-16', fans: 4, pcieSlots: [1, 2, 3] },
  'dell-r660': { id: 'dell-r660', name: 'Dell PowerEdge R660', generation: 16, dimms: 'intel-16', fans: 4, pcieSlots: [1, 2, 3] },
}

function driveAnchors(maxBay: number): Anchor[] {
  const z = FRONT + DRIVE_CAGE_DEPTH / 2
  const out: Anchor[] = []
  if (maxBay >= 4) {
    // 8 or 10 × 2.5": 5 columns × 2 rows, bay 0 bottom-left
    const colW = 72
    const x0 = -(colW * 5) / 2
    for (let i = 0; i < 10; i++) {
      const col = Math.floor(i / 2)
      const row = i % 2
      out.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [x0 + colW * (col + 0.5), 3 + row * 19 + 9, z],
        size: [colW - 2, 17, DRIVE_CAGE_DEPTH - 6],
        variant: '2.5h',
      })
    }
  } else {
    // 4 × 3.5" in one row
    const colW = WIDTH / 4
    for (let i = 0; i < 4; i++)
      out.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [-WIDTH / 2 + colW * (i + 0.5), 21, z],
        size: [colW - 4, 36, DRIVE_CAGE_DEPTH - 6],
        variant: '3.5',
      })
  }
  return out
}

export function dell1u(model: DellModel): LayoutFactory {
  return (topo: Topology): Layout => {
    const anchors: Anchor[] = [
      ...cpuAnchors(CPU_X, CPU_Z, CPU_SIZE),
      ...dellDimmAnchors(model.dimms, CPU_X, CPU_Z, DIMM_SIZE, BANK_GAP, DIMM_PITCH),
      ...fanAnchors(fanCount(topo, model.fans), FAN_SPAN, FAN_Z, FAN_SIZE),
      ...psuAnchors(PSU_X, PSU_SIZE, REAR),
      ...model.pcieSlots.map(
        (slot): Anchor => ({
          slot_key: `pcie:${slot}`,
          kind: 'pcie',
          label: `Slot ${slot}`,
          pos: [PCIE_SLOTS[slot][0], CARD_Y, REAR - CARD_LENGTH / 2],
          size: [PCIE_SLOTS[slot][1], CARD_THICKNESS, CARD_LENGTH],
        }),
      ),
      ...networkAnchors(
        model,
        topo,
        { x: OCP_X, y: BOARD_TOP + OCP_SIZE[1] / 2 + 2, size: OCP_SIZE },
        { x: LOM_X, size: LOM_SIZE },
        REAR,
      ),
      ...driveAnchors(maxBayIndex(topo)),
    ]

    const risers: Riser[] = model.pcieSlots.map((slot) => ({
      x: PCIE_SLOTS[slot][0] - PCIE_SLOTS[slot][1] / 2 - 4,
      y0: 18,
      y1: 40,
      z0: REAR - CARD_LENGTH + 10,
      z1: REAR - 4,
    }))

    return {
      id: model.id,
      name: model.name,
      approximate: true,
      chassis: { width: WIDTH, height: HEIGHT, depth: DEPTH, earWidth: EAR_WIDTH },
      board: { x0: -WIDTH / 2 + 6, x1: WIDTH / 2 - 6, z0: FAN_Z + 30, z1: REAR - 2 },
      driveCage: { z0: FRONT, z1: FRONT + DRIVE_CAGE_DEPTH },
      fanWall: { z: FAN_Z, depth: FAN_SIZE[2] + 6 },
      risers,
      anchors,
    }
  }
}
