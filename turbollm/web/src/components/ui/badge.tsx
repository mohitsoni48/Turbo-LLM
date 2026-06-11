import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-panel-2 text-muted',
        accent:
          'bg-[color:color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent',
        mono: 'bg-panel-2 text-muted font-mono',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
