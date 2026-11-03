import Link from "next/link";
import { Wordmark } from "./Logo";
import { CourseSelector } from "./CourseSelector";
import { NavList } from "./NavList";

import { SECONDARY_NAV } from "./nav";

export function Sidebar() {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden w-rail flex-col border-r border-line bg-surface-1 lg:flex"
    >
      <div className="flex h-16 items-center px-5">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-md focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2"
        >
          <Wordmark />
        </Link>
      </div>

      <div className="px-3">
        <CourseSelector />
        <Link
          href="/cours"
          className="mt-1.5 inline-flex min-h-9 items-center rounded px-2 text-[0.72rem] text-ink-4 transition-colors hover:text-violet-hi focus-visible:text-violet-hi"
        >
          Gérer mes cours
        </Link>
      </div>

      {/* Plus d'intitulé « Espace de travail » : la position de la nav suffit (anti-slop 2026-09). */}
      <div className="mt-5 flex-1 overflow-y-auto px-3">
        <NavList />
      </div>
      <div className="border-t border-line p-3">
        <NavList items={SECONDARY_NAV} />
      </div>
    </aside>
  );
}
