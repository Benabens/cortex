import { cn } from "@/lib/ux/cn";
import { toneVar, type Tone } from "@/lib/ux/labels";

type Props = {
  level: 1 | 2 | 3;
  tone: Tone;
  className?: string;
};

/** 3-segment severity meter — shape + fill count carry meaning, not color alone. */
export function SeverityMeter({ level, tone, className }: Props) {
  const color = toneVar[tone];
  return (
    <div className={cn("flex items-end gap-[3px]", className)} aria-hidden="true">
      {[0, 1, 2].map((i) => {
        const on = i < level;
        return (
          <span
            key={i}
            className="w-[5px] rounded-[2px] transition-colors"
            style={{
              height: 8 + i * 5,
              background: on ? color : "var(--color-surface-3)",
              boxShadow: on ? `0 0 8px -2px ${color}` : "none",
            }}
          />
        );
      })}
    </div>
  );
}
