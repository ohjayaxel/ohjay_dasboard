import { cn } from '@/lib/utils'

import { px } from './utils'

type PillProps = {
  children: React.ReactNode
  className?: string
}

export const Pill = ({ children, className }: PillProps) => {
  const polyRoundness = 6
  const hypotenuse = polyRoundness * 2
  const hypotenuseHalf = polyRoundness / 2 - 1.5

  return (
    <div
      style={{
        '--poly-roundness': px(polyRoundness),
      } as React.CSSProperties}
      className={cn(
        'relative inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-3 font-mono text-xs uppercase tracking-[0.2em] text-foreground/60 backdrop-blur-sm [clip-path:polygon(var(--poly-roundness)_0,calc(100%_-_var(--poly-roundness))_0,100%_var(--poly-roundness),100%_calc(100%_-_var(--poly-roundness)),calc(100%_-_var(--poly-roundness))_100%,var(--poly-roundness)_100%,0_calc(100%_-_var(--poly-roundness)),0_var(--poly-roundness))]',
        className,
      )}
    >
      <span
        style={{ '--h': px(hypotenuse), '--hh': px(hypotenuseHalf) } as React.CSSProperties}
        className="absolute left-[var(--hh)] top-[var(--hh)] inline-block h-[2px] w-[var(--h)] -translate-x-1/2 -rotate-45 bg-border"
      />
      <span
        style={{ '--h': px(hypotenuse), '--hh': px(hypotenuseHalf) } as React.CSSProperties}
        className="absolute right-[var(--hh)] top-[var(--hh)] h-[2px] w-[var(--h)] translate-x-1/2 rotate-45 bg-border"
      />
      <span
        style={{ '--h': px(hypotenuse), '--hh': px(hypotenuseHalf) } as React.CSSProperties}
        className="absolute left-[var(--hh)] bottom-[var(--hh)] h-[2px] w-[var(--h)] -translate-x-1/2 rotate-45 bg-border"
      />
      <span
        style={{ '--h': px(hypotenuse), '--hh': px(hypotenuseHalf) } as React.CSSProperties}
        className="absolute right-[var(--hh)] bottom-[var(--hh)] h-[2px] w-[var(--h)] translate-x-1/2 -rotate-45 bg-border"
      />

      <span className="inline-block size-2 rounded-full bg-primary shadow-[0_0_12px_rgba(255,123,0,0.6)]" />

      {children}
    </div>
  )
}

