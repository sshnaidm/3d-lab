import type { HealthLevel, Kind } from '../topology/types'

export const KIND_COLORS: Record<Kind, string> = {
  cpu: '#ff7a6b',
  dimm: '#4fd1c5',
  pcie: '#b28cff',
  ocp: '#8c9eff',
  lom: '#9fb3c2',
  psu: '#ffd166',
  fan: '#64b5f6',
  drive: '#7ee08f',
  storage: '#e39bd6',
}

export const HEALTH_COLORS: Record<HealthLevel, string> = {
  ok: '#3ee07a',
  warning: '#ffae1a',
  critical: '#ff3b36',
  unknown: '#6b7a8a',
}
