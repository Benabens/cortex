/**
 * Octets de fichiers RELAYÉS par le serveur, par compte et par jour (audit fuites I6). Un fichier
 * embarqué (<img>, <iframe>) ne peut pas partir du seau, la CSP (« 'self' ») bloquerait son
 * domaine : il sort par le serveur, et la sortie se paie. Sans borne, un script qui relit le même
 * fichier en boucle coûtait sans limite.
 *
 * Compté en mémoire du process (une seule instance) : un redémarrage remet à zéro, ce qui borne
 * quand même. Une redirection vers le seau (302) ne compte pas : ses octets ne passent pas ici.
 */

const MB = 1024 * 1024;
const served = new Map<string, { day: string; bytes: number }>();

/** Mo relayés par compte et par jour (FILES_SERVED_MB_PER_DAY, défaut 2048 ; « unlimited » pour lever). */
export function filesServedMbPerDay(): number | null {
  const raw = process.env.FILES_SERVED_MB_PER_DAY?.trim();
  if (raw && /^(unlimited|none|off|-1)$/i.test(raw)) return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 2048;
}

/**
 * Sert le fichier de `run` pour ce compte, ou 429 si sa part du jour est épuisée. Le fichier qui
 * fait passer la limite est encore servi : le refus vient au suivant (la taille n'est connue
 * qu'après). null (fichier absent) passe tel quel.
 */
export async function serveCounted(userId: string, run: () => Promise<Response | null>, now = Date.now()): Promise<Response | null> {
  const cap = filesServedMbPerDay();
  if (cap === null) return run();
  const day = new Date(now).toISOString().slice(0, 10);
  const seen = served.get(userId);
  const used = seen?.day === day ? seen.bytes : 0;
  if (used >= cap * MB) {
    return new Response(
      "Tu as ouvert beaucoup de fichiers aujourd'hui : la limite du jour est atteinte. Réessaie demain (remise à zéro à minuit UTC).",
      { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  const res = await run();
  if (res?.body && (res.status === 200 || res.status === 206)) {
    const bytes = Number(res.headers.get("content-length"));
    // Relu après l'attente : des requêtes parallèles s'additionnent toutes.
    const now2 = served.get(userId);
    if (Number.isFinite(bytes) && bytes > 0) served.set(userId, { day, bytes: (now2?.day === day ? now2.bytes : 0) + bytes });
  }
  return res;
}

export function resetServedBytesForTests(): void {
  served.clear();
}
