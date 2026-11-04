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
        "inline-flex min-h-10 items-center gap-2 rounded-full border border-accent/20 bg-accent/8 px-3 py-2 text-xs font-medium text-accent-hi",
        "transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_40%,transparent)] hover:text-accent-hi",
        "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden={true} />
      {children}
    </a>
  );
}
