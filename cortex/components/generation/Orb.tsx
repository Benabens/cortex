"use client";

import { ThinkingOrb } from "thinking-orbs";
import type { OrbState } from "@/lib/ux/generation";

/**
 * L'ORBE DE SUIVI — thinking-orbs (MIT, Jakub Antalik) : un nuage de points qui dit ce que fait
 * le moteur (chercher, relier, écrire, vérifier, mettre en page). Encre du thème, sans teinte :
 * l'accent bleu reste à la barre. Décoratif (le texte voisin dit l'étape) : caché aux lecteurs
 * d'écran. Le paquet suit prefers-reduced-motion et s'arrête quand l'onglet est caché.
 */
export function Orb({ state, size = 32, className }: { state: OrbState; size?: 20 | 32; className?: string }) {
  return (
    <span className={className} data-orb={state} style={{ width: size, height: size, flex: "none", display: "inline-block" }}>
      <ThinkingOrb state={state} size={size} aria-hidden="true" />
    </span>
  );
}
