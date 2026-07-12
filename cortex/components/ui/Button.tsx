import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/ux/cn";

type Variant = "primary" | "secondary" | "ghost" | "subtle";
type Size = "sm" | "md" | "lg";

const base =
  "relative inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none " +
  "rounded-md transition-[transform,background,box-shadow,border-color,color] duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2 " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary:
    "text-white font-semibold shadow-[var(--shadow-glow-violet)] " +
    "bg-[linear-gradient(180deg,var(--color-violet-deep),color-mix(in_oklch,var(--color-violet-deep)_86%,black))] " +
    "border border-[color-mix(in_oklch,var(--color-violet)_55%,transparent)] " +
    "hover:brightness-115 hover:shadow-[0_18px_52px_-12px_color-mix(in_oklch,var(--color-violet)_72%,transparent)]",
  secondary:
    "text-ink-1 bg-surface-2 border border-line-strong edge-top " +
    "hover:bg-surface-3 hover:border-[color-mix(in_oklch,var(--color-violet)_35%,transparent)]",
  ghost: "text-ink-2 border border-transparent hover:text-ink-1 hover:bg-surface-2/70",
  subtle:
    "text-ink-2 bg-white/[0.04] border border-line hover:bg-white/[0.07] hover:text-ink-1",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-[0.82rem]",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-[0.95rem]",
};

type StyleProps = {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and disables interaction. Buttons only (not links). */
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
};

type ButtonProps = StyleProps &
  React.ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type AnchorProps = StyleProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string };

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  ...rest
}: ButtonProps | AnchorProps) {
  const classes = cn(base, variants[variant], sizes[size], className);

  if ("href" in rest && typeof rest.href === "string") {
    return (
      <Link className={classes} {...(rest as AnchorProps & { href: string })}>
        {children}
      </Link>
    );
  }
  const { disabled, ...btnRest } = rest as ButtonProps;
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...btnRest}
    >
      {loading && <Loader2 className="size-4 animate-spin" strokeWidth={2.25} aria-hidden="true" />}
      {children}
    </button>
  );
}
