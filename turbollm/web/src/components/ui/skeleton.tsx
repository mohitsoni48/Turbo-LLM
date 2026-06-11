import { cn } from '../../lib/utils'

/** Skeleton block that matches final layout (spec 11 §8 — never spinners-in-void). */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('tllm-pulse rounded-md bg-panel-2', className)}
      {...props}
    />
  )
}
