import { describe, expect, test } from 'vitest'
import type { Component, Kind, Topology } from '../topology/types'
import type { DellModel } from './dell'
import { DELL_1U } from './dell-1u'
import { DELL_2U } from './dell-2u'
import { FACTORIES, place, resolveLayout } from './index'
import models from './models.json'
import type { Anchor, Layout } from './types'

// Every captured topology shipped with the viewer (real hosts are redacted).
const CAPTURED = Object.entries(
  import.meta.glob<Topology>('../../public/topology/*.json', { eager: true, import: 'default' }),
)
  .filter(([path]) => !path.endsWith('/index.json'))
  .map(([path, topo]) => [path.split('/').pop()!, topo] as const)

function component(kind: Kind, slot_key: string | null, present = true): Component {
  return { id: slot_key ?? `${kind}-x`, kind, slot_key, slot_label: null, present, health: 'OK', name: slot_key ?? kind, summary: {} }
}

function topology(model: string, components: Component[], u_height: number | null = null): Topology {
  return {
    schema_version: 1,
    server_id: 'synthetic',
    captured_at: '2026-10-13T00:00:00Z',
    system: { vendor: 'Dell Inc.', model, serial: null, health: 'OK', power_state: 'On', bios: null, bmc: null },
    chassis: { model, u_height },
    components,
  }
}

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from)

/** A fully populated configuration of a Dell model: every DIMM, fan, slot and the largest drive cage. */
function fullDell(model: DellModel, bays: number): Topology {
  const perCpu = model.dimms === 'intel-16' ? 16 : 12
  return topology(model.name.replace('Dell ', ''), [
    ...range(2).map((s) => component('cpu', `cpu:${s}`)),
    ...['A', 'B'].flatMap((bank) => range(perCpu).map((n) => component('dimm', `dimm:${bank}${n}`))),
    ...range(model.fans).map((n) => component('fan', `fan:${n}`)),
    ...range(2).map((n) => component('psu', `psu:${n}`)),
    ...model.pcieSlots.map((n) => component('pcie', `pcie:${n}`)),
    component('ocp', 'ocp:1'),
    ...(model.generation >= 15 ? [component('lom', 'lom:1')] : []),
    ...range(bays, 0).map((n) => component('drive', `bay:${n}`)),
    component('storage', null), // controllers have no slot and are listed, not placed
  ])
}

/** Slotted components the layout has no anchor for (shown in the tree as "unplaced"). */
const unplaced = (layout: Layout, topo: Topology) =>
  place(layout, topo)
    .unplaced.filter((c) => c.slot_key)
    .map((c) => c.slot_key)

function overlaps(a: Anchor, b: Anchor, tolerance = 0.5): boolean {
  return [0, 1, 2].every((i) => Math.abs(a.pos[i] - b.pos[i]) < (a.size[i] + b.size[i]) / 2 - tolerance)
}

/** Geometry sanity: unique keys, parts inside the chassis, no two parts in the same space. */
function checkGeometry(layout: Layout) {
  const keys = layout.anchors.map((a) => a.slot_key)
  expect(keys.length, 'duplicate slot keys').toBe(new Set(keys).size)
  const { width, height, depth } = layout.chassis
  const outside = layout.anchors.filter((a) => {
    const [x, y, z] = a.pos
    const [w, h, d] = a.size
    // PSUs and connectors may stand a little proud of the rear face.
    return Math.abs(x) + w / 2 > width / 2 + 1 || y - h / 2 < -1 || y + h / 2 > height + 1 || Math.abs(z) + d / 2 > depth / 2 + 10
  })
  expect(outside.map((a) => a.slot_key), 'parts outside the chassis').toEqual([])
  const clashes: string[] = []
  layout.anchors.forEach((a, i) =>
    layout.anchors.slice(i + 1).forEach((b) => overlaps(a, b) && clashes.push(`${a.slot_key} × ${b.slot_key}`)),
  )
  expect(clashes, 'overlapping parts').toEqual([])
}

