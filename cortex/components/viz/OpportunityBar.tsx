import { cn } from "@/lib/ux/cn";

type Props = {
  weightPct: number;
  masteryPct: number;
  /** heaviest weight in the set → scales bar length so importance is comparable */
  maxWeight: number;
  height?: number;
  delay?: number;
  className?: string;
};

/**
 * Dual-encoded bar: LENGTH ∝ exam weight (importance), FILL ∝ mastery.
 * Emerald = acquired, violet = still to gain. Long + violet = the best ROI.
 */
export function OpportunityBar({
  weightPct,
  masteryPct,
  maxWeight,
  height = 9,
  delay = 0,
  className,
}: Props) {
  const lengthPct = Math.max(6, (weightPct / maxWeight) * 100); // min 6% so tiny types stay visible
  const fill = Math.max(0, Math.min(100, masteryPct));
  return (
    <div
      className={cn("relative w-full rounded-full bg-surface-3/45", className)}
      style={{ height }}
      aria-hidden="true"
    >
      <div
        className="bar-reveal absolute inset-y-0 left-0 overflow-hidden rounded-full"
        style={{
          width: `${lengthPct}%`,
          background: "color-mix(in oklch, var(--color-violet) 42%, var(--color-surface-3))",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
          animationDelay: `${delay}ms`,
        }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${fill}%`,
            background: "linear-gradient(90deg, var(--color-emerald), var(--color-cyan))",
            boxShadow: fill > 0 ? "0 0 12px -2px var(--color-emerald)" : "none",
          }}
        />
      </div>
    </div>
  );
}
