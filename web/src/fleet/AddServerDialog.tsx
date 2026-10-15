import { useEffect, useState, type ReactNode } from 'react'
import { hostHref, navigate } from '../app/router'
import { ApiError, type AddServerInput } from '../topology/load'
import { useFleet } from './store'

const INPUT =
  'w-full rounded-md border border-ink-700 bg-ink-950/70 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-600 outline-none focus:border-signal'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-300">
        {label}
        {hint && <span className="ml-1 text-ink-600">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-4" onMouseDown={onClose}>
      <div className="panel w-full max-w-md rounded-xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="rounded px-1.5 text-ink-400 hover:bg-ink-800 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Register a server by BMC IP and credentials; the service collects it right away. */
export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const addServer = useFleet((s) => s.addServer)
  const askToken = useFleet((s) => s.askToken)
  const [form, setForm] = useState<AddServerInput>({ name: '', bmc_ip: '', username: '', password: '', vendor: '', lab: '', rack: '', tags: '', remember: false })
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useFleet((s) => (jobId ? s.jobs[jobId] : undefined))
  const set = (k: keyof AddServerInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }))

  // Open the host as soon as its first collection succeeds.
  const result = job?.hosts?.[form.name]
  useEffect(() => {
    if (job?.state !== 'done') return
    if (result?.status === 'success') {
      onClose()
      navigate(hostHref(form.name))
    }
  }, [job?.state, result?.status, form.name, onClose])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError(null)
    try {
      const started = await addServer({ ...form, name: form.name.trim() || form.bmc_ip.trim().replace(/[^A-Za-z0-9._-]/g, '-') })
      setForm((f) => ({ ...f, name: Object.keys(started.hosts ?? {})[0] ?? f.name, password: '' }))
      setJobId(started.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) askToken(() => void submit())
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (jobId)
    return (
      <Modal title="Add server" onClose={onClose}>
        {job?.state !== 'done' ? (
          <p className="animate-pulse font-mono text-sm text-signal">Collecting {form.name} from its BMC… this can take a minute or two.</p>
        ) : result?.status === 'success' ? (
          <p className="text-sm text-emerald-300">Done — opening {form.name}.</p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-red-300">
              {result?.kind ?? 'error'}: {result?.message ?? 'collection failed'}
            </p>
            <p className="text-ink-300">The server stays in the list; fix access and press Refresh on it.</p>
            <button className="self-end rounded-md bg-ink-800 px-3 py-1.5 text-sm hover:bg-ink-700" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </Modal>
    )

  return (
    <Modal title="Add server" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="BMC IP">
            <input className={INPUT} required value={form.bmc_ip} onChange={set('bmc_ip')} placeholder="10.1.2.3" autoFocus />
          </Field>
          <Field label="Name" hint="optional">
            <input className={INPUT} value={form.name} onChange={set('name')} placeholder="from IP" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" />
          </Field>
          <Field label="Username">
            <input className={INPUT} required value={form.username} onChange={set('username')} autoComplete="off" />
          </Field>
          <Field label="Password">
            <input className={INPUT} required type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
          <Field label="Vendor">
            <select className={INPUT} value={form.vendor} onChange={set('vendor')}>
              <option value="">auto-detect</option>
              <option value="dell">Dell</option>
              <option value="hpe">HPE</option>
              <option value="supermicro">Supermicro</option>
            </select>
          </Field>
          <Field label="Lab" hint="optional">
            <input className={INPUT} value={form.lab} onChange={set('lab')} />
          </Field>
          <Field label="Rack" hint="optional">
            <input className={INPUT} value={form.rack} onChange={set('rack')} />
          </Field>
          <Field label="Tags" hint="comma-separated">
            <input className={INPUT} value={form.tags} onChange={set('tags')} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-[12px] text-ink-300">
          <input type="checkbox" className="mt-0.5 accent-[var(--color-signal)]" checked={!!form.remember} onChange={set('remember')} />
          <span>
            Remember after the service restarts
            <span className="block text-ink-600">Credentials are stored on the service host (file mode 0600). Otherwise they stay in memory only.</span>
          </span>
        </label>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="rounded-md bg-signal/20 px-3 py-1.5 text-sm font-medium text-signal ring-1 ring-signal/50 hover:bg-signal/30">
            Add and collect
          </button>
        </div>
      </form>
    </Modal>
  )
}
