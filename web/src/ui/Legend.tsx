export function Legend() {
  return (
    <div className="panel pointer-events-auto rounded-lg px-3 py-2 font-mono text-[10px] leading-relaxed text-ink-400">
      <div><span className="text-ink-100">drag</span> orbit · <span className="text-ink-100">right-drag</span> pan · <span className="text-ink-100">wheel</span> zoom</div>
      <div><span className="text-ink-100">click</span> part for details · <span className="text-ink-100">click empty</span> to deselect</div>
    </div>
  )
}
