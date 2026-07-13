"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ux/cn";
import { NAV, isActive } from "./nav";

/**
 * Nav verticale — état actif SOBRE (POLISH 2026, P0.1) :
 * surface remplie discrète + barre d'accent 2 px à gauche + label ink-1.
 * Aucun halo, aucun ring violet. Hover = fond léger 150 ms.
 * Le focus clavier reste l'anneau net global (:focus-visible).
 */
export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex h-11 items-center gap-3 rounded-md px-3 text-[0.9rem] font-medium transition-colors duration-150",
              active
                ? "bg-surface-2 text-ink-1"
                : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-1 focus-visible:bg-surface-2/60"
            )}
          >
            {/* barre d'accent : présente mais éteinte au repos → zéro layout shift */}
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full transition-opacity duration-150",
                active ? "bg-violet opacity-100" : "opacity-0"
              )}
            />
            <Icon
              className={cn(
                "size-[1.15rem] shrink-0 transition-colors",
                active ? "text-violet-hi" : "text-ink-3 group-hover:text-ink-2"
              )}
              strokeWidth={2}
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
