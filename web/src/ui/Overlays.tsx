import { useEffect, useState } from 'react'
import { Modal } from '../fleet/AddServerDialog'
import { useFleet } from '../fleet/store'
import { getToken, setToken } from '../topology/load'

/** Asks for the service's API token when a write was refused, then retries it. */
export function TokenDialog() {
  const prompt = useFleet((s) => s.tokenPrompt)
  const close = useFleet((s) => s.closeTokenPrompt)
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  if (!prompt) return null
  const hadToken = !!getToken()
  return (
    <Modal title="API token required" onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          setToken(value.trim(), remember)
          setValue('')
          close()
          prompt.retry()
        }}
      >
        <p className="text-sm text-ink-300">
          {hadToken ? 'The saved token was refused. ' : ''}
          This service needs its <code className="font-mono text-signal">VIEWER_API_TOKEN</code> to refresh or add servers.
        </p>
        <input
          type="password"
          required
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-3 py-1.5 font-mono text-sm text-ink-100 outline-none focus:border-signal"
        />
        <label className="flex items-center gap-2 text-[12px] text-ink-300">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember in this browser (otherwise until the tab closes)
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="rounded-md bg-signal/20 px-3 py-1.5 text-sm text-signal ring-1 ring-signal/50 hover:bg-signal/30">
            Save and retry
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Short-lived message at the bottom of the screen (job finished, request refused). */
export function NoticeToast() {
  const notice = useFleet((s) => s.notice)
  const notify = useFleet((s) => s.notify)
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => notify(null), notice.kind === 'error' ? 9000 : 5000)
    return () => window.clearTimeout(t)
  }, [notice, notify])
  if (!notice) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      <div
        className={`panel pointer-events-auto flex max-w-xl items-start gap-3 rounded-lg px-4 py-2.5 text-sm shadow-xl ${
          notice.kind === 'error' ? 'border-red-500/50 text-red-200' : 'text-ink-100'
        }`}
      >
        <span className="min-w-0 break-words">{notice.text}</span>
        <button onClick={() => notify(null)} className="text-ink-400 hover:text-white" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  )
}
