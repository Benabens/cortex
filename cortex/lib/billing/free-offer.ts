import { createHash } from "node:crypto";
import { authTx } from "@/db/auth-store";
import { dbDriverName } from "@/db/q";
import { isDisposableEmail, personKey } from "@/lib/email-identity";

/**
 * OFFRE GRATUITE UNE FOIS PAR PERSONNE (audit fuites I8). Règle de Ben : un compte
 * qui ne paie pas ne coûte rien. Ce qui coûte de l'IA sans être payé — crédits
 * d'inscription (SIGNUP_FREE_CREDITS), budget d'essai (AI_BUDGET_FREE_USD) — ne
 * va donc qu'à UN compte par boîte e-mail (lib/email-identity, personKey) : un
 * alias Gmail, un « +étiquette », un compte supprimé puis recréé ne relancent pas
 * l'offre. Le premier compte qui la réclame la détient, pour toujours.
 *
 * Refusée aussi : adresse jetable (même si le compte existe d'avant le refus à
 * l'inscription), et au-delà de FREE_OFFERS_PER_IP_DAY offres (3) attribuées
 * depuis la même IP en 24 h — seulement derrière TRUST_PROXY, comme les autres
 * limites par IP (lib/client-ip). Le compte, lui, reste ouvert : il paie ce
 * qu'il consomme, comme tout le monde.
 *
 * Table `free_offers` : boîte et IP HACHÉES (IP effacée après 2 jours), boîte gardée après la suppression du
 * compte (sinon supprimer puis recréer rouvrirait l'offre). Compte sans adresse
 * (poste de dev mono-utilisateur, ids de test) : sa propre clé, comme avant.
 */

export type FreeOfferVerdict =
  | { ok: true }
  | { ok: false; reason: "same_person" | "disposable" | "ip_day" };

const DAY_MS = 24 * 60 * 60_000;
const hash = (kind: string, value: string) => createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 32);
const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function perIpDay(): number | null {
  const raw = process.env.FREE_OFFERS_PER_IP_DAY?.trim();
  if (!raw) return 3;
  if (/^(unlimited|none|off|-1)$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

/** Verdicts définitifs (détenteur ou non) : la question ne se repose plus dans ce process. */
const settled = new Map<string, FreeOfferVerdict>();

/** (tests) oublie les verdicts mémorisés. */
export function resetFreeOfferCache(): void {
  settled.clear();
}

/**
 * Ce compte peut-il recevoir l'offre gratuite ? Réclame la place de sa personne si
 * elle est libre (écrite en base), sinon dit pourquoi non. `ip` vient de clientIp().
 */
export async function claimFreeOffer(userId: string, opts: { ip?: string; now?: number } = {}): Promise<FreeOfferVerdict> {
  const known = settled.get(userId);
  if (known) return known;
  const now = opts.now ?? Date.now();
  const ipKey = opts.ip && opts.ip !== "direct" ? hash("ip", opts.ip) : null;
  const limit = perIpDay();

  const verdict = await authTx(async (tx): Promise<FreeOfferVerdict> => {
    // Deux comptes de la même personne qui réclament en même temps : un seul gagne.
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, "free-offers");
    const me = await tx.get<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId);
    const email = me?.email?.trim() ?? "";
    if (email && (await isDisposableEmail(email))) return { ok: false, reason: "disposable" };
    const person = email ? personKey(email) : `user:${userId}`;
    const personHash = hash("person", person);

    const holder = await tx.get<{ user_id: string }>(`SELECT user_id FROM free_offers WHERE person_key = ?`, personHash);
    if (holder) return holder.user_id === userId ? { ok: true } : { ok: false, reason: "same_person" };

    // Offre reçue AVANT cette table : un autre compte de la même boîte a déjà son crédit
    // d'inscription. Il devient le détenteur ; celui-ci n'aura rien.
    if (email) {
      const domain = person.slice(person.lastIndexOf("@") + 1);
      const domains = domain === "gmail.com" ? ["gmail.com", "googlemail.com"] : [domain];
      const others: Array<{ id: string; email: string }> = [];
      for (const d of domains) {
        others.push(...await tx.all<{ id: string; email: string }>(
          `SELECT id, email FROM users WHERE id <> ? AND lower(email) LIKE ?`, userId, `%@${d}`,
        ));
      }
      for (const o of others.filter((o) => personKey(o.email) === person)) {
        if (await tx.get(`SELECT id FROM credit_transactions WHERE ref = ?`, `signup:${o.id}`)) {
          await tx.run(`INSERT INTO free_offers (person_key, user_id, ip_key, created_at) VALUES (?, ?, NULL, ?)`, personHash, o.id, at(now));
          return { ok: false, reason: "same_person" };
        }
      }
    }

    if (ipKey && limit !== null) {
      const n = Number((await tx.get<{ n: number }>(
        `SELECT count(*) n FROM free_offers WHERE ip_key = ? AND created_at > ?`, ipKey, at(now - DAY_MS),
      ))?.n ?? 0);
      if (n >= limit) return { ok: false, reason: "ip_day" };
    }
    // Minimisation : l'IP ne sert qu'à la fenêtre de 24 h, on ne la garde pas au-delà de 2 jours.
    await tx.run(`UPDATE free_offers SET ip_key = NULL WHERE ip_key IS NOT NULL AND created_at < ?`, at(now - 2 * DAY_MS));
    await tx.run(`INSERT INTO free_offers (person_key, user_id, ip_key, created_at) VALUES (?, ?, ?, ?)`, personHash, userId, ipKey, at(now));
    return { ok: true };
  });

  if (verdict.ok || verdict.reason !== "ip_day") settled.set(userId, verdict);
  return verdict;
}
