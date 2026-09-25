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
 * Convertit UNE fois un ledger hérité (crédits entiers) en centièmes.
 * Atomique et idempotent : le marqueur et la conversion sont posés ensemble
 * (transaction sqlite ; instruction unique avec CTE en Postgres) — deux
 * processus qui démarrent en même temps ne convertissent pas deux fois.
 * Une base NEUVE reçoit le marqueur sans rien convertir.
 */
export async function ensureLedgerUnit(): Promise<void> {
  if (_unitChecked) return;
  if (dbDriverName() === "sqlite") {
    const db = authSqlite();
    if (!db) return;
    db.transaction(() => {
      const done = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(UNIT_KEY);
      if (done) return;
      db.prepare(`UPDATE credit_transactions SET delta = delta * ${CENTI}`).run();
      db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)`).run(UNIT_KEY, "centi");
    })();
  } else {
    // Le marqueur ne s'insère qu'une fois (clé primaire) ; la conversion ne
    // s'exécute que si CE processus l'a inséré.
    await authRun(
      `WITH m AS (INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key)
       UPDATE credit_transactions SET delta = delta * ${CENTI} WHERE EXISTS (SELECT 1 FROM m)`,
      UNIT_KEY, "centi",
    );
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
  const free = toCenti(envNum("SIGNUP_FREE_CREDITS", 2));
  if (free > 0) await addTransaction(userId, free, "signup", `signup:${userId}`);
  signupSeen.add(userId);
}

/** Solde en CENTIÈMES (unité interne des gates et du débit). */
export async function getBalanceCenti(userId = currentUser()): Promise<number> {
  await ensureLedgerUnit();
  await ensureSignupCredits(userId);
  const r = await authGet<{ total: number | null }>(
    `SELECT coalesce(sum(delta), 0) total FROM credit_transactions WHERE user_id = ?`, userId,
  );
  return Number(r?.total ?? 0);
}

/** Solde en CRÉDITS (affichage, API). */
export async function getBalance(userId = currentUser()): Promise<number> {
  return fromCenti(await getBalanceCenti(userId));
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
export function insufficient(balanceCenti: number, costCenti: number): { status: number; error: string } | null {
  // Un coût nul exige tout de même un solde positif : sinon un compte à sec —
  // ou passé en négatif par un remboursement Stripe — continuerait d'appeler le modèle.
  if (costCenti === 0) {
    return balanceCenti > 0 ? null : {
      status: 402,
      error: "Solde épuisé : recharge tes crédits pour continuer à utiliser l'assistance.",
    };
  }
  if (balanceCenti < costCenti) {
    return {
      status: 402,
      error: `Solde insuffisant : ${fmtCredits(balanceCenti)} crédit(s), génération à ${fmtCredits(costCenti)}. Recharge tes crédits pour continuer.`,
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

/**
 * Rembourse une génération qui n'a rien produit (idempotent : ref refund:<ref>).
 * Rend EXACTEMENT ce qui a été débité — pas un coût recalculé : un changement
 * de tarif (CREDITS_COST_JSON) entre le débit et le remboursement rendrait
 * sinon plus (ou moins) que ce qui a été prélevé. Le user crédité est celui de
 * la transaction d'origine, pas le contexte courant.
 */
export async function refundGeneration(kind: string, ref: string, userId = currentUser()): Promise<void> {
  if (!billingEnabled()) return;
  try {
    const debited = await authGet<{ delta: number; user_id: string }>(
      `SELECT delta, user_id FROM credit_transactions WHERE ref = ?`, ref,
    );
    if (!debited) return;               // jamais débité → rien à rendre
    const amount = -Number(debited.delta); // le débit est négatif
    if (!(amount > 0)) return;
    await addTransaction(debited.user_id || userId, amount, `remboursement ${kind}`, `refund:${ref}`);
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
