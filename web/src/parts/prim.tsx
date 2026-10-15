import { useEffect, useMemo } from 'react'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ThreeElements } from '@react-three/fiber'
import * as THREE from 'three'
import type { Vec3 } from '../layouts/types'

const unitBox = new THREE.BoxGeometry(1, 1, 1)
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
const unitPlane = new THREE.PlaneGeometry(1, 1)

type MeshProps = Omit<ThreeElements['mesh'], 'position' | 'scale'>

/** Box centred at `p` with size `s` (mm). */
export function B({ p = [0, 0, 0], s, m, ...rest }: { p?: Vec3; s: Vec3; m: THREE.Material } & MeshProps) {
  return <mesh geometry={unitBox} material={m} position={p} scale={s} castShadow receiveShadow {...rest} />
}

/** Cylinder along Y with diameter `d` and height `h`. */
export function Cyl({
  p = [0, 0, 0],
  d,
  h,
  m,
  ...rest
}: { p?: Vec3; d: number; h: number; m: THREE.Material } & MeshProps) {
  return <mesh geometry={unitCyl} material={m} position={p} scale={[d, h, d]} castShadow receiveShadow {...rest} />
}

export type Face = 'top' | 'front' | 'rear' | 'left' | 'right'

const FACE_ROT: Record<Face, [number, number, number]> = {
  top: [-Math.PI / 2, 0, Math.PI],
  front: [0, Math.PI, 0],
  rear: [0, 0, 0],
  left: [0, -Math.PI / 2, 0],
  right: [0, Math.PI / 2, 0],
}

/** Textured sticker plane facing `face`, centred at `p`, `w`×`h` mm. */
export function Sticker({ p, w, h, face, map }: { p: Vec3; w: number; h: number; face: Face; map: THREE.Texture }) {
  return (
    <mesh geometry={unitPlane} position={p} rotation={FACE_ROT[face]} scale={[w, h, 1]}>
      <meshStandardMaterial
        map={map}
        color="#b8bcc0"
        roughness={0.8}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={-2}
      />
    </mesh>
  )
}

/** Small emissive LED dot. */
export function Led({ p, d = 2.4, m }: { p: Vec3; d?: number; m: THREE.Material }) {
  return <mesh geometry={unitBox} material={m} position={p} scale={[d, d, d]} />
}

const ghostLine = new THREE.LineDashedMaterial({
  color: '#8fc3e8',
  dashSize: 4,
  gapSize: 3,
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
})

/** Outline of a missing part: faint translucent fill plus a dashed edge, sized in mm so dashes stay even. */
export function Ghost({ p = [0, 0, 0], s, fill }: { p?: Vec3; s: Vec3; fill: THREE.Material }) {
  const [w, h, d] = s
  const lines = useMemo(() => {
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), ghostLine)
    l.computeLineDistances()
    return l
  }, [w, h, d])
  useEffect(() => () => lines.geometry.dispose(), [lines])
  return (
    <group position={p}>
      <mesh geometry={unitBox} material={fill} scale={s} />
      <primitive object={lines} />
    </group>
  )
}

export interface BoxSpec {
  p: Vec3
  s: Vec3
  /** Euler rotation, or a quaternion for composed rotations. */
  r?: Vec3 | THREE.Quaternion
}

const mergedCache = new Map<string, THREE.BufferGeometry>()

/**
 * Many same-material boxes as one geometry, so they cost a single draw call. Cached by `key`;
 * callers must include every input that changes the boxes in it.
 */
export function mergedBoxes(key: string, boxes: BoxSpec[]): THREE.BufferGeometry {
  let geometry = mergedCache.get(key)
  if (!geometry) {
    const m = new THREE.Matrix4()
    const parts = boxes.map(({ p, s, r = [0, 0, 0] }) => {
      const q = r instanceof THREE.Quaternion ? r : new THREE.Quaternion().setFromEuler(new THREE.Euler(...r))
      m.compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s))
      return unitBox.clone().applyMatrix4(m)
    })
    geometry = mergeGeometries(parts)
    parts.forEach((g) => g.dispose())
    mergedCache.set(key, geometry)
  }
  return geometry
}
