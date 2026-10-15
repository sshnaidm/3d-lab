import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Vec3 } from '../layouts/types'
import { M } from './materials'
import { frameDelta } from '../scene/demand'
import { B, Cyl, mergedBoxes } from './prim'
import type { PartProps } from './types'

const BLADES = 7

export function Fan({ size, component, present, active }: PartProps) {
  const [w, h, d] = size
  const rotor = useRef<THREE.Group>(null)
  const rpms = (component?.summary.rpm as number[] | undefined) ?? []
  const rpm = rpms.length ? rpms.reduce((a, b) => a + b, 0) / rpms.length : 0
  // Spins only while hovered or selected, so an idle scene needs no frames. Visual speed is scaled far down.
  useFrame((state, dt) => {
    if (!rotor.current || !present || !active) return
    rotor.current.rotation.z += frameDelta(dt) * (rpm / 900)
    state.invalidate()
  })
  const blades = useMemo(
    () =>
      mergedBoxes(
        `fan-blades:${w}`,
        Array.from({ length: BLADES }, (_, i) => {
          const a = (i / BLADES) * Math.PI * 2
          const r = w * 0.28
          // Blade i: rotate by a around the hub, then pitch/twist the blade itself.
          const q = new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(0, 0, 1), a)
            .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.55, 0.25)))
          return { p: [-Math.sin(a) * r, Math.cos(a) * r, 0] as Vec3, s: [w * 0.2, w * 0.3, 1.4] as Vec3, r: q }
        }),
      ),
    [w],
  )

  const wall = 2.5
  return (
    <group>
      <B p={[0, h / 2 - wall / 2, 0]} s={[w, wall, d]} m={M.plastic} />
      <B p={[0, -h / 2 + wall / 2, 0]} s={[w, wall, d]} m={M.plastic} />
      <B p={[w / 2 - wall / 2, 0, 0]} s={[wall, h, d]} m={M.plastic} />
      <B p={[-w / 2 + wall / 2, 0, 0]} s={[wall, h, d]} m={M.plastic} />
      {/* hot-plug handle */}
      <B p={[0, h / 2 + 2, -d / 4]} s={[w * 0.35, 4, 8]} m={M.touchBlue} />
      {present && (
        <group ref={rotor}>
          <Cyl d={w * 0.36} h={d * 0.7} m={M.plastic} rotation={[Math.PI / 2, 0, 0]} />
          <mesh geometry={blades} material={M.plastic} castShadow />
        </group>
      )}
    </group>
  )
}
