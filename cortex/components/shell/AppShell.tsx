"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CourseProvider } from "@/lib/ux/api";

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
            {children}
          </main>
        </div>
      </div>
    </CourseProvider>
  );
}
