"use client";

import { useCallback } from "react";
import { useTranslations } from "use-intl/react";
import { asText } from "@/lib/ux/api";

/**
 * Message d'échec d'un job, lisible : le sondeur (lib/ux/job-watch) pose un code quand il perd le
 * job (« jobNotFound », « jobConnectionLost ») ; seul le bandeau de l'Accueil le traduisait, les
 * autres écrans affichaient le code brut. Le reste (message du worker) passe tel quel.
 */
export function useJobError(): (error: unknown) => string | null {
  const t = useTranslations("dashboard");
  return useCallback((error: unknown) => {
    const raw = asText(error);
    return raw === "jobNotFound" || raw === "jobConnectionLost" ? t(raw) : raw;
  }, [t]);
}
