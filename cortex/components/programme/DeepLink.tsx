import { cn } from "@/lib/ux/cn";

/**
 * Chip de lien RÉEL vers une source (final à la bonne page, ou passage de cours). Ne jamais rendre
 * si href absent (zéro lien mort). Ouvre dans un nouvel onglet — on ne quitte pas le fil de révision.
 */
export function DeepLink({
  href,
  Icon,
  children,
  className,
}: {
  href: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2 py-1 text-[0.74rem] font-medium text-ink-2",
        "transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_40%,transparent)] hover:text-violet-hi",
        "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden={true} />
      {children}
    </a>
  );
}
