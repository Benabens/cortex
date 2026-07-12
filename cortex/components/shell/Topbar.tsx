"use client";

import Link from "next/link";
import { Search, Menu, CalendarClock } from "lucide-react";
import { Wordmark } from "./Logo";
import { Kbd } from "@/components/ui/primitives";
import { useApi } from "@/lib/ux/api";

type DashCountdown = { countdown: { date: string; days: number } | null };

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  // Compte à rebours RÉEL (même requête que l'Accueil : dédupliquée par le cache).
  // Masqué si absent ou si l'examen est déjà passé (days < 0).
  const { data } = useApi<DashCountdown>("/api/dashboard");
  const days = data?.countdown?.days;
  const showCountdown = typeof days === "number" && days >= 0;

  return (
    <header className="glass sticky top-0 z-20 border-b border-line">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Mobile brand */}
        <Link
          href="/"
          className="mr-1 flex items-center lg:hidden"
          aria-label="Cortex — accueil"
        >
          <Wordmark markSize={26} />
        </Link>

        {/* Search / command trigger */}
        <Link
          href="/recherche"
          className="group hidden h-10 max-w-[420px] flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface-2/50 px-3 text-ink-3 transition-colors hover:border-line-strong hover:bg-surface-2 sm:flex"
          aria-label="Rechercher — ouvrir la recherche"
        >
          <Search className="size-4 shrink-0" strokeWidth={2} />
          <span className="flex-1 truncate text-[0.85rem]">
            Rechercher un cours, une série, un final…
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Link>

        <div className="flex-1 sm:hidden" />

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-2">
          {showCountdown && (
            <span
              className="hidden items-center gap-2 rounded-full border border-line bg-surface-2/50 px-3 py-1.5 text-[0.78rem] md:inline-flex"
              title="Prochain examen"
            >
              <CalendarClock className="size-3.5 text-cyan-hi" strokeWidth={2.25} />
              <span className="text-ink-3">Final dans</span>
              <span className="font-data font-semibold text-ink-1">{days} j</span>
            </span>
          )}

          <Link
            href="/recherche"
            aria-label="Rechercher"
            className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 sm:hidden"
          >
            <Search className="size-[1.15rem]" strokeWidth={2} />
          </Link>

          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Ouvrir le menu"
            className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 lg:hidden"
          >
            <Menu className="size-[1.15rem]" strokeWidth={2} />
          </button>
        </div>
      </div>
    </header>
  );
}
