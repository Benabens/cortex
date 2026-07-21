import { currentUser } from "@/db/context";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";

/**
 * CRÉDITS (déploiement v1 — Phase 5bis, modèle payant dès la v1).
 *
 * Source de vérité UNIQUE : la table globale `credit_transactions` (store auth)
 * — le solde d'un user = SUM(delta). Pas de table de solde séparée à
 * désynchroniser. Idempotence STRUCTURELLE : chaque opération porte un `ref`
 * UNIQUE (id d'événement Stripe, `signup:<user>`, `job:<cours>:<id>`…) —
 * rejouer l'opération (double webhook, retry) ne crée jamais de doublon.
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

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** Coût en crédits par type de génération (jobs). Surcharge : CREDITS_COST_JSON. */
const DEFAULT_COSTS: Record<string, number> = {
  exam: 2,
  qcm: 1,
  exercise: 1,
  "lab-exercise": 1,
  blueprint: 1,
  format: 1,
  prepare: 2,
};

export function creditCost(kind: string): number {
  try {
    const raw = process.env.CREDITS_COST_JSON;
    if (raw) {
      const map = JSON.parse(raw) as Record<string, number>;
      if (typeof map[kind] === "number") return Math.max(0, Math.floor(map[kind]));
    }
  } catch { /* JSON invalide → défauts */ }
  return DEFAULT_COSTS[kind] ?? 1;
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

/** Écrit une transaction idempotente (ref UNIQUE). true = écrite, false = déjà vue. */
export async function addTransaction(
  userId: string, delta: number, reason: string, ref?: string,
): Promise<boolean> {
  if (ref) {
    const seen = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref);
    if (seen) return false;
  }
  try {
    await authRun(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`,
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
  const free = envInt("SIGNUP_FREE_CREDITS", 2);
  if (free > 0) await addTransaction(userId, free, "signup", `signup:${userId}`);
  signupSeen.add(userId);
}

export async function getBalance(userId = currentUser()): Promise<number> {
  await ensureSignupCredits(userId);
  const r = await authGet<{ total: number | null }>(
    `SELECT coalesce(sum(delta), 0) total FROM credit_transactions WHERE user_id = ?`, userId,
  );
  return Number(r?.total ?? 0);
}

/**
 * Gate de solde AVANT une génération par job : null = passe, sinon
 * {status: 402, error claire}. `kind` inconnu au moment du preflight → on
 * exige le coût MINIMUM d'une génération (1 crédit).
 */
export async function creditsGate(kind?: string): Promise<{ status: number; error: string } | null> {
  if (!billingEnabled()) return null;
  const cost = kind ? creditCost(kind) : 1;
  const balance = await getBalance();
  if (balance < cost) {
    return {
      status: 402,
      error: `Solde insuffisant : ${balance} crédit(s), génération à ${cost}. Recharge tes crédits pour continuer.`,
    };
  }
  return null;
}

/** Débite une génération (idempotent par job). Best-effort : loggé si échec. */
export async function debitGeneration(kind: string, ref: string): Promise<void> {
  if (!billingEnabled()) return;
  const cost = creditCost(kind);
  if (cost <= 0) return;
  try {
    await addTransaction(currentUser(), -cost, `génération ${kind}`, ref);
  } catch (e) {
    log("warn", "credits.debit_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/** Rembourse une génération en ÉCHEC (idempotent : ref refund:<ref>). */
export async function refundGeneration(kind: string, ref: string, userId = currentUser()): Promise<void> {
  if (!billingEnabled()) return;
  const cost = creditCost(kind);
  if (cost <= 0) return;
  try {
    // Ne rembourse que si le débit a bien eu lieu.
    const debited = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref);
    if (!debited) return;
    await addTransaction(userId, cost, `remboursement ${kind} (échec)`, `refund:${ref}`);
  } catch (e) {
    log("warn", "credits.refund_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/** Historique (API /api/billing). */
export async function listTransactions(userId = currentUser(), limit = 50) {
  return authAll<{ delta: number; reason: string; ref: string | null; created_at: string }>(
    `SELECT delta, reason, ref, created_at FROM credit_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    userId, limit,
  );
}
