import * as THREE from 'three'

// Shared PBR materials. Parts reuse these instances so hundreds of meshes stay cheap.
const std = (params: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(params)

export const M = {
  steel: std({ color: '#b9bec4', metalness: 0.85, roughness: 0.38 }),
  steelDark: std({ color: '#5b6168', metalness: 0.8, roughness: 0.45 }),
  gunmetal: std({ color: '#2b3036', metalness: 0.7, roughness: 0.5 }),
  aluminum: std({ color: '#d7dce1', metalness: 0.95, roughness: 0.22 }),
  brushed: std({ color: '#c4c9ce', metalness: 0.9, roughness: 0.32 }),
  pcb: std({ color: '#163d33', metalness: 0.1, roughness: 0.55 }),
  pcbBlue: std({ color: '#12305a', metalness: 0.1, roughness: 0.55 }),
  pcbDark: std({ color: '#141a1d', metalness: 0.15, roughness: 0.5 }),
  chip: std({ color: '#0e0f11', metalness: 0.2, roughness: 0.45 }),
  gold: std({ color: '#e0b24f', metalness: 1, roughness: 0.28 }),
  copper: std({ color: '#c47a45', metalness: 1, roughness: 0.3 }),
  plastic: std({ color: '#1a1c1f', metalness: 0.05, roughness: 0.7 }),
  plasticGrey: std({ color: '#474c52', metalness: 0.05, roughness: 0.65 }),
  socketWhite: std({ color: '#e9e6df', metalness: 0, roughness: 0.6 }),
  touchBlue: std({ color: '#2f7fd8', metalness: 0.05, roughness: 0.45 }),
  hotOrange: std({ color: '#e8672a', metalness: 0.05, roughness: 0.5 }),
  port: std({ color: '#0a0b0c', metalness: 0.4, roughness: 0.5 }),
  honeycomb: std({ color: '#34393f', metalness: 0.75, roughness: 0.5 }),
  emptyGhost: new THREE.MeshStandardMaterial({
    color: '#6b7a8a',
    metalness: 0,
    roughness: 1,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  }),
}

const ledCache = new Map<string, THREE.MeshBasicMaterial>()

/** Unlit LED material; values > 1 push it past the bloom threshold. */
export function ledMaterial(color: string, intensity = 3): THREE.MeshBasicMaterial {
  const key = `${color}:${intensity}`
  let m = ledCache.get(key)
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: false })
    ledCache.set(key, m)
  }
  return m
}

export const LED_COLORS = { ok: '#3ee07a', warning: '#ffae1a', critical: '#ff3b36', unknown: '#5aa9ff' } as const
