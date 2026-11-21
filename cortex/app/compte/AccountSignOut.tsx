"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { useTranslations } from "use-intl/react";

/** Déconnexion directe (pas la page NextAuth par défaut) — sous "Connecté en tant que". */
export function AccountSignOut() {
  const t = useTranslations("account");
  return (
    <Button variant="secondary" size="sm" className="mt-4" onClick={() => signOut({ callbackUrl: "/login" })}>
      {t("signOut")}
    </Button>
  );
}
