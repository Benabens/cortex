import { cn } from "@/lib/ux/cn";

type Props = {
  /** fill percentage 0–100 */
  pct: number;
  from?: string;
  to?: string;
  height?: number;
  glow?: boolean;
  className?: string;
  delay?: number;
};

/** Slim gradient progress/weight bar with a clip-path reveal (reduced-motion safe). */
export function WeightBar({
  pct,
  from = "var(--color-violet)",
  to = "var(--color-cyan)",
  height = 8,
  glow = false,
  className,
  delay = 0,
}: Props) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-full bg-surface-3/80", className)}
      style={{ height }}
    >
      <div
        className="bar-reveal absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${clamped}%`,
          background: `linear-gradient(90deg, ${from}, ${to})`,
          boxShadow: glow
            ? `0 0 14px -2px ${to}, inset 0 1px 0 rgba(255,255,255,0.25)`
            : "inset 0 1px 0 rgba(255,255,255,0.2)",
          animationDelay: `${delay}ms`,
        }}
      />
    </div>
  );
}
