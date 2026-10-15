import { describe, expect, it } from 'vitest'
import type { FleetHost } from '../topology/types'
import { filterHosts } from './store'

const host = (id: string, model: string, tags: string[] = []): FleetHost => ({
  id,
  model,
  lab: 'lab1',
  rack: 'a12',
  tags,
  state: 'ok',
  configured: true,
  busy: false,
})

describe('filterHosts text search', () => {
  const hosts = [host('db-01', 'PowerEdge R750', ['rack-a12']), host('web-01', 'PowerEdge R650')]
  const ids = (q: string) => filterHosts(hosts, {}, q, null).map((h) => h.id)

  it('matches substrings case-insensitively', () => {
    expect(ids('r750')).toEqual(['db-01'])
    expect(ids('WEB')).toEqual(['web-01'])
  })

  it('ignores punctuation and spaces', () => {
    expect(ids('poweredge-r650')).toEqual(['web-01'])
    expect(ids('rack a12')).toEqual(['db-01'])
    expect(ids('db01')).toEqual(['db-01'])
  })
})
