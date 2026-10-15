import { useSyncExternalStore } from 'react'

/**
 * Hash routes, so the viewer works from any path and as static files:
 *   #/                      fleet page (optional ?lab=…&state=…&q=… filters)
 *   #/host/<id>             3D view of one host
 *   #/host/<id>/<slot_key>  3D view with one component selected
 * Old links (#<id>) still open the host.
 */
export type Route =
  | { page: 'fleet'; query: URLSearchParams }
  | { page: 'host'; id: string; slot: string | null }

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (!h || h === '/' || h.startsWith('/?') || h.startsWith('?')) {
    const q = h.indexOf('?')
    return { page: 'fleet', query: new URLSearchParams(q >= 0 ? h.slice(q + 1) : '') }
  }
  const parts = h.replace(/^\//, '').split('/')
  if (parts[0] === 'host' && parts[1]) {
    return { page: 'host', id: decodeURIComponent(parts[1]), slot: parts[2] ? decodeURIComponent(parts.slice(2).join('/')) : null }
  }
  if (parts.length === 1) return { page: 'host', id: decodeURIComponent(parts[0]), slot: null } // legacy #<id>
  return { page: 'fleet', query: new URLSearchParams() }
}

export function hostHref(id: string, slot?: string | null): string {
  return `#/host/${encodeURIComponent(id)}${slot ? `/${encodeURIComponent(slot)}` : ''}`
}

export function fleetHref(query?: URLSearchParams | Record<string, string>): string {
  const q = new URLSearchParams(query).toString()
  return q ? `#/?${q}` : '#/'
}

export function navigate(href: string) {
  if (location.hash !== href) location.hash = href
}

/** Change the URL without adding a history entry (selection, filters). */
export function replaceRoute(href: string) {
  if (location.hash !== href) {
    history.replaceState(null, '', href)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
const snapshot = () => location.hash

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot)
  // parse on every render is cheap; the hash string keeps React from re-rendering on unrelated events
  return parseRoute(hash)
}
