/**
 * IDENTITÉ D'UNE ADRESSE E-MAIL — module pur (audit fuites I8).
 *
 * Plusieurs adresses arrivent dans la même boîte : l'étiquette « +… » avant
 * l'arobase partout, et chez Gmail les points et le domaine googlemail.com.
 * `personKey` les ramène à une seule clé : ce qui est OFFERT (crédits
 * d'inscription, budget d'essai) l'est une fois par clé, pas une fois par
 * compte. Le compte garde son adresse telle quelle : la clé ne sert qu'à
 * compter et à comparer.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Clé de la boîte : minuscules, sans espaces ni étiquette « + » ; Gmail sans points, googlemail → gmail. */
export function personKey(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return address;
  let local = address.slice(0, at).replace(/\+.*$/, "");
  let domain = address.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

let disposable: Set<string> | null = null;

/**
 * Adresse d'un service d'e-mail jetable (liste vendorée, lib/disposable-domains,
 * régénérée par scripts/update-disposable-domains.sh : aucun appel réseau). Les
 * sous-domaines comptent (inbox.mailinator.com). Chargée à la première question,
 * pour ne pas alourdir les modules qui importent celui-ci sans s'en servir.
 */
export async function isDisposableEmail(email: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  if (!disposable) {
    const { DISPOSABLE_DOMAINS } = await import("@/lib/disposable-domains");
    disposable = new Set(DISPOSABLE_DOMAINS.split("\n").filter(Boolean));
  }
  const labels = address.slice(at + 1).split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    if (disposable.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
