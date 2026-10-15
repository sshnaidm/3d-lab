import type { ReactNode } from 'react'
import { useExplorer, type ColorMode, type ViewPreset } from './store'

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
        on ? 'bg-signal/15 text-signal ring-1 ring-signal/40' : 'text-ink-300 hover:bg-ink-800 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="mx-1 h-5 w-px bg-ink-700" />

export function Toolbar() {
  const s = useExplorer()
  const modes: [ColorMode, string][] = [
    ['real', 'Real'],
    ['type', 'By type'],
    ['health', 'By health'],
  ]
  const views: [ViewPreset, string][] = [
    ['iso', 'Iso'],
    ['front', 'Front'],
    ['rear', 'Rear'],
    ['top', 'Top'],
  ]
  return (
    <div className="panel pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-xl px-2 py-1.5">
      <Toggle on={s.lidOn} onClick={() => s.setLid(!s.lidOn)}>
        Lid
      </Toggle>
      <Toggle on={s.exploded} onClick={() => s.setExploded(!s.exploded)}>
        Explode
      </Toggle>
      <Toggle on={s.hideEmpty} onClick={() => s.setHideEmpty(!s.hideEmpty)}>
        Hide empty
      </Toggle>
      <Toggle on={s.backdrop} onClick={() => s.setBackdrop(!s.backdrop)}>
        Backdrop
      </Toggle>
      <Divider />
      {modes.map(([m, label]) => (
        <Toggle key={m} on={s.colorMode === m} onClick={() => s.setColorMode(m)}>
          {label}
        </Toggle>
      ))}
      <Divider />
      {views.map(([v, label]) => (
        <Toggle key={v} on={s.view.preset === v} onClick={() => s.goTo(v)}>
          {label}
        </Toggle>
      ))}
    </div>
  )
}
