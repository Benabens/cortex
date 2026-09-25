import Link from "next/link";
import { Wordmark } from "./Logo";
import { CourseSelector } from "./CourseSelector";
import { NavList } from "./NavList";

/**
 * Rail gauche. Volontairement SANS footer profil/streak : le back ne fournit
 * ni profil ni série de jours — on n'affiche que ce qui est nourri (honnêteté).
 */
export function Sidebar() {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden w-rail flex-col border-r border-line lg:flex"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in oklch, var(--color-surface-1) 60%, var(--color-bg)), var(--color-bg))",
      }}
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

      <div className="mt-4 flex-1 overflow-y-auto px-3">
        <p className="px-3 pb-2 text-[0.68rem] font-medium uppercase tracking-wider text-ink-4">
          Espace de travail
        </p>
        <NavList />
      </div>
    </aside>
  );
}
