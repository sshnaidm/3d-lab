import type CameraControlsImpl from 'camera-controls'
import { create } from 'zustand'
import { place, resolveLayout, type Layout, type Placement } from '../layouts'
import { hostHref, replaceRoute } from '../app/router'
import { ApiError, loadTopology } from '../topology/load'
import type { Component, Topology, TopologyDiff } from '../topology/types'

export type ColorMode = 'real' | 'type' | 'health'
export type ViewPreset = 'iso' | 'front' | 'rear' | 'top'

export interface SceneModel {
  layout: Layout
  placements: Placement[]
  unplaced: Component[]
}

/** Selection id for a placement: the component id, or a synthetic id for an empty slot. */
export const placementId = (p: Placement) => p.component?.id ?? `empty:${p.anchor.slot_key}`

export type DiffMark = 'added' | 'removed' | 'changed'

export interface DiffView {
  ts: string
  data: TopologyDiff
  /** Placement/component id → how it differs from the snapshot (removed parts mark their now-empty slot). */
  marks: Map<string, DiffMark>
}

/** A part that went absent ↔ present in the same slot reads as removed/added, not "changed". */
export function changeMark(fields: Record<string, { old: unknown; new: unknown }>): DiffMark {
  if (fields.present) return fields.present.new ? 'added' : 'removed'
  return 'changed'
}

/** Map a hardware diff onto the current scene so changed parts can be highlighted in 3D. */
function diffMarks(scene: SceneModel, diff: TopologyDiff): Map<string, DiffMark> {
  const marks = new Map<string, DiffMark>()
  const bySlot = new Map(scene.placements.map((p) => [p.anchor.slot_key, placementId(p)]))
  for (const c of diff.removed) {
    const at = c.slot_key ? bySlot.get(c.slot_key) : undefined
    if (at) marks.set(at, 'removed')
  }
  for (const c of diff.changed) marks.set(c.id, changeMark(c.fields))
  for (const c of diff.added) marks.set(c.id, 'added')
  return marks
}

/** URL slot for a selection: the anchor's slot key, else the component's, else its id. */
function slotFor(scene: SceneModel | null, topo: Topology | null, id: string | null): string | null {
  if (!id) return null
  const p = scene?.placements.find((x) => placementId(x) === id)
  if (p) return p.anchor.slot_key
  return topo?.components.find((c) => c.id === id)?.slot_key ?? id
}

/** Selection id for a URL slot (inverse of slotFor). */
function idForSlot(scene: SceneModel | null, topo: Topology | null, slot: string | null): string | null {
  if (!slot || !scene) return null
  const p = scene.placements.find((x) => x.anchor.slot_key === slot)
  if (p) return placementId(p)
  const c = topo?.components.find((x) => x.slot_key === slot || x.id === slot)
  return c?.id ?? null
}

interface ExplorerState {
  serverId: string | null
  topology: Topology | null
  scene: SceneModel | null
  loading: boolean
  error: string | null
  /** The server is known but has no stored topology yet (fleet service only). */
  notCollected: boolean
  diff: DiffView | null

  selectedId: string | null
  hoveredId: string | null
  lidOn: boolean
  exploded: boolean
  hideEmpty: boolean
  backdrop: boolean
  detailCollapsed: boolean
  colorMode: ColorMode

  controls: CameraControlsImpl | null
  /** Bumped whenever the camera should move to a preset view. */
  view: { preset: ViewPreset; nonce: number }

  openServer: (id: string, slot?: string | null) => Promise<void>
  /** Re-read the open server if it is one of `ids` (after a refresh job finished). */
  reloadIfOpen: (ids: string[]) => Promise<void>
  close: () => void
  select: (id: string | null) => void
  selectSlot: (slot: string | null) => void
  slotOfSelection: () => string | null
  setDiff: (ts: string | null, diff?: TopologyDiff) => void
  hover: (id: string | null) => void
  setLid: (on: boolean) => void
  setExploded: (on: boolean) => void
  setHideEmpty: (on: boolean) => void
  setBackdrop: (on: boolean) => void
  setDetailCollapsed: (collapsed: boolean) => void
  setColorMode: (mode: ColorMode) => void
  setControls: (c: CameraControlsImpl | null) => void
  goTo: (preset: ViewPreset) => void
}

// Per-viewer UI preference; storage may be unavailable (private mode), so failures are ignored.
const DETAIL_COLLAPSED_KEY = 'explorer.detailCollapsed'
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // ignore
  }
}

let openSeq = 0

export const useExplorer = create<ExplorerState>((set, get) => ({
  serverId: null,
  topology: null,
  scene: null,
  loading: false,
  error: null,
  notCollected: false,
  diff: null,

  selectedId: null,
  hoveredId: null,
  lidOn: false,
  exploded: false,
  hideEmpty: false,
  backdrop: true,
  detailCollapsed: readFlag(DETAIL_COLLAPSED_KEY),
  colorMode: 'real',

  controls: null,
  view: { preset: 'iso', nonce: 0 },

  openServer: async (id, slot = null) => {
    const seq = ++openSeq
    const same = get().serverId === id && get().topology
    set({ loading: true, error: null, notCollected: false, serverId: id, diff: null })
    if (!same) set({ selectedId: null, hoveredId: null, topology: null, scene: null })
    try {
      const topology = await loadTopology(id)
      if (seq !== openSeq) return // a newer navigation won
      const layout = resolveLayout(topology)
      const scene = { layout, ...place(layout, topology) }
      const keep = same ? slotFor(get().scene, get().topology, get().selectedId) : slot
      set({ topology, scene, loading: false, selectedId: idForSlot(scene, topology, keep) })
      if (!same) get().goTo('iso')
    } catch (e) {
      if (seq !== openSeq) return
      if (e instanceof ApiError && e.status === 404 && /not been collected/.test(e.message))
        set({ loading: false, notCollected: true, topology: null, scene: null })
      else set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  reloadIfOpen: async (ids) => {
    const id = get().serverId
    if (id && ids.includes(id)) await get().openServer(id)
  },

  close: () => {
    openSeq++
    set({ serverId: null, topology: null, scene: null, selectedId: null, hoveredId: null, diff: null, loading: false, error: null, notCollected: false })
  },

  select: (id) => {
    set({ selectedId: id })
    const { serverId, scene, topology } = get()
    if (serverId) replaceRoute(hostHref(serverId, slotFor(scene, topology, id)))
  },
  selectSlot: (slot) => set((s) => ({ selectedId: idForSlot(s.scene, s.topology, slot) })),
  slotOfSelection: () => slotFor(get().scene, get().topology, get().selectedId),
  setDiff: (ts, data) => {
    const scene = get().scene
    set({ diff: ts && data && scene ? { ts, data, marks: diffMarks(scene, data) } : null })
  },

  hover: (id) => set({ hoveredId: id }),
  setLid: (lidOn) => set({ lidOn }),
  setExploded: (exploded) => set({ exploded }),
  setHideEmpty: (hideEmpty) => set({ hideEmpty }),
  setBackdrop: (backdrop) => set({ backdrop }),
  setDetailCollapsed: (detailCollapsed) => {
    writeFlag(DETAIL_COLLAPSED_KEY, detailCollapsed)
    set({ detailCollapsed })
  },
  setColorMode: (colorMode) => set({ colorMode }),
  setControls: (controls) => set({ controls }),
  goTo: (preset) => set((s) => ({ view: { preset, nonce: s.view.nonce + 1 } })),
}))
