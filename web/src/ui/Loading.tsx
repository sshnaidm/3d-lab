import { useExplorer } from './store'

export function Loading() {
  const loading = useExplorer((s) => s.loading)
  const error = useExplorer((s) => s.error)
  if (!loading && !error) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <div className="panel rounded-xl px-6 py-4 font-mono text-xs">
        {error ? (
          <span className="text-crit">Failed to load topology: {error}</span>
        ) : (
          <span className="animate-pulse text-signal">Loading topology…</span>
        )}
      </div>
    </div>
  )
}
