import { useFrame } from '@react-three/fiber'
import { frameDelta, sceneChanged } from '../scene/demand'
import { easing } from 'maath'
import { useMemo, useRef } from 'react'
import type * as THREE from 'three'
import { BOARD_TOP, type Layout, type Vec3 } from '../layouts/types'
import { labelTexture } from './labelTexture'
import { M } from './materials'
import { B, mergedBoxes, Sticker } from './prim'

const WALL = 1.2

export function Chassis({
  layout,
  model,
  lidOn,
  exploded,
}: {
  layout: Layout
  model: string
  lidOn: boolean
  exploded: boolean
}) {
  const { width: W, height: H, depth: D, earWidth } = layout.chassis
  const front = -D / 2
  const rear = D / 2
  const lid = useRef<THREE.Group>(null)
  const risers = useRef<THREE.Group>(null)

  useFrame((state, delta) => {
    const dt = frameDelta(delta)
    let moving = false
    // Lid slides back and lifts away when removed.
    if (lid.current) {
      moving = easing.damp3(lid.current.position, lidOn ? [0, 0, 0] : [0, 260, 180], 0.25, dt) || moving
      lid.current.visible = lid.current.position.y < 250
    }
    if (risers.current) moving = easing.damp3(risers.current.position, [0, exploded ? 110 : 0, 0], 0.25, dt) || moving
    if (moving) sceneChanged(state)
  })

  const lidLabel = useMemo(
    () =>
      labelTexture([model, 'SERVICE TAG INFO · CONFIGURATION'], { width: 1024, height: 256, background: '#cfd3d6' }),
    [model],
  )
  const board = layout.board
  const boardW = board.x1 - board.x0
  const boardD = board.z1 - board.z0

  return (
    <group>
      {/* tray */}
      <B p={[0, WALL / 2, 0]} s={[W + 2 * WALL, WALL, D]} m={M.steel} />
      <B p={[-W / 2 - WALL / 2, H / 2, 0]} s={[WALL, H, D]} m={M.steel} />
      <B p={[W / 2 + WALL / 2, H / 2, 0]} s={[WALL, H, D]} m={M.steel} />
      {/* rack ears with front control panels */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (W / 2 + (earWidth - W) / 4), H / 2, front - 1]}>
          <B s={[(earWidth - W) / 2, H, 3]} m={M.gunmetal} />
          <B p={[0, H * 0.2, -1.8]} s={[(earWidth - W) / 2 - 6, H * 0.35, 0.6]} m={M.plastic} />
        </group>
      ))}
      {/* motherboard */}
      <B
        p={[(board.x0 + board.x1) / 2, BOARD_TOP - 1, (board.z0 + board.z1) / 2]}
        s={[boardW, 1.6, boardD]}
        m={M.pcbDark}
      />
      <BoardDetails layout={layout} />
      {/* drive cage + backplane */}
      {layout.driveCage && (
        <group>
          <B p={[0, H - 1, layout.driveCage.z1 - 6]} s={[W, 2, 12]} m={M.steelDark} />
          {/* recessed front wall; bays without a sled read as blanks */}
          <B p={[0, H / 2, layout.driveCage.z0 + 9]} s={[W, H - 2, 6]} m={M.plastic} />
          <B p={[0, H / 2, layout.driveCage.z1 + 2]} s={[W - 4, H - 6, 2.4]} m={M.pcbDark} />
        </group>
      )}
      {/* fan cage */}
      {layout.fanWall && (
        <group>
          <B p={[0, 2, layout.fanWall.z]} s={[W, 3, layout.fanWall.depth]} m={M.gunmetal} />
          <B p={[0, H * 0.82, layout.fanWall.z - layout.fanWall.depth / 2 - 1]} s={[W, 3, 2]} m={M.gunmetal} />
        </group>
      )}
      {/* rear frame strips */}
      <B p={[0, H - 2, rear - 1]} s={[W, 4, 2]} m={M.steelDark} />
      {/* riser boards */}
      <group ref={risers}>
        {layout.risers.map((r, i) => (
          <group key={i}>
            <B p={[r.x, (r.y0 + r.y1) / 2, r.z1 - 40]} s={[1.6, r.y1 - r.y0, 70]} m={M.pcbDark} />
            <B p={[r.x + 2, (r.y0 + r.y1) / 2, r.z1 - 40]} s={[3, r.y1 - r.y0 - 6, 60]} m={M.plastic} />
            <B p={[r.x - 1.5, (r.y0 + r.y1) / 2, r.z1 - 2]} s={[2, r.y1 - r.y0, 4]} m={M.steel} />
            <B p={[r.x, r.y1 + 2, (r.z0 + r.z1) / 2]} s={[5, 3, 22]} m={M.touchBlue} />
          </group>
        ))}
      </group>
      {/* lid */}
      <group ref={lid} position={[0, 260, 180]}>
        <B p={[0, H + 0.6, 0]} s={[W + 2 * WALL + 1, 1.2, D]} m={M.steel} />
        <Sticker p={[0, H + 1.3, front + 90]} w={W * 0.8} h={W * 0.2} face="top" map={lidLabel} />
      </group>
    </group>
  )
}

/** Non-interactive board features: VRM heatsinks, PCH, BMC, capacitors. */
function BoardDetails({ layout }: { layout: Layout }) {
  const cpus = layout.anchors.filter((a) => a.kind === 'cpu')
  const rearZ = layout.board.z1
  return (
    <group>
      {cpus.map((c) => (
        <group key={c.slot_key}>
          <B p={[c.pos[0], BOARD_TOP + 4, c.pos[2] + c.size[2] / 2 + 16]} s={[c.size[0] * 0.7, 8, 10]} m={M.aluminum} />
          <mesh
            geometry={mergedBoxes(
              `vrm:${c.pos[0]}:${c.pos[2]}:${c.size[2]}`,
              Array.from({ length: 6 }, (_, i) => ({
                p: [c.pos[0] - 20 + i * 8, BOARD_TOP + 3, c.pos[2] + c.size[2] / 2 + 30] as Vec3,
                s: [5, 6, 5] as Vec3,
              })),
            )}
            material={M.chip}
            castShadow
          />
        </group>
      ))}
      {/* PCH heatsink */}
      <B p={[0, BOARD_TOP + 4, rearZ - 230]} s={[34, 8, 34]} m={M.aluminum} />
      {/* BMC */}
      <B p={[-30, BOARD_TOP + 1, rearZ - 190]} s={[18, 2, 18]} m={M.chip} />
      {/* CMOS battery */}
      <mesh position={[40, BOARD_TOP + 1.5, rearZ - 200]}>
        <cylinderGeometry args={[10, 10, 3, 24]} />
        <meshStandardMaterial color="#c8ccd0" metalness={1} roughness={0.25} />
      </mesh>
    </group>
  )
}
