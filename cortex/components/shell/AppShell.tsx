"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CourseProvider, useCourse } from "@/lib/ux/api";
import { FirstRunHero } from "@/components/dashboard/FirstRunHero";
import { LegalLine } from "@/app/compte/BillingPanel";
import type { LegalLinks } from "@/lib/legal";

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

/** Routes servies SANS la coquille de l'app (barre latérale, topbar, contexte
 *  cours) : elles s'adressent à un visiteur non connecté et portent leur propre
 *  mise en page plein écran (DA sombre de la landing). */
const BARE_ROUTES = ["/login"];

export function AppShell({ children, legal }: { children: React.ReactNode; legal?: LegalLinks }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const shellPathname = usePathname();

  // Page d'authentification : aucune coquille, aucun fetch /api/courses (401 hors session).
  if (shellPathname && BARE_ROUTES.some((p) => shellPathname === p || shellPathname.startsWith(p + "/"))) {
    return <>{children}</>;
  }

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
          <main className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-8">
            <Body>{children}</Body>
          </main>
          {legal && (
            <footer className="mx-auto w-full max-w-[1240px] px-4 pb-8 sm:px-6 lg:px-8">
              <LegalLine legal={legal} />
            </footer>
          )}
        </div>
      </div>
    </CourseProvider>
  );
}
