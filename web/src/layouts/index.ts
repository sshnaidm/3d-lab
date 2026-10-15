import type { Component, Topology } from '../topology/types'
import { dell1u, DELL_1U } from './dell-1u'
import { dell2u, DELL_2U } from './dell-2u'
import { genericLayout } from './generic'
import models from './models.json'
import type { Anchor, Layout, LayoutFactory } from './types'

/** Layout id (as in models.json) → factory. Dell rack servers are two families with per-model parameters. */
export const FACTORIES: Record<string, LayoutFactory> = {
  ...Object.fromEntries(Object.entries(DELL_1U).map(([id, model]) => [id, dell1u(model)])),
  ...Object.fromEntries(Object.entries(DELL_2U).map(([id, model]) => [id, dell2u(model)])),
}

// Model patterns live in models.json so the fleet service reports the same layout per model.
const TEMPLATES = models.layouts
  .filter((l) => FACTORIES[l.id])
  .map((l) => ({ match: new RegExp(l.match, 'i'), factory: FACTORIES[l.id] }))

export function resolveLayout(topo: Topology): Layout {
  const models = [topo.system.model, topo.chassis.model].filter(Boolean).join(' ')
  const template = TEMPLATES.find((t) => t.match.test(models))
  return (template?.factory ?? genericLayout)(topo)
}

export interface Placement {
  anchor: Anchor
  component: Component | undefined
}

/** Join layout anchors with components; components without an anchor are "unplaced". */
export function place(layout: Layout, topo: Topology): { placements: Placement[]; unplaced: Component[] } {
  const bySlot = new Map<string, Component>()
  for (const c of topo.components) if (c.slot_key) bySlot.set(c.slot_key, c)
  const anchored = new Set(layout.anchors.map((a) => a.slot_key))
  return {
    placements: layout.anchors.map((anchor) => ({ anchor, component: bySlot.get(anchor.slot_key) })),
    unplaced: topo.components.filter((c) => !c.slot_key || !anchored.has(c.slot_key)),
  }
}

export type { Anchor, Layout } from './types'