describe('layout registry', () => {
  test('every models.json entry has a factory and the reverse', () => {
    expect(models.layouts.map((l) => l.id).sort()).toEqual(Object.keys(FACTORIES).sort())
  })

  test.each([
    ['PowerEdge R7625', 'dell-r7625'],
    ['PowerEdge R760', 'dell-r760'],
    ['PowerEdge R750', 'dell-r750'],
    ['PowerEdge R740', 'dell-r740'],
    ['PowerEdge R660', 'dell-r660'],
    ['PowerEdge R650', 'dell-r650'],
    ['PowerEdge R640', 'dell-r640'],
    ['PowerEdge R760xs', 'generic'], // a different chassis, not an R760
    ['PowerEdge XR8620t', 'generic'],
    ['ProLiant DL380 Gen10', 'generic'],
  ])('%s → %s', (model, id) => {
    expect(resolveLayout(topology(model, [])).id).toBe(id)
  })
})

describe.each(CAPTURED)('captured %s', (_, topo) => {
  const layout = resolveLayout(topo)

  test('places every slotted component', () => {
    expect(unplaced(layout, topo)).toEqual([])
  })

  test('geometry', () => checkGeometry(layout))
})

describe.each([...Object.values(DELL_1U), ...Object.values(DELL_2U)])('$name fully populated', (model) => {
  const bayOptions = model.id in DELL_1U ? [4, 10] : [8, 12, 24]

  test.each(bayOptions)('%i bays: everything placed, no clashes', (bays) => {
    const topo = fullDell(model, bays)
    const layout = resolveLayout(topo)
    expect(layout.id).toBe(model.id)
    expect(unplaced(layout, topo)).toEqual([])
    checkGeometry(layout)
  })

  test('more fans than expected widen the row instead of going unplaced', () => {
    const topo = fullDell(model, 0)
    topo.components.push(component('fan', `fan:${model.fans + 2}`))
    const layout = resolveLayout(topo)
    expect(unplaced(layout, topo)).toEqual([])
    checkGeometry(layout)
  })
})

describe('generic layout', () => {
  test.each([1, 2])('%iU with many cards and drives stays inside the chassis', (u) => {
    const topo = topology('Super Server', [
      component('cpu', 'cpu:1'),
      ...range(2).map((n) => component('psu', `psu:${n}`)),
      ...range(u === 1 ? 4 : 8).map((n) => component('pcie', `pcie:${n}`)),
      component('lom', 'lom:1'),
      ...range(u === 1 ? 10 : 24, 0).map((n) => component('drive', `bay:${n}`)),
    ], u)
    const layout = resolveLayout(topo)
    expect(unplaced(layout, topo)).toEqual([])
    checkGeometry(layout)
  })

  test.each([
    ['1U, one CPU, HPE-style DIMM keys', 1, 1, (n: number) => `dimm:P1-${n}`, 8],
    ['2U, two CPUs, 32 DIMMs', 2, 2, (n: number) => `dimm:${n <= 16 ? 'A' : 'B'}${((n - 1) % 16) + 1}`, 32],
    ['unknown height, two CPUs', null, 2, (n: number) => `dimm:P${n <= 12 ? 1 : 2}-${n}`, 24],
  ])('%s', (_, u, cpus, dimmKey, dimms) => {
    const topo = topology(
      'ProLiant DL3x0 Gen11',
      [
        ...range(cpus).map((s) => component('cpu', `cpu:${s}`)),
        ...range(dimms).map((n) => component('dimm', dimmKey(n))),
        ...range(6).map((n) => component('fan', `fan:${n}`)),
        ...range(2).map((n) => component('psu', `psu:${n}`)),
        ...range(3).map((n) => component('pcie', `pcie:${n}`, n !== 2)),
        component('ocp', 'ocp:1'),
        component('lom', 'lom:1'),
        ...range(8, 0).map((n) => component('drive', `bay:${n}`)),
      ],
      u,
    )
    const layout = resolveLayout(topo)
    expect(layout.id).toBe('generic')
    expect(unplaced(layout, topo)).toEqual([])
    checkGeometry(layout)
  })
})
