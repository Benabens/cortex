"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CourseProvider, useCourse } from "@/lib/ux/api";
import { FirstRunHero } from "@/components/dashboard/FirstRunHero";

/**
 * PREMIER LANCEMENT — un compte sans aucun cours n'a rien à voir sur les sept
 * écrans (tous scopés à un cours). Plutôt que sept états vides différents, la
 * coquille substitue ici l'invitation à créer sa matière. Seule la page de
 * création reste accessible, sinon on ne pourrait jamais en sortir.
 */
function Body({ children }: { children: React.ReactNode }) {
  const { empty } = useCourse();
  const pathname = usePathname();
  const isCreate = pathname?.startsWith("/cours");
  if (empty && !isCreate) {
    return (
      <div className="w-full max-w-[46rem]">
        <FirstRunHero />
      </div>
    );
  }
  return <>{children}</>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();

  // ⌘K / Ctrl+K → search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        router.push("/recherche");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <CourseProvider>
      <div className="relative min-h-dvh overflow-x-clip">
        <div className="aurora" aria-hidden="true" />
        <Sidebar />
        <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} />

        <div className="relative z-10 lg:pl-rail">
          <Topbar onOpenMenu={() => setMenuOpen(true)} />
          <main className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pt-8">
            <Body>{children}</Body>
          </main>
        </div>
      </div>
    </CourseProvider>
  );
}
