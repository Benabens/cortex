/**
 * Clé de comptage d'un client pour les limites de débit (proxy, connexion relecteur).
 *
 * Les en-têtes `x-forwarded-for` / `x-real-ip` sont écrits par le CLIENT et
 * seulement complétés par le proxy : leur faire confiance sans savoir combien
 * de proxys nous précèdent rend la limite inutile (il suffit de varier
 * l'en-tête). On n'accepte donc XFF que derrière un proxy déclaré, en prenant
 * le N-ième élément EN PARTANT DE LA FIN, où N = TRUST_PROXY (nombre de hops
 * de confiance ; « 1 » = un proxy, cas Railway). Sans TRUST_PROXY : on ignore
 * totalement les en-têtes et tout le monde partage la clé « direct », quitte à
 * regrouper — mieux vaut une limite grossière qu'une limite contournable d'un
 * `curl -H`.
 */
export function clientIp(headers: Pick<Headers, "get">, env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const hops = Number(env.TRUST_PROXY);
  if (Number.isFinite(hops) && hops >= 1) {
    const parts = (headers.get("x-forwarded-for") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    // Le proxy le plus proche de nous ajoute en dernier : on remonte de `hops`.
    if (parts.length) return parts[Math.max(0, parts.length - hops)];
  }
  return "direct";
}

/** IP de la requête en cours (TRUST_PROXY) ; hors requête (tests, scripts, worker) : « direct », jamais bornée. */
export async function requestIp(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    return clientIp(await headers());
  } catch {
    return "direct";
  }
}
