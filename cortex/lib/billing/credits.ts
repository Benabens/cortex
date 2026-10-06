import { rechargeDue, standingOf } from "./subscription-windows";
import { currentUser } from "@/db/context";
import { authAll, authGet, authRun, authSqlite } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { log } from "@/lib/metrics";

/**
 * CRÉDITS (modèle payant).
 *
 * Source de vérité UNIQUE : la table globale `credit_transactions` (store auth)
 * — le solde d'un user = SUM(delta). Pas de table de solde séparée à
 * désynchroniser. Idempotence STRUCTURELLE : chaque opération porte un `ref`
 * UNIQUE (`stripe:cs:<session>`, `signup:<user>`, `job:<user>:<cours>:<id>`…) —
 * rejouer l'opération (double webhook, retry) ne crée jamais de doublon.
 *
 * UNITÉ : `delta` est en CENTIÈMES DE CRÉDIT (1 crédit = 100). L'assistance
 * (drill, correction, analyses) coûte une fraction de crédit : sans unité
 * fine, elle était gratuite et un compte à 2 crédits offerts pouvait appeler
 * le modèle 40 fois par jour indéfiniment. Les bases antérieures (deltas en
 * crédits entiers) sont converties ×100 UNE fois, atomiquement, au premier
 * accès (`ensureLedgerUnit`, marqueur `app_meta.credits_unit = centi`) : les
 * soldes affichés ne bougent pas. Tout ce qui sort de ce module vers
 * l'interface ou Stripe est en crédits (`fromCenti`) ; tout ce qui entre dans
 * le ledger est en centièmes.
 *
 * BILLING_ENABLED=1 : active le débit/le gate. Non posé → tout est no-op
 * (dev €0 et staging sans Stripe : comportement historique intact).
 *
 * Palier gratuit : SIGNUP_FREE_CREDITS (défaut 2) offerts UNE fois par user
 * (ref signup:<user>), crédités paresseusement au premier passage billing.
 */

export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "1";
}

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** 1 crédit = 100 centièmes (unité du ledger). */
export const CENTI = 100;
export function toCenti(credits: number): number {
  return Math.max(0, Math.round(credits * CENTI));
}
export function fromCenti(centi: number): number {
  return Math.round(centi) / CENTI;
}
/** Affichage : « 2 », « 1,9 », « 0,1 » crédit(s). */
export function fmtCredits(centi: number): string {
  return fromCenti(centi).toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
}

/** Coût EN CRÉDITS par type de génération. Surcharge : CREDITS_COST_JSON (décimales acceptées). */
const DEFAULT_COSTS: Record<string, number> = {
  exam: 2,
  qcm: 1,
  exercise: 1,
  "lab-exercise": 1,
  blueprint: 1,
  format: 1,
  prepare: 2,
  // Appels LLM courts et interactifs (drill, vérification de solution, analyse
  // de faiblesse) : un dixième de crédit. Gratuits, ils offraient ~40 appels
  // payants par jour et par compte, indéfiniment (audit B5).
  assist: 0.1,
};

/** Coût en CENTIÈMES de crédit d'un type de génération. */
export function creditCost(kind: string): number {
  try {
    const raw = process.env.CREDITS_COST_JSON;
    if (raw) {
      const map = JSON.parse(raw) as Record<string, number>;
      if (typeof map[kind] === "number") return toCenti(map[kind]);
    }
  } catch { /* JSON invalide → défauts */ }
  return toCenti(DEFAULT_COSTS[kind] ?? 1);
}

// ─────────────────────────── unité du ledger ───────────────────────────

const UNIT_KEY = "credits_unit";
let _unitChecked = false;

/**
 * `delta` NORMALISÉ en centièmes, quelle que soit l'unité d'écriture de la
 * ligne : 'centi' (ce code) ou NULL (crédits entiers : ancien code pendant un
 * déploiement glissant, base héritée). Toute lecture du ledger passe par là —
 * le solde ne dépend jamais de l'avancement de la conversion.
 */
export const DELTA_CENTI = `CASE WHEN unit = 'centi' THEN delta ELSE delta * ${CENTI} END`;

/**
 * Convertit en centièmes les lignes encore en crédits entiers (`unit IS NULL`).
 * PAR LIGNE et idempotent : deux instances qui démarrent ensemble ne
 * convertissent jamais deux fois la même ligne (chaque UPDATE ne touche que
 * les lignes sans unité et pose l'unité dans le même ordre SQL) ; une ligne
 * écrite par l'ancien code APRÈS la migration est rattrapée au passage
 * suivant — et lue juste entre-temps grâce à DELTA_CENTI. Le marqueur
 * `app_meta.credits_unit` reste posé pour information ; `_unitChecked` n'est
 * qu'une économie de requêtes : aucune lecture n'en dépend, donc une
 * conversion annulée par une transaction englobante (sqlite : SAVEPOINT) est
 * sans conséquence.
 */
