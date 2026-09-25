import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/ux/cn";

/** Base card surface. Use `interactive` for hoverable tiles. */
export function Panel({
  className,
  interactive = false,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "panel",
        interactive &&
          "transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)] hover:shadow-[var(--shadow-pop)]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: string;
  action?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-4", className)}>
      <div>
        <h2 className="text-[0.95rem] font-semibold text-ink-1">{title}</h2>
        {hint && <p className="mt-0.5 text-[0.8rem] text-ink-3">{hint}</p>}
      </div>
      {action && (
        <Link
          href={action.href}
          className="group -mx-2 -my-3 inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-[0.8rem] font-medium text-ink-3 transition-colors hover:text-violet-hi focus-visible:text-violet-hi"
        >
          {action.label}
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  autoFocus = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  // Track 44×24, knob 20 with an explicit 2px inset on every side:
  // off → left 2px..22px, on → translate-x-5 (20px) → 22px..42px. Always contained.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2",
        checked
          ? "bg-violet-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
          : "bg-surface-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]",
        disabled && "cursor-not-allowed opacity-45"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-transform duration-150",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-white/[0.04] px-1.5",
        "font-mono text-[0.7rem] font-medium text-ink-3",
        className
      )}
    >
      {children}
    </kbd>
  );
}
