import { useEffect } from 'react'
import { RefreshButton } from '../fleet/HostTable'
import { useFleet } from '../fleet/store'
import { ServerScene } from '../scene/ServerScene'
import { ComponentTree } from '../ui/ComponentTree'
import { DetailPanel } from '../ui/DetailPanel'
import { DiffPanel } from '../ui/DiffPanel'
import { Header } from '../ui/Header'
import { Legend } from '../ui/Legend'
import { Loading } from '../ui/Loading'
import { useExplorer } from '../ui/store'
import { Toolbar } from '../ui/Toolbar'

function NotCollected({ id }: { id: string }) {
  const host = useFleet((s) => s.hosts.find((h) => h.id === id))
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="panel pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-xl px-6 py-5 text-center">
        <p className="text-sm text-ink-100">
          <span className="font-mono text-white">{id}</span> has not been collected yet.
        </p>
        {host?.last_error && <p className="font-mono text-[11px] text-red-300">Last attempt: {host.last_error.kind} — {host.last_error.message}</p>}
        {host && <RefreshButton host={host} />}
      </div>
    </div>
  )
}

export default function HostView({ id, slot }: { id: string; slot: string | null }) {
  const openServer = useExplorer((s) => s.openServer)
  const notCollected = useExplorer((s) => s.notCollected)
  const hasScene = useExplorer((s) => !!s.scene)

  // Open on navigation; a slot-only change (deep link, back button) just moves the selection.
  useEffect(() => {
    const s = useExplorer.getState()
    if (s.serverId !== id) void openServer(id, slot)
    else if (s.slotOfSelection() !== slot) s.selectSlot(slot)
  }, [id, slot, openServer])

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">{hasScene && <ServerScene />}</div>
      <div className="pointer-events-none absolute inset-0 z-10 flex gap-4 p-4">
        <div className="flex w-[340px] shrink-0 flex-col gap-3">
          <Header />
          <DiffPanel />
          {hasScene && <ComponentTree />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">{hasScene && <Toolbar />}</div>
        <div className="flex w-[360px] shrink-0 flex-col items-end justify-between gap-3">
          <DetailPanel />
          <div className="mt-auto">{hasScene && <Legend />}</div>
        </div>
      </div>
      {notCollected && <NotCollected id={id} />}
      <Loading />
    </div>
  )
}