export async function ensureLedgerUnit(): Promise<void> {
  if (_unitChecked) return;
  if (dbDriverName() === "sqlite") {
    const db = authSqlite();
    if (!db) return;
    db.transaction(() => {
      db.prepare(`UPDATE credit_transactions SET delta = delta * ${CENTI}, unit = 'centi' WHERE unit IS NULL`).run();
      db.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)`).run(UNIT_KEY, "centi");
    })();
  } else {
    await authRun(`UPDATE credit_transactions SET delta = delta * ${CENTI}, unit = 'centi' WHERE unit IS NULL`);
    await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, UNIT_KEY, "centi");
  }
  _unitChecked = true;
}

/** (tests) force une nouvelle vérification de l'unité. */
export function resetLedgerUnitCheck(): void {
  _unitChecked = false;
}

/**
 * Référence d'un job pour le débit/remboursement. DOIT inclure l'UTILISATEUR :
 * en Postgres, chaque tenant a sa propre séquence d'ids de jobs — deux users
 * ont tous les deux un job #1 sur le même cours. Une ref sans user ferait
 * (a) sauter le débit du 2ᵉ user (ref déjà vue = idempotence détournée) et
 * (b) rembourser le mauvais compte. Source UNIQUE, utilisée par
 * createJobExclusive, le remboursement d'échec et l'annulation.
 */
export function jobRef(userId: string, course: string, jobId: number): string {
  return `job:${userId}:${course}:${jobId}`;
}

/** Écrit une transaction idempotente (ref UNIQUE), `deltaCenti` en centièmes. true = écrite, false = déjà vue. */
export async function addTransaction(
  userId: string, deltaCenti: number, reason: string, ref?: string,
): Promise<boolean> {
  await ensureLedgerUnit();
  const delta = Math.round(deltaCenti);
  if (ref) {
    const seen = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref);
    if (seen) return false;
  }
  try {
    await authRun(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
      userId, delta, reason, ref ?? null, nowStr(),
    );
    return true;
  } catch (e) {
    // Course sur le ref UNIQUE (double webhook simultané) → l'un des deux perd : idempotent.
    if (ref && /unique|constraint/i.test(String(e))) return false;
    throw e;
  }
}

/** Palier gratuit à l'inscription — crédité UNE fois (idempotent par ref). */
const signupSeen = new Set<string>();
export async function ensureSignupCredits(userId: string): Promise<void> {
  if (!billingEnabled() || signupSeen.has(userId)) return;
  const free = toCenti(envNum("SIGNUP_FREE_CREDITS", 2));
  if (free > 0) await addTransaction(userId, free, "signup", `signup:${userId}`);
  signupSeen.add(userId);
}

/** Poche ACHETÉE (packs, palier gratuit, reprises) en centièmes : la somme du ledger. */
export async function purchasedBalanceCenti(userId = currentUser()): Promise<number> {
  await ensureLedgerUnit();
  await ensureSignupCredits(userId);
  const r = await authGet<{ total: number | null }>(
    `SELECT coalesce(sum(${DELTA_CENTI}), 0) total FROM credit_transactions WHERE user_id = ?`, userId,
  );
  return Number(r?.total ?? 0);
}

/** Solde TOTAL en CENTIÈMES (achetés + abonnement du mois) — unité des gates. */
export async function getBalanceCenti(userId = currentUser()): Promise<number> {
  return (await purchasedBalanceCenti(userId)) + (await subscriptionCreditsCenti(userId));
}

/** Solde en CRÉDITS (affichage, API). */
export async function getBalance(userId = currentUser()): Promise<number> {
  return fromCenti(await getBalanceCenti(userId));
}

// ─────────────────────────── abonnement Pro ───────────────────────────
/**
 * DEUX POCHES : les crédits ACHETÉS (ledger, permanents) et les crédits
 * d'ABONNEMENT (`subscriptions.remaining`) : le MENSUEL les reçoit d'une
 * facture payée, pour sa période de facturation ; l'ANNUEL les reçoit par
 * fenêtres mensuelles ancrées sur le début de sa période (recharge paresseuse
 * par fenêtre, cf. lib/billing/subscription-windows), jamais reportés. Après
 * reprise d'une facture (remboursement, litige) l'abonnement est SUSPENDU
 * jusqu'à la prochaine facture payée. Un débit consomme l'abonnement d'abord
 * (sinon il expirerait inutilisé), DANS la transaction de réservation
 * (lib/billing/reserve : `spendInTx`). Tout est en centièmes.
 *
 * PAS DE PAIEMENT, PAS DE CRÉDITS D'ABONNEMENT. La période (`period_start`,
 * `period_end`) est celle de la dernière facture PAYÉE : un renouvellement que
 * Stripe annonce sans l'avoir encaissé n'ouvre rien, et un abonnement qui n'est
 * plus en règle (retard de paiement, impayé) ne donne aucun crédit. Les mois
 * non payés ne sont pas rattrapés : la facture suivante remet le mois à 20.
 * La poche achetée, elle, ne dépend jamais de l'état de l'abonnement.
 */
export type SubRow = {
  user_id: string; customer_id: string | null; subscription_id: string | null;
  status: string; plan: string | null; monthly_credits: number; remaining: number;
  period_end: string | null; month_anchor: string | null;
  period_start: string | null; window_anchor: string | null; suspended: number | boolean | null;
  status_at: string | null; cancel_at_period_end: number | boolean | null;
  updated_at: string;
};

/**
 * ORDRE DES ÉVÉNEMENTS. Stripe ne garantit pas l'ordre de livraison et rejoue
 * pendant trois jours un événement dont la livraison a échoué. Le statut d'une
 * ligne suit donc l'événement le plus RÉCENT (sa date de création chez Stripe,
 * gardée dans `status_at`), pas le dernier arrivé : un « past_due » rejoué
 * après le paiement ne rétrograde pas l'abonné qui a payé.
 */
const NEWER = `(status_at IS NULL OR status_at <= ?)`;
/** Remise en règle par un événement daté (facture payée, checkout) — sans effet s'il est plus ancien que le statut connu. */
const ACTIVATE_IF_NEWER = `status = CASE WHEN ${NEWER} THEN 'active' ELSE status END,
        cancel_at_period_end = CASE WHEN ${NEWER} THEN 0 ELSE cancel_at_period_end END,
        status_at = CASE WHEN ${NEWER} THEN ? ELSE status_at END`;
const activateParams = (at: string) => [at, at, at, at];

/** Crédits Pro accordés chaque mois, en centièmes (SUBSCRIPTION_MONTHLY_CREDITS, en crédits, défaut 20). */
export function subscriptionMonthlyCreditsCenti(): number {
  return toCenti(envNum("SUBSCRIPTION_MONTHLY_CREDITS", 20));
}

export async function getSubscription(userId = currentUser()): Promise<SubRow | undefined> {
  return authGet<SubRow>(`SELECT * FROM subscriptions WHERE user_id = ?`, userId);
}

export async function resolveUserByCustomer(customerId: string): Promise<string | null> {
  const r = await authGet<{ user_id: string }>(`SELECT user_id FROM subscriptions WHERE customer_id = ?`, customerId);
  return r?.user_id ?? null;
}

/** L'abonnement fournit-il des crédits en ce moment ? (période PAYÉE en cours, en règle, non suspendu). */
export function subscriptionLive(s: SubRow | undefined, now = nowStr()): boolean {
  return standingOf(s, now) === "live";
}

/**
 * Crédits d'abonnement utilisables maintenant (centièmes). Annuel : recharge
 * PARESSEUSE à l'ouverture d'une nouvelle fenêtre mensuelle (persistée : une
 * seule fois par fenêtre). Mensuel : jamais — seule une facture payée crédite.
 */
export async function subscriptionCreditsCenti(userId = currentUser()): Promise<number> {
  const s = await getSubscription(userId);
  if (!subscriptionLive(s)) return 0;
  const now = nowStr();
  const win = rechargeDue(s!, now);
  if (win) {
    await authRun(
      `UPDATE subscriptions SET remaining = monthly_credits, window_anchor = ?, month_anchor = ?, updated_at = ? WHERE user_id = ? AND coalesce(window_anchor, '') < ?`,
      win, win.slice(0, 7), now, userId, win,
    );
    return Number(s!.monthly_credits) || 0;
  }
  return Math.max(0, Number(s!.remaining) || 0);
}

/** Même chose en crédits (affichage). */
export async function subscriptionCredits(userId = currentUser()): Promise<number> {
  return fromCenti(await subscriptionCreditsCenti(userId));
}

/**
 * Attribution par FACTURE PAYÉE (invoice.paid) — la SEULE écriture de la
 * période payée : `remaining` REMIS à `monthly_credits` (reliquat perdu, jamais
 * additionné), période [periodStart, periodEnd), première fenêtre ouverte à
 * periodStart, suspension levée. `at` : date de l'événement chez Stripe.
 * Upsert par utilisateur. Renvoie false, sans rien écrire, si la facture
 * couvre une période antérieure à celle déjà payée.
 */
export async function grantSubscriptionMonth(p: {
  userId: string; customerId?: string | null; subscriptionId?: string | null; plan?: string | null;
  periodEnd: string; periodStart?: string | null; at?: string | null;
}): Promise<boolean> {
  const credits = subscriptionMonthlyCreditsCenti();
  const now = nowStr();
  const at = p.at ?? now;
  const start = p.periodStart ?? now;
  const month = start.slice(0, 7);
  const existing = await getSubscription(p.userId);
  // La période payée ne RECULE jamais : une facture plus ancienne réglée après
  // une plus récente (rattrapage d'impayés, événements livrés dans le désordre)
  // remettrait l'abonné sur un mois déjà écoulé, donc à 0 alors qu'il vient de payer.
  if (existing?.period_start && start < existing.period_start) return false;
  if (existing) {
    await authRun(
      `UPDATE subscriptions SET customer_id = coalesce(?, customer_id), subscription_id = coalesce(?, subscription_id),
        ${ACTIVATE_IF_NEWER}, plan = coalesce(?, plan), monthly_credits = ?, remaining = ?, period_start = ?, period_end = ?,
        window_anchor = ?, month_anchor = ?, suspended = 0, updated_at = ?
       WHERE user_id = ? AND (period_start IS NULL OR period_start <= ?)`,
      p.customerId ?? null, p.subscriptionId ?? null, ...activateParams(at), p.plan ?? null, credits, credits, start, p.periodEnd, start, month, now, p.userId, start,
    );
  } else {
    await authRun(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, status_at, plan, monthly_credits, remaining, period_start, period_end, window_anchor, month_anchor, suspended, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      p.userId, p.customerId ?? null, p.subscriptionId ?? null, "active", at, p.plan ?? null, credits, credits, start, p.periodEnd, start, month, now,
    );
  }
  return true;
}

/** Reprise d'une facture d'abonnement (remboursement, litige) : SUSPENDU jusqu'à la prochaine facture payée. */
export async function suspendSubscription(userId: string): Promise<void> {
  await authRun(`UPDATE subscriptions SET remaining = 0, suspended = 1, updated_at = ? WHERE user_id = ?`, nowStr(), userId);
}

/** Lie client Stripe → utilisateur (checkout abonnement) SANS attribuer : c'est invoice.paid qui attribue. */
export async function linkSubscription(p: {
  userId: string; customerId?: string | null; subscriptionId?: string | null; plan?: string | null; at?: string | null;
}): Promise<void> {
  const now = nowStr();
  const at = p.at ?? now;
  if (await getSubscription(p.userId)) {
    await authRun(
      `UPDATE subscriptions SET customer_id = coalesce(?, customer_id), subscription_id = coalesce(?, subscription_id),
        ${ACTIVATE_IF_NEWER}, plan = coalesce(?, plan), updated_at = ? WHERE user_id = ?`,
      p.customerId ?? null, p.subscriptionId ?? null, ...activateParams(at), p.plan ?? null, now, p.userId,
    );
  } else {
    await authRun(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, status_at, plan, monthly_credits, remaining, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      p.userId, p.customerId ?? null, p.subscriptionId ?? null, "active", at, p.plan ?? null, subscriptionMonthlyCreditsCenti(), 0, now,
    );
  }
}

/**
 * Statut d'un abonnement (updated/deleted), daté par son événement (`at`) : un
 * événement plus ancien que le statut connu est ignoré EN ENTIER. Ne touche
 * jamais la période payée. `clearRemaining` (fin) remet le mois à 0.
 */
export async function setSubscriptionStatus(p: {
  userId?: string | null; customerId?: string | null; subscriptionId?: string | null;
  status: string; at?: string | null; cancelAtPeriodEnd?: boolean; clearRemaining?: boolean;
}): Promise<string | null> {
  let userId = p.userId ?? null;
  if (!userId && p.customerId) userId = await resolveUserByCustomer(p.customerId);
  if (!userId && p.subscriptionId) {
    const r = await authGet<{ user_id: string }>(`SELECT user_id FROM subscriptions WHERE subscription_id = ?`, p.subscriptionId);
    userId = r?.user_id ?? null;
  }
  if (!userId) return null;
  const now = nowStr();
  const at = p.at ?? now;
  await authRun(
    `UPDATE subscriptions SET status = ?, status_at = ?, cancel_at_period_end = coalesce(?, cancel_at_period_end), ${p.clearRemaining ? "remaining = 0, " : ""}updated_at = ?
     WHERE user_id = ? AND ${NEWER}`,
    p.status, at, p.cancelAtPeriodEnd === undefined ? null : Number(p.cancelAtPeriodEnd), now, userId, at,
  );
  return userId;
}

/**
 * Gate de solde AVANT une génération par job : null = passe, sinon
 * {status: 402, error claire}. `kind` inconnu au moment du preflight → on
 * exige le coût MINIMUM d'une génération (1 crédit).
 */
export async function creditsGate(kind?: string, costCenti?: number): Promise<{ status: number; error: string } | null> {
  if (!billingEnabled()) return null;
  const cost = costCenti ?? (kind ? creditCost(kind) : CENTI);
  const balance = await getBalanceCenti();
  return insufficient(balance, cost);
}

/** Verdict de solde (partagé avec la réservation atomique) : null = passe. */
export function insufficient(balanceCenti: number, costCenti: number, subCenti = 0): { status: number; error: string } | null {
  // Un coût nul exige tout de même un solde positif : sinon un compte à sec —
  // ou passé en négatif par un remboursement Stripe — continuerait d'appeler le modèle.
  if (costCenti === 0) {
    return balanceCenti > 0 ? null : {
      status: 402,
      error: "Solde épuisé. Recharge tes crédits dans Mon compte → Abonnement & crédits pour continuer à utiliser l'assistance.",
    };
  }
  if (balanceCenti < costCenti) {
    const dont = subCenti > 0 ? ` (dont ${fmtCredits(subCenti)} d'abonnement ce mois-ci)` : "";
    return {
      status: 402,
      error: `Solde insuffisant : ${fmtCredits(balanceCenti)} crédit(s)${dont}, génération à ${fmtCredits(costCenti)}. Recharge tes crédits dans Mon compte → Abonnement & crédits.`,
    };
  }
  return null;
}

/**
 * Rembourse une génération qui n'a rien produit (idempotent : ref refund:<ref>),
 * CHAQUE PART DANS SA POCHE : la part achetée revient au ledger (exactement ce
 * qui a été prélevé, pas le tarif courant) ; la part d'abonnement revient à
 * `remaining` SEULEMENT si le débit date de la FENÊTRE en cours et que la
 * période court — une fois la fenêtre passée elle est perdue comme le reliquat
 * (jamais reportée). Le user crédité est celui du débit d'origine.
 */
export async function refundGeneration(kind: string, ref: string, userId = currentUser()): Promise<void> {
  if (!billingEnabled()) return;
  try {
    if (await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, `refund:${ref}`)) return;
    const debited = await authGet<{ delta: number; user_id: string; sub_amount: number | null; created_at: string }>(
      `SELECT ${DELTA_CENTI} AS delta, user_id, sub_amount, created_at FROM credit_transactions WHERE ref = ?`, ref,
    );
    if (!debited) return;               // jamais débité → rien à rendre
    const u = debited.user_id || userId;
    const purchasedBack = Math.max(0, -Number(debited.delta));
    const subBack = Math.max(0, Number(debited.sub_amount ?? 0));
    if (subBack > 0) {
      const s = await getSubscription(u);
      const windowStart = s ? (s.window_anchor ?? s.period_start ?? (s.month_anchor ? `${s.month_anchor}-01 00:00:00` : null)) : null;
      const sameWindow = !!windowStart && String(debited.created_at) >= windowStart && !rechargeDue(s!, nowStr());
      if (subscriptionLive(s) && sameWindow) {
        await authRun(`UPDATE subscriptions SET remaining = remaining + ?, updated_at = ? WHERE user_id = ?`, subBack, nowStr(), u);
      }
    }
    // Ligne de remboursement de la part achetée + marqueur d'idempotence (delta 0 accepté).
    await addTransaction(u, purchasedBack, `remboursement ${kind}`, `refund:${ref}`);
  } catch (e) {
    log("warn", "credits.refund_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/** Historique (API /api/billing). */
export async function listTransactions(userId = currentUser(), limit = 50) {
  return authAll<{ delta: number; reason: string; ref: string | null; sub_amount: number; created_at: string }>(
    `SELECT ${DELTA_CENTI} AS delta, reason, ref, sub_amount, created_at FROM credit_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    userId, limit,
  );
}
