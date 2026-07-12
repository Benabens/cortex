import { cn } from "@/lib/ux/cn";

/** Neural node mark — three linked nodes inside a gradient tile. */
export function LogoMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="cortex-mark" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-violet)" />
          <stop offset="0.55" stopColor="var(--color-violet-hi)" />
          <stop offset="1" stopColor="var(--color-cyan)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#cortex-mark)" />
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="8.5"
        stroke="white"
        strokeOpacity="0.22"
      />
      <g stroke="white" strokeOpacity="0.92" strokeWidth="1.6" strokeLinecap="round">
        <path d="M11 21 L11 13 L20 11" />
        <path d="M11 16.5 L21 20.5" />
      </g>
      <g fill="white">
        <circle cx="11" cy="21" r="2.4" />
        <circle cx="11" cy="12.6" r="2.4" />
        <circle cx="21" cy="10.8" r="2.2" />
        <circle cx="21.4" cy="20.8" r="2.2" />
      </g>
    </svg>
  );
}

export function Wordmark({
  className,
  markSize = 30,
}: {
  className?: string;
  markSize?: number;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={markSize} />
      <span className="font-display text-[1.35rem] font-semibold leading-none tracking-tight text-ink-1">
        cortex<span className="text-violet">.</span>
      </span>
    </span>
  );
}
