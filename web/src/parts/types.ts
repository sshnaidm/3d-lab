import type { Vec3 } from '../layouts/types'
import type { Component } from '../topology/types'

export interface PartProps {
  size: Vec3
  component: Component | undefined
  variant?: string
  /** Render the part itself; false renders only the empty socket / blank. */
  present: boolean
  /** Hovered or selected; parts may animate (e.g. fans spin) only while active. */
  active?: boolean
}

export const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
