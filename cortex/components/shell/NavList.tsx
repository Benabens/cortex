"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ux/cn";
import { NAV, isActive } from "./nav";

export function NavList({ onNavigate, items = NAV, compact = false }: {
  onNavigate?: () => void;
  items?: typeof NAV;
  compact?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={items === NAV ? "Navigation principale" : "Ressources et compte"} className={compact ? "grid grid-cols-4 gap-1" : "flex flex-col gap-1"}>
      {items.map(({ href, label, Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center rounded-xl font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-hi",
              compact ? "min-h-14 flex-col justify-center gap-1 text-[0.69rem]" : "h-11 gap-3 px-3 text-[0.9rem]",
              active
                ? "bg-violet/15 text-violet-hi"
                : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-1 focus-visible:bg-surface-2/60"
            )}
          >
            {/* barre d'accent : présente mais éteinte au repos → zéro layout shift */}
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full transition-opacity duration-150",
                active && !compact ? "bg-violet opacity-100" : "opacity-0"
              )}
            />
            <Icon
              className={cn(
                "size-[1.15rem] shrink-0 transition-colors",
                active ? "text-violet-hi" : "text-ink-3 group-hover:text-ink-2"
              )}
              strokeWidth={2}
              aria-hidden="true"
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
