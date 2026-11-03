"use client";

import Link from "next/link";
import { Search, ChevronDown, CalendarClock, UserRound } from "lucide-react";
import { HeaderSearch } from "./HeaderSearch";
import { Wordmark } from "./Logo";

import { useApi, useCourse } from "@/lib/ux/api";

type DashCountdown = { countdown: { date: string; days: number } | null };

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  // Compte à rebours RÉEL (même requête que l'Accueil : dédupliquée par le cache).
  // Masqué si absent ou si l'examen est déjà passé (days < 0).
  const { data } = useApi<DashCountdown>("/api/dashboard");
  const { course } = useCourse();
  const days = data?.countdown?.days;
  const showCountdown = typeof days === "number" && days >= 0;

  return (
    <header className="glass sticky top-0 z-20 border-b border-line">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Mobile brand */}
        <Link
          href="/"
          className="mr-1 flex items-center lg:hidden"
          aria-label="Cortex : accueil"
        >
          <Wordmark markSize={23} />
        </Link>

        <HeaderSearch />

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

          <Link
            href="/compte"
            aria-label="Mon compte"
            className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1"
          >
            <UserRound className="size-[1.15rem]" strokeWidth={2} />
          </Link>

          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Changer de cours ou ouvrir les ressources"
            className="order-first flex min-h-11 min-w-0 items-center gap-1 rounded-full border border-line bg-surface-2/50 px-2 text-xs text-ink-2 hover:bg-surface-2 lg:hidden"
          >
            <span className="max-w-20 truncate">{course?.short || "Cours"}</span>
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
