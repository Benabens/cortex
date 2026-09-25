import { cn } from "@/lib/ux/cn";
import { toneText, toneVar, type Tone } from "@/lib/ux/labels";
import type { LucideIcon } from "lucide-react";

type Props = {
  tone?: Tone;
  Icon?: LucideIcon;
  children: React.ReactNode;
  size?: "xs" | "sm";
  className?: string;
  /** stronger, filled look for the single most important tag */
  emphasis?: boolean;
};

export function Badge({
  tone = "neutral",
  Icon,
  children,
  size = "sm",
  className,
  emphasis = false,
}: Props) {
  const c = toneVar[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "xs" ? "px-2 py-0.5 text-[0.68rem]" : "px-2.5 py-1 text-xs",
        toneText[tone],
        className
      )}
      style={{
        background: emphasis
          ? `color-mix(in oklch, ${c} 20%, transparent)`
          : `color-mix(in oklch, ${c} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${c} ${emphasis ? 42 : 28}%, transparent)`,
      }}
    >
      {Icon && <Icon className={size === "xs" ? "size-3" : "size-3.5"} strokeWidth={2.25} />}
      {children}
    </span>
  );
}
