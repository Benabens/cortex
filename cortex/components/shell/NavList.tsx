"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ux/cn";
import { NAV, isActive } from "./nav";

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
                ? "text-ink-1"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-1 focus-visible:bg-surface-2"
            )}
            style={
              active
                ? {
                    background: "color-mix(in oklch, var(--color-violet) 13%, transparent)",
                    boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--color-violet) 30%, transparent)",
                  }
                : undefined
            }
          >
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
