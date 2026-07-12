import { cn } from "@/lib/ux/cn";

type Props = {
  total: number;
  filled: number;
  columns?: number;
  label: string;
  className?: string;
};

/**
 * Coverage as a dot grid — a deliberately different form from the radial gauge
 * so the metric cluster reads as "signed data-viz", not a template of rings.
 */
export function WaffleGrid({ total, filled, columns = 9, label, className }: Props) {
  const dots = Array.from({ length: total });
  const rows = Math.ceil(total / columns);

  return (
    <div
      className={cn("w-full", className)}
      role="img"
      aria-label={`${label} : ${filled} sur ${total}`}
    >
      <div
        className="grid w-full gap-[7px]"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {dots.map((_, i) => {
          const col = i % columns;
          const isFilled = i < filled;
          const mix = columns > 1 ? col / (columns - 1) : 0;
          return (
            <span
              key={i}
              className={cn(
                "aspect-square rounded-[4px]",
                isFilled ? "waffle-dot" : "bg-surface-3/70 ring-1 ring-inset ring-line-soft"
              )}
              style={
                isFilled
                  ? {
                      background: `color-mix(in oklch, var(--color-emerald) ${Math.round(
                        100 - mix * 55
                      )}%, var(--color-cyan))`,
                      boxShadow:
                        "0 0 0 1px color-mix(in oklch, var(--color-emerald) 30%, transparent), 0 2px 8px -2px color-mix(in oklch, var(--color-emerald) 45%, transparent)",
                      animationDelay: `${i * 16}ms`,
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
      <span className="sr-only">
        {rows} rangées, {filled} points remplis.
      </span>
    </div>
  );
}
