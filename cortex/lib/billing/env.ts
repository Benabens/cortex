/**
 * CONTEXTE DE DÉPLOIEMENT + convention FAIL-CLOSED des garde-fous de coût.
 *
 * Principe : dans une vraie mise en ligne — multi-utilisateur
 * (`AUTH_ENABLED=1`) ou facturation (`BILLING_ENABLED=1`) — les quotas et
 * plafonds ont une VALEUR PAR DÉFAUT raisonnable même si la variable n'est pas
 * posée. Un oubli de config ne doit JAMAIS lever toutes les limites (l'audit :
 * un seul compte peut sinon brûler des dizaines de milliers de CHF/mois).
 *
 * En dev €0 nu (aucune de ces variables), aucun garde-fou ne s'active et aucun
 * fichier/table n'est créé — comportement historique intact (invariant n°1).
 *
 * Pour LEVER une limite en prod, il faut la poser explicitement à
 * `unlimited` (ou `none` / `off` / `-1`). `0` reste un kill-switch (coupe tout).
 */

export function guardsActive(): boolean {
  return process.env.AUTH_ENABLED === "1" || process.env.BILLING_ENABLED === "1";
}

const UNLIMITED = /^(unlimited|none|off|-1)$/i;

/**
 * Limite entière fail-closed :
 *  - absente → `def` si le déploiement est gardé, sinon `null` (pas de limite, dev) ;
 *  - `unlimited`/`none`/`off`/`-1` → `null` (levée EXPLICITE) ;
 *  - entier ≥ 0 → la valeur (`0` = coupe tout) ;
 *  - invalide → `def` (jamais de levée par faute de frappe).
 */
export function intLimit(name: string, def: number): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return guardsActive() ? def : null;
  if (UNLIMITED.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** Comme `intLimit`, pour un plafond réel (USD, décimales acceptées). */
export function floatLimit(name: string, def: number): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return guardsActive() ? def : null;
  if (UNLIMITED.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
