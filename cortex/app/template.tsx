"use client";

/**
 * Transition de page unifiée (POLISH 2026 — P0.2) : chaque navigation remonte
 * ce template → une seule entrée douce (fade + 8 px, 220 ms, ease standard),
 * identique sur toutes les routes. Les staggers par carte ont été supprimés.
 * `prefers-reduced-motion` : l'animation est neutralisée par la règle globale.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
