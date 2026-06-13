// TurboLLM brand mark. The lightning bolt is rendered as inline SVG so it stays
// crisp at every size and inherits color via `currentColor` (white inside the
// accent tile, themeable elsewhere). High-res master art lives in
// web/brand-assets/ (not shipped); the shipped 512px app icon is
// web/public/brand/turbollm-icon-512.jpeg.

interface MarkProps {
  className?: string
}

/** The bare lightning bolt (fills with currentColor). */
export function BoltMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M13.4 2.2 6.4 12.9 10.8 12.9 9.8 21.8 17.4 10.6 12.9 10.6Z" />
    </svg>
  )
}

/** The accent tile + white bolt — the square app icon, as a scalable component. */
export function IconTile({ className }: MarkProps) {
  return (
    <span
      className={className ?? 'grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]'}
      style={{ background: 'var(--accent)' }}
      aria-hidden
    >
      <BoltMark className="h-4 w-4 text-on-accent" />
    </span>
  )
}

/** Full horizontal wordmark: tile + "Turbo" (ink) + "LLM" (accent). Text colors
 *  are tokens, so it themes correctly on any panel background. */
export function Wordmark({ className }: MarkProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <IconTile />
      <span className="text-[15px] font-semibold tracking-tight">
        <span className="text-ink">Turbo</span>
        <span className="text-accent">LLM</span>
      </span>
    </span>
  )
}
