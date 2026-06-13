/** Compact context-usage meter for the chat header.
 *
 * Shows a thin horizontal bar (used/max) plus a label like "12.4k / 256k · 5%".
 * Color thresholds: normal below 75%, warn 75–90%, danger above 90%.
 * Only renders when ctxMax > 0 (i.e. a model is loaded).
 */

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface ContextMeterProps {
  ctxUsed: number
  ctxMax: number
}

export function ContextMeter({ ctxUsed, ctxMax }: ContextMeterProps) {
  if (ctxMax <= 0) return null

  const pct = ctxMax > 0 ? ctxUsed / ctxMax : 0
  const pctClamped = Math.min(1, pct)
  const pctDisplay = Math.round(pctClamped * 100)

  const fillColor =
    pct > 0.9
      ? 'var(--err)'
      : pct > 0.75
      ? 'var(--warn)'
      : 'var(--accent)'

  const labelStyle: React.CSSProperties =
    pct > 0.9
      ? { color: 'var(--err)' }
      : pct > 0.75
      ? { color: 'var(--warn)' }
      : {}

  const tooltip =
    pct > 0.9
      ? 'Context nearly full — older messages may be truncated'
      : `Context: ${ctxUsed.toLocaleString()} / ${ctxMax.toLocaleString()} tokens`

  return (
    <div
      className="flex items-center gap-1.5 ml-auto"
      title={tooltip}
    >
      {/* Track */}
      <div
        className="h-[3px] w-20 overflow-hidden rounded-full shrink-0"
        style={{ background: 'var(--border)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${(pctClamped * 100).toFixed(1)}%`, background: fillColor }}
        />
      </div>
      {/* Label */}
      <span
        className="text-[11px] text-faint whitespace-nowrap tabular-nums shrink-0"
        style={labelStyle}
      >
        {`${fmtK(ctxUsed)} / ${fmtK(ctxMax)} · ${pctDisplay}%`}
      </span>
    </div>
  )
}
