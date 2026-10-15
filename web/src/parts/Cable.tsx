import * as THREE from 'three'
import { M } from './materials'
import { B } from './prim'

export type PortKind = 'sfp' | 'rj45'

// Fibre patch leads (aqua, OM3/OM4) for SFP cages, blue Cat6 for RJ45.
const JACKET: Record<PortKind, THREE.MeshStandardMaterial> = {
  sfp: new THREE.MeshStandardMaterial({ color: '#2fb8c4', metalness: 0, roughness: 0.55 }),
  rj45: new THREE.MeshStandardMaterial({ color: '#2a63c9', metalness: 0, roughness: 0.6 }),
}
const BOOT = new THREE.MeshStandardMaterial({ color: '#d9dde0', metalness: 0, roughness: 0.35 })
// Cabled per the wiring files but the BMC reports no link: a faded lead.
const DIM: Record<PortKind, THREE.MeshStandardMaterial> = {
  sfp: new THREE.MeshStandardMaterial({ color: '#2fb8c4', transparent: true, opacity: 0.3, depthWrite: false }),
  rj45: new THREE.MeshStandardMaterial({ color: '#2a63c9', transparent: true, opacity: 0.3, depthWrite: false }),
}

// Cable leaves the port straight back, then sags down behind the server (mm, port-local, +z = outward).
const PATH = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, 22),
  new THREE.Vector3(0, -6, 48),
  new THREE.Vector3(0, -34, 74),
  new THREE.Vector3(0, -90, 86),
])
const RADIUS: Record<PortKind, number> = { sfp: 1.6, rj45: 2.6 }
const TUBES: Record<PortKind, THREE.TubeGeometry> = {
  sfp: new THREE.TubeGeometry(PATH, 32, RADIUS.sfp, 8),
  rj45: new THREE.TubeGeometry(PATH, 32, RADIUS.rj45, 8),
}

/** A plugged-in cable: connector seated in the cage at the origin, lead sagging away along +z. */
export function Cable({ kind, x, y, z, dim = false }: { kind: PortKind; x: number; y: number; z: number; dim?: boolean }) {
  const sfp = kind === 'sfp'
  const plugLen = sfp ? 14 : 12
  const jacket = dim ? DIM[kind] : JACKET[kind]
  return (
    <group position={[x, y, z]}>
      {sfp ? (
        <>
          {/* transceiver body sticking out of the cage, with the pull tab */}
          <B p={[0, 0, plugLen / 2]} s={[10.5, 7, plugLen]} m={M.aluminum} />
          <B p={[0, -2.2, plugLen + 4]} s={[6, 1, 9]} m={jacket} />
          <B p={[0, 0.8, plugLen + 2]} s={[7, 4.5, 4]} m={BOOT} />
        </>
      ) : (
        <>
          {/* RJ45 plug and strain-relief boot */}
          <B p={[0, 0, plugLen / 2]} s={[11.5, 8.5, plugLen]} m={BOOT} />
          <B p={[0, 0, plugLen + 4]} s={[8, 7, 8]} m={jacket} />
        </>
      )}
      <mesh geometry={TUBES[kind]} material={jacket} position={[0, sfp ? 0.8 : 0, plugLen + 4]} castShadow={!dim} />
    </group>
  )
}
