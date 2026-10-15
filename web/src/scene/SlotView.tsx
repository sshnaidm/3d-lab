import { Edges, Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { easing } from 'maath'
import { useCallback, useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Placement } from '../layouts'
import type { Vec3 } from '../layouts/types'
import { PARTS } from '../parts'
import { healthLevel, type Kind } from '../topology/types'
import { placementId, useExplorer } from '../ui/store'
import { HEALTH_COLORS, KIND_COLORS } from './colors'
import { frameDelta, sceneChanged } from './demand'
import { objectRegistry } from './registry'

const HIGHLIGHT = '#4fd1c5'
const DIFF_COLORS = { added: '#3ee07a', changed: '#ffae1a', removed: '#ff3b36' }
const DIFF_GLOW = {
  added: new THREE.Color(DIFF_COLORS.added).multiplyScalar(2),
  changed: new THREE.Color(DIFF_COLORS.changed).multiplyScalar(2),
  removed: new THREE.Color(DIFF_COLORS.removed).multiplyScalar(2),
}
// Above 1.0 so the bloom pass makes the edges glow.
const HIGHLIGHT_GLOW = new THREE.Color(HIGHLIGHT).multiplyScalar(2.2)

// Exploded view: each kind moves along its natural removal direction (mm).
const EXPLODE: Record<Kind, Vec3> = {
  cpu: [0, 95, 0],
  dimm: [0, 60, 0],
  pcie: [0, 110, 0],
  ocp: [0, 0, 110],
  lom: [0, 0, 0],
  psu: [0, 0, 170],
  fan: [0, 85, 0],
  drive: [0, 0, -150],
  storage: [0, 0, 0],
}

export function SlotView({ placement }: { placement: Placement }) {
  const { anchor, component } = placement
  const id = placementId(placement)
  const present = !!component?.present
  const Part = PARTS[anchor.kind]

  const hovered = useExplorer((s) => s.hoveredId === id)
  const selected = useExplorer((s) => s.selectedId === id)
  const exploded = useExplorer((s) => s.exploded)
  const hideEmpty = useExplorer((s) => s.hideEmpty)
  const colorMode = useExplorer((s) => s.colorMode)
  const diffMark = useExplorer((s) => s.diff?.marks.get(id))
  const hover = useExplorer((s) => s.hover)
  const select = useExplorer((s) => s.select)

  const group = useRef<THREE.Group>(null)
  const register = useCallback(
    (g: THREE.Group | null) => {
      group.current = g
      if (g) objectRegistry.set(id, g)
      else objectRegistry.delete(id)
    },
    [id],
  )
  useEffect(() => () => void objectRegistry.delete(id), [id])

  useFrame((state, delta) => {
    const dt = frameDelta(delta)
    if (!group.current) return
    const off = exploded ? EXPLODE[anchor.kind] : [0, 0, 0]
    const moving = easing.damp3(
      group.current.position,
      [anchor.pos[0] + off[0], anchor.pos[1] + off[1], anchor.pos[2] + off[2]],
      0.28,
      dt,
    )
    if (moving) sceneChanged(state)
  })

  if (!Part || (hideEmpty && !present && !diffMark)) return null

  const overlay =
    colorMode === 'real' || !present
      ? null
      : colorMode === 'type'
        ? KIND_COLORS[anchor.kind]
        : HEALTH_COLORS[healthLevel(component?.health)]

  return (
    <group
      ref={register}
      position={anchor.pos}
      onPointerOver={(e) => {
        e.stopPropagation()
        hover(id)
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        if (useExplorer.getState().hoveredId === id) hover(null)
        document.body.style.cursor = ''
      }}
      onClick={(e) => {
        e.stopPropagation()
        select(id)
      }}
    >
      <Part
        size={anchor.size}
        component={component}
        variant={anchor.variant}
        present={present}
        active={hovered || selected}
      />
      {(hovered || selected) && (
        // Glowing bounding box: two draw calls, unlike an outline effect that re-renders the whole scene.
        <mesh scale={[anchor.size[0] + 3, anchor.size[1] + 3, anchor.size[2] + 3]} raycast={() => null}>
          <boxGeometry />
          <meshBasicMaterial
            color={HIGHLIGHT}
            transparent
            opacity={selected ? 0.1 : 0.05}
            depthWrite={false}
            toneMapped={false}
          />
          <Edges color={HIGHLIGHT_GLOW} lineWidth={selected ? 2.5 : 1.5} toneMapped={false} />
        </mesh>
      )}
      {overlay && (
        <mesh scale={[anchor.size[0] + 2, anchor.size[1] + 2, anchor.size[2] + 2]} raycast={() => null}>
          <boxGeometry />
          <meshBasicMaterial color={overlay} transparent opacity={0.22} depthWrite={false} toneMapped={false} />
          <Edges color={overlay} />
        </mesh>
      )}
      {diffMark && (
        <mesh scale={[anchor.size[0] + 6, anchor.size[1] + 6, anchor.size[2] + 6]} raycast={() => null}>
          <boxGeometry />
          <meshBasicMaterial color={DIFF_COLORS[diffMark]} transparent opacity={0.18} depthWrite={false} toneMapped={false} />
          <Edges color={DIFF_GLOW[diffMark]} lineWidth={2} toneMapped={false} />
        </mesh>
      )}
      {hovered && (
        <Html position={[0, anchor.size[1] / 2 + 8, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="panel whitespace-nowrap rounded-md px-2.5 py-1 font-mono text-[11px] text-ink-100 shadow-lg">
            <span className="text-signal">{anchor.label}</span>
            <span className="text-ink-400"> · </span>
            {present ? component!.name : 'empty'}
          </div>
        </Html>
      )}
    </group>
  )
}
