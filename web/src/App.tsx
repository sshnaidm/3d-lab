import { lazy, Suspense, useEffect } from 'react'
import { useRoute } from './app/router'
import { FleetPage } from './fleet/FleetPage'
import { useFleet } from './fleet/store'
import { NoticeToast, TokenDialog } from './ui/Overlays'
import { useExplorer } from './ui/store'

// The 3D view (three.js) is loaded only when a host is opened, so the fleet page starts fast.
const HostView = lazy(() => import('./app/HostView'))

export default function App() {
  const route = useRoute()
  const load = useFleet((s) => s.load)
  const loaded = useFleet((s) => s.loaded)
  const close = useExplorer((s) => s.close)

  // The host view needs the fleet list for breadcrumbs and previous/next, even when opened directly.
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  useEffect(() => {
    if (route.page === 'fleet') close()
  }, [route.page, close])

  return (
    <>
      {route.page === 'fleet' ? <FleetPage query={route.query} /> : (
        <Suspense fallback={<div className="p-6 font-mono text-xs text-signal animate-pulse">Loading 3D view…</div>}>
          <HostView id={route.id} slot={route.slot} />
        </Suspense>
      )}
      <TokenDialog />
      <NoticeToast />
    </>
  )
}
