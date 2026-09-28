/**
 * RETOUR ARRIÈRE DEPUIS UNE PAGE EXTERNE (cache de navigation).
 *
 * Partir vers Stripe laisse volontairement l'interface verrouillée : un seul
 * départ en paiement à la fois. Mais si l'étudiant revient par « précédent », le
 * navigateur restaure la page depuis son cache — état React compris — sans
 * rejouer le moindre effet de montage : le verrou restait posé et tous les
 * boutons d'achat demeuraient inertes jusqu'à un rechargement manuel. C'est une
 * vente perdue, silencieusement.
 *
 * `pageshow` avec `persisted` est le seul signal qui distingue une restauration
 * d'un premier affichage. La cible est injectable : la condition se teste sans
 * navigateur.
 */
type EventTargetLike = Pick<Window, "addEventListener" | "removeEventListener">;

/** Appelle `cb` à chaque restauration depuis le cache de navigation. Renvoie le désabonnement. */
export function watchPageRestore(
  cb: () => void,
  target: EventTargetLike | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  if (!target) return () => {};
  const handler = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) cb();
  };
  target.addEventListener("pageshow", handler);
  return () => target.removeEventListener("pageshow", handler);
}
