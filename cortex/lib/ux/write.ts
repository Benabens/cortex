/**
 * ÉCRITURES DEPUIS L'INTERFACE — une suppression refusée doit être VUE.
 *
 * Les écrans appelaient `fetch(…, {method:"DELETE"})` sans regarder le code de
 * réponse : un 403 (cours d'un autre) ou un 500 passait pour un succès, et la
 * liste se rafraîchissait comme si l'élément avait disparu (audit de
 * pré-lancement). Cette aide lève avec le message du serveur, que l'appelant
 * affiche.
 */
export async function apiDelete(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE" });
  if (res.ok) return;
  let message = `Erreur ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body?.error === "string" && body.error) message = body.error;
  } catch {
    /* corps illisible : on garde le code HTTP */
  }
  throw new Error(message);
}
