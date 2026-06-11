import { Sparkles } from 'lucide-react'

/** Placeholder screen — centered muted "Coming soon" per the design system. */
export function ComingSoon({ title, milestone }: { title: string; milestone: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Sparkles size={24} className="text-muted" />
      <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="text-[13px] text-muted">Coming soon ({milestone})</p>
    </div>
  )
}
