import type { ComponentType } from 'react'
import type { Kind } from '../topology/types'
import { Cpu } from './Cpu'
import { Dimm } from './Dimm'
import { DriveSled } from './DriveSled'
import { Fan } from './Fan'
import { OcpCard } from './OcpCard'
import { PcieCard } from './PcieCard'
import { Psu } from './Psu'
import { RearIo } from './RearIo'
import type { PartProps } from './types'

export const PARTS: Partial<Record<Kind, ComponentType<PartProps>>> = {
  cpu: Cpu,
  dimm: Dimm,
  pcie: PcieCard,
  ocp: OcpCard,
  lom: RearIo,
  psu: Psu,
  fan: Fan,
  drive: DriveSled,
}

export { Chassis } from './Chassis'
export type { PartProps } from './types'
