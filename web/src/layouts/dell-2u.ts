import type { Topology } from '../topology/types'
import { cpuAnchors, dellDimmAnchors, fanAnchors, fanCount, networkAnchors, psuAnchors, type DellModel } from './dell'
import { BOARD_TOP, type Anchor, type Layout, type LayoutFactory, type Riser, type Vec3 } from './types'
import { maxBayIndex } from './util'

// Dell PowerEdge 2U family: R740 (14G), R750 (15G), R760 (16G), R7625 (16G AMD). All numbers are millimetres
// and APPROXIMATE, derived from public photos and chassis dimensions; the R750 is the reference. Calibrate
// against each model's system-board diagram in its Installation and Service Manual before relying on them.
const WIDTH = 434 // internal width
const EAR_WIDTH = 482 // 19" rack ears
const HEIGHT = 86.8
const DEPTH = 715
const FRONT = -DEPTH / 2
const REAR = DEPTH / 2

const DRIVE_CAGE_DEPTH = 125
const FAN_Z = -195
const FAN_SIZE: Vec3 = [64, 64, 38]
const FAN_SPAN = 420

const CPU_Z = -40
// CPU1 sits on the right when viewed from the front (verify on the service manual).
const CPU_X: Record<number, number> = { 1: 108.5, 2: -108.5 }
const DIMM_PITCH = 7
const DIMM_SIZE: Vec3 = [5.5, 36, 133]
const BANK_GAP = 52.5 // CPU centre → first DIMM on each side

const PSU_SIZE: Vec3 = [86, 40, 200]
const PSU_X: Record<number, number> = { 1: -175, 2: 175 }

const CARD_LENGTH = 170
const CARD_THICKNESS = 16
const FULL_HEIGHT_W = 100
// Three risers plus the riser-4 slots over the PSU bay: slot → [riser centre x, y centre].
const PCIE_SLOTS: Record<number, [number, number]> = {
  1: [160, 72],
  2: [160, 52],
  3: [50, 72],
  4: [50, 52],
  5: [-55, 72],
  6: [-55, 52],
  7: [-160, 72],
  8: [-160, 52],
}
const RISER_X = [160, 50, -55, -160]
const OCP_SIZE: Vec3 = [76, 14, 115]
const OCP_X = 50
const LOM_SIZE: Vec3 = [118, 34, 26]
const LOM_X = -52

const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]

export const DELL_2U: Record<string, DellModel> = {
  'dell-r740': { id: 'dell-r740', name: 'Dell PowerEdge R740', generation: 14, dimms: 'intel-12', fans: 6, pcieSlots: ALL_SLOTS },
  'dell-r750': { id: 'dell-r750', name: 'Dell PowerEdge R750', generation: 15, dimms: 'intel-16', fans: 6, pcieSlots: ALL_SLOTS },
  'dell-r760': { id: 'dell-r760', name: 'Dell PowerEdge R760', generation: 16, dimms: 'intel-16', fans: 6, pcieSlots: ALL_SLOTS },
  'dell-r7625': { id: 'dell-r7625', name: 'Dell PowerEdge R7625', generation: 16, dimms: 'amd-12', fans: 6, pcieSlots: ALL_SLOTS },
}

function driveAnchors(maxBay: number): Anchor[] {
  const z = FRONT + DRIVE_CAGE_DEPTH / 2
  const out: Anchor[] = []
  if (maxBay >= 12) {
    // 24 × 2.5" vertical (bays beyond 23, e.g. rear modules, extend the row)
    const n = Math.max(24, maxBay + 1)
    const pitch = WIDTH / n
    for (let i = 0; i < n; i++)
      out.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [-WIDTH / 2 + pitch * (i + 0.5), 42, z],
        size: [pitch - 1, 72, DRIVE_CAGE_DEPTH - 6],
        variant: '2.5v',
      })
  } else if (maxBay >= 8) {
    // 12 × 3.5": 4 columns × 3 rows, bay 0 bottom-left
    const colW = WIDTH / 4
    for (let i = 0; i < 12; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      out.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [-WIDTH / 2 + colW * (col + 0.5), 4 + row * 27 + 13, z],
        size: [colW - 2, 26, DRIVE_CAGE_DEPTH - 6],
        variant: '3.5',
      })
    }
  } else {
    // 8 × 2.5" vertical, centred; the rest of the front is the control-panel blank
    const pitch = WIDTH / 24
    for (let i = 0; i < 8; i++)
      out.push({
        slot_key: `bay:${i}`,
        kind: 'drive',
        label: `Bay ${i}`,
        pos: [-pitch * 4 + pitch * (i + 0.5), 42, z],
        size: [pitch - 1, 72, DRIVE_CAGE_DEPTH - 6],
        variant: '2.5v',
      })
  }
  return out
}

export function dell2u(model: DellModel): LayoutFactory {
  return (topo: Topology): Layout => {
    // AMD SP5 sockets and 16G heatsinks are a little larger than the 15G Intel ones.
    const cpuSize: Vec3 = model.dimms === 'amd-12' ? [104, 58, 100] : [100, 58, 96]
    const anchors: Anchor[] = [
      ...cpuAnchors(CPU_X, CPU_Z, cpuSize),
      ...dellDimmAnchors(model.dimms, CPU_X, CPU_Z, DIMM_SIZE, model.dimms === 'amd-12' ? 56 : BANK_GAP, DIMM_PITCH),
      ...fanAnchors(fanCount(topo, model.fans), FAN_SPAN, FAN_Z, FAN_SIZE, 2),
      ...psuAnchors(PSU_X, PSU_SIZE, REAR),
      ...model.pcieSlots.map(
        (slot): Anchor => ({
          slot_key: `pcie:${slot}`,
          kind: 'pcie',
          label: `Slot ${slot}`,
          pos: [PCIE_SLOTS[slot][0], PCIE_SLOTS[slot][1], REAR - CARD_LENGTH / 2],
          size: [FULL_HEIGHT_W, CARD_THICKNESS, CARD_LENGTH],
        }),
      ),
      ...networkAnchors(
        model,
        topo,
        { x: OCP_X, y: BOARD_TOP + OCP_SIZE[1] / 2 + 4, size: OCP_SIZE },
        { x: LOM_X, size: LOM_SIZE },
        REAR,
      ),
      ...driveAnchors(maxBayIndex(topo)),
    ]

    const risers: Riser[] = RISER_X.map((x) => ({
      x: x - FULL_HEIGHT_W / 2 - 4,
      y0: 42,
      y1: 84,
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
