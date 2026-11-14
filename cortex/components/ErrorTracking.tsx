"use client";

import { useEffect } from "react";
import { loadClientErrorTrackingConfig, startClientErrorTracking } from "@/lib/observability-browser";

/**
 * Démarre le suivi d'erreurs du navigateur avec la configuration lue au runtime
 * (GET /api/monitoring) : la plupart des pages sont prérendues au build, sans
 * les variables de la prod. Sans SENTRY_DSN, rien n'est téléchargé.
 */
export function ErrorTracking() {
  useEffect(() => {
    void loadClientErrorTrackingConfig().then((config) => startClientErrorTracking(config));
  }, []);
  return null;
}
