"use client";

import { useEffect } from "react";
import { signOut } from "next-auth/react";
import { Wordmark } from "@/components/shell/Logo";
import { useTranslations } from "use-intl/react";

/**
 * Repli de `pages.signOut` (lib/auth) : atteint seulement si quelque chose navigue
 * directement vers /api/auth/signout (lien externe, favori) au lieu d'appeler `signOut()`
 * côté client comme le fait le reste de l'app. Termine la déconnexion elle-même — arriver
 * ici ne clôt pas la session, seul l'appel `signOut()` ci-dessous le fait — puis revient à /login.
 */
export function SignOutCard() {
  const t = useTranslations("signout");

  useEffect(() => {
    void signOut({ callbackUrl: "/login" });
  }, []);

  return (
    <main
      style={{ background: "var(--bare-bg)", color: "var(--bare-ink)" }}
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="d2-card w-full max-w-[28rem] p-6 sm:p-9 text-center">
        <div className="flex justify-center">
          <Wordmark markSize={30} />
        </div>
        <h1 className="mt-8 text-[1.8rem] font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-[0.88rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
          {t("description")}
        </p>
      </div>
    </main>
  );
}
