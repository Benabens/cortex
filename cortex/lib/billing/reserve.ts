import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authRun, authTx } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { BAD_OUTPUT_CODES, llmErrorCode } from "@/lib/llm/errors";
import { log } from "@/lib/metrics";
import { defaultProviderName } from "@/lib/llm/config";
import { expectedJobCostUsd } from "./budget";
import { billingEnabled, creditCost, ensureLedgerUnit, ensureSignupCredits, lockAccountInTx as lockUser, openSubscriptionWindowInTx } from "./credits";
import { quotaTrackingActive, type GateIssue, type QuotaBucket } from "./guards";
import { SLOT_MAX_AGE_MS, launchVerdict, maxActiveJobsLimit, readCounterState, readSpendState, type LaunchSpec, type LimitsState } from "./limits";
import { isOwner } from "./owner";
import { isPaidProvider, spendCapUsd } from "./usage";

/**
 * RÉSERVATION — la décision UNIQUE et ATOMIQUE qui autorise une dépense LLM.
 *
 * Avant : le solde et les quotas étaient lus dans des requêtes séparées, puis
 * débités/comptés après coup (« best-effort »). Deux demandes parallèles
 * passaient toutes les deux le gate et le solde partait en négatif ; un débit
 * en échec laissait démarrer le job (génération gratuite). Désormais, dans UNE
 * transaction du store global, verrouillée PAR UTILISATEUR :
 *
 *   1. débit par minute (rafale)            → 429
 *   2. quota du jour du bucket              → 429
 *   3. générations en cours (MAX_ACTIVE_JOBS, hors facturation) → 429
 *   4. solde ≥ coût (si facturation active) → 402
 *   5. budget IA lié au revenu (lib/billing/budget) : au-delà, 402 — sauf
 *      crédits achetés, toujours servis ;
 *   6. calcul du jour du compte (budget et fusible par compte), puis fusible
 *      global du mois — dépense + coût attendu des jobs en cours + coût attendu
 *      de celui-ci → 429 : un job admis ne sera pas coupé par une limite connue ;
 *   7. sinon : écriture du compteur, de la place active (avec son coût attendu)
 *      et du débit — ensemble.
 *
 * Les conditions et les messages sont ceux de lib/billing/limits (`launchVerdict`) :
 * l'affichage, les pré-contrôles de l'app et du MCP et cette réservation rendent
 * le même verdict, mot pour mot.
 *
 * Un refus est une VALEUR renvoyée, jamais une exception (cf. authTx : un
 * ROLLBACK n'est réservé qu'aux vraies erreurs). Le débit porte la `ref` du
 * job ou de l'appel : rejouer la même réservation ne débite pas deux fois.
 * Sans garde-fou actif (dev €0), rien n'est écrit — invariant n°6.
 */

export type ReservationOk = { ok: true; ref: string; costCenti: number };
export type ReservationRefusal = { ok: false } & GateIssue;
export type Reservation = ReservationOk | ReservationRefusal;

export type ReserveOpts = {
  bucket: QuotaBucket;
  /** Type facturé (clé de CREDITS_COST_JSON) : exam, qcm, assist… */
  kind: string;
  /** Référence idempotente du débit (`job:<user>:<cours>:<id>`, `assist:<user>:<uuid>`). */
  ref: string;
  /** Coût en centièmes ; défaut : creditCost(kind). */
  costCenti?: number;
  /** Réserver aussi une place « génération en cours » (jobs seulement), identifiée par `ref`. */
  jobSlot?: boolean;
  userId?: string;
  course?: string;
};

/** Plafond de générations simultanées par compte (défaut 2 en déploiement gardé ; « unlimited » pour lever). */
export function maxActiveJobs(): number | null {
  return maxActiveJobsLimit();
}

/**
 * Verrou de la capacité GLOBALE du mois (Postgres) : deux comptes qui lancent en
 * même temps ne voient pas tous les deux la même marge sous le fusible du mois.
 * Toujours pris AVANT le verrou du compte (ordre fixe : pas d'interblocage).
 */
const GLOBAL_LOCK = "cortex:capacite-globale";

export async function reserveGeneration(o: ReserveOpts): Promise<Reservation> {
  const userId = o.userId ?? currentUser();
  const course = o.course ?? currentCourse();
  const cost = o.costCenti ?? creditCost(o.kind);
  const billing = billingEnabled();
  const tracking = quotaTrackingActive();

  // Rien à décider ni à écrire : dev €0 nu (aucun garde-fou, aucun store à créer).
  if (!billing && !tracking && maxActiveJobs() === null && spendCapUsd() === null) {
    return { ok: true, ref: o.ref, costCenti: 0 };
  }
  // Le propriétaire (lib/billing/owner) n'est ni débité ni compté ; il reste soumis
  // au fusible GLOBAL du mois, vérifié ici comme pour tous (le verdict l'applique).
  const owner = await isOwner(userId);
  if (billing && !owner) {
    await ensureLedgerUnit();
    await ensureSignupCredits(userId);
  }
  const spec: LaunchSpec = { bucket: o.bucket, kind: o.kind, costCenti: cost, jobSlot: !!o.jobSlot };
  // Dépense (jour, budget lié au revenu, mois) lue AVANT la transaction : elle s'écrit
  // pendant les appels au modèle, pas ici. Ce qui DOIT être lu sous le verrou — le coût
  // attendu des jobs déjà admis et encore en cours — l'est : deux lancements
  // simultanés ne passent pas tous les deux sous la même marge.
  let spend: Awaited<ReturnType<typeof readSpendState>>;
  try {
    spend = await readSpendState(userId, owner, billing);
  } catch (e) {
    // Budget invérifiable : refusé comme un plafond invérifiable (fail-closed), rien n'est débité.
    log("error", "billing.budget_check_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return { ok: false, status: 503, error: "Budget de calcul invérifiable (base indisponible) : réessaie dans un instant." };
  }
  const expectedUsd = expectedJobCostUsd(o.bucket === "assist" ? "assist" : o.kind, cost);
  const keepSlot = !!o.jobSlot && (maxActiveJobs() !== null || spend.paid);

  const t = nowStr();
  const day = t.slice(0, 10);
  return authTx(async (tx): Promise<Reservation> => {
    if (dbDriverName() === "postgres" && spend.paid && spend.globalCapUsd !== null) {
      await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, GLOBAL_LOCK);
    }
    await lockUser(tx, userId);
    if (keepSlot) await tx.run(`DELETE FROM active_jobs WHERE created_at < ?`, nowStr(-SLOT_MAX_AGE_MS));

    const counters = await readCounterState(tx, userId, owner, billing, t);
    // Rejeu de la même réservation (même ref) : déjà débitée, elle ne se re-vérifie pas sur le solde.
    const seen = billing && !owner ? await tx.get<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, o.ref) : undefined;
    const state: LimitsState = { ...spend, ...counters, credits: seen ? null : counters.credits, now: t, owner, billing, storage: null };
    const refusal = launchVerdict(state, spec);
    if (refusal) {
      log("info", "billing.launch_refused", { user: userId, kind: o.kind, limit: refusal.key });
      return { ok: false, status: refusal.status, error: refusal.error };
    }

    if (billing && !owner && !seen && counters.credits) {
      // DEUX POCHES, sous le verrou utilisateur : abonnement (recharge de fenêtre
      // comprise, annuel seulement) d'abord, puis crédits achetés — décidés et
      // écrits dans la même transaction, aucune course entre les deux.
      const { subCenti, rechargeWindow } = counters.credits;
      if (rechargeWindow) await openSubscriptionWindowInTx(tx, userId, rechargeWindow, t);
      if (cost > 0) {
        const usedSub = Math.min(cost, subCenti);
        await tx.run(
          `INSERT INTO credit_transactions (user_id, delta, reason, ref, sub_amount, unit, created_at) VALUES (?,?,?,?,?,'centi',?)`,
          userId, -(cost - usedSub), `génération ${o.kind}`, o.ref, usedSub, t,
        );
        if (usedSub > 0) {
          await tx.run(`UPDATE subscriptions SET remaining = remaining - ?, updated_at = ? WHERE user_id = ?`, usedSub, t, userId);
        }
      }
    }
    if (tracking && !owner) {
      await tx.run(
        `INSERT INTO gen_events (user_id, bucket, kind, course, day, created_at, ref) VALUES (?,?,?,?,?,?,?)`,
        userId, o.bucket, o.kind, course, day, t, o.ref,
      );
    }
    if (keepSlot) {
      // La place porte le coût attendu du job : le calcul du jour et le fusible du mois
      // le comptent tant que le job tourne (y compris ceux du propriétaire, pour le mois).
      await tx.run(
        `INSERT INTO active_jobs (user_id, course, job_ref, kind, expected_usd, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (user_id, job_ref) DO NOTHING`,
        userId, course, o.ref, o.kind, spend.paid ? expectedUsd : 0, t,
      );
    }
    return { ok: true, ref: o.ref, costCenti: billing && !owner ? cost : 0 };
  });
}

/** Libère la place « en cours » d'une réservation (job terminal, ou réservation rendue). Best-effort. */
export async function releaseJobSlot(userId: string, ref: string): Promise<void> {
  if (maxActiveJobs() === null && !isPaidProvider(defaultProviderName())) return;
  try {
    await authRun(`DELETE FROM active_jobs WHERE user_id = ? AND job_ref = ?`, userId, ref);
  } catch (e) {
    log("warn", "jobs.slot_release_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/**
 * Rend la génération qu'une réservation a comptée dans le quota du jour : seulement pour
 * une réservation qui n'a servi à rien (création perdue au double clic). Un échec ou un
 * remboursement garde sa place : le quota borne les relances. Best-effort.
 */
export async function releaseQuotaEvent(userId: string, ref: string): Promise<void> {
  if (!quotaTrackingActive()) return;
  try {
    await authRun(`DELETE FROM gen_events WHERE user_id = ? AND ref = ?`, userId, ref);
  } catch (e) {
    log("warn", "billing.quota_release_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/**
 * Gate des appels d'ASSISTANCE (drill, correction, analyses) : une réservation
 * complète — rafale, quota du jour, solde — débitée AVANT l'appel au modèle.
 * null = passe ; sinon {status, error} à renvoyer tel quel.
 */
export async function assistGate(kind: string): Promise<GateIssue | null> {
  const r = await assistReserve(kind);
  return "issue" in r ? r.issue : null;
}

/** Comme assistGate, mais rend la référence de la réservation quand elle passe (pour un remboursement ciblé). */
export async function assistReserve(kind: string): Promise<{ issue: GateIssue } | { ref: string }> {
  // Moteur indisponible : refus AVANT toute réservation — un débit non
  // remboursable ne doit jamais précéder un appel qui ne partira pas.
  const { llmAvailable, llmUnavailableReason } = await import("@/lib/llm");
  if (!llmAvailable()) return { issue: { status: 503, error: llmUnavailableReason() ?? "Moteur LLM indisponible." } };
  // `kind` (drill, check-solution…) est le libellé du compteur ; le tarif est celui d'« assist ».
  const ref = `assist:${currentUser()}:${crypto.randomUUID()}`;
  const r = await reserveGeneration({ bucket: "assist", kind, costCenti: creditCost("assist"), ref });
  if (r.ok) return { ref };
  return { issue: { status: r.status, error: r.error } };
}

/** Refus d'un appel d'assistance par la réservation (rafale, quota, solde, moteur absent). */
export class AssistRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "AssistRefused"; }
}

/**
 * Réservation RENDUE : nos gardes ont arrêté l'appel avant envoi (comptage en
 * vol fail-closed, plafond de dépense, plafond de la réservation), ou le modèle
 * n'a renvoyé qu'une réponse inutilisable (BAD_OUTPUT_CODES : illisible, coupée)
 * — notre défaut, l'utilisateur n'a rien reçu ; le connecteur l'annonce sur la
 * même table. Après une dépense réelle, le crédit revient OFFERT (credits.ts,
 * audit fuites B1/I5) : rejouer une aide qui échoue ne fait pas tourner l'IA sans
 * paiement. Un échec du fournisseur lui-même (429, 5xx, réseau) reste débité,
 * comme décidé au lot 2 : l'appel est parti.
 */
const REFUNDED_CODES = new Set(["UNAVAILABLE", "SPEND_CAP", ...BAD_OUTPUT_CODES]);

/**
 * Réserve 0,3 crédit, exécute l'appel, et REMBOURSE si l'appel a été refusé par
 * nos propres gardes avant d'être envoyé. Lève AssistRefused si la réservation
 * elle-même est refusée ; laisse remonter les autres erreurs telles quelles.
 */
export async function assistCall<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const r = await assistReserve(kind);
  if ("issue" in r) throw new AssistRefused(r.issue.status, r.issue.error);
  try {
    const { runWithLlmAuthorization } = await import("@/lib/llm/authorization");
    return await runWithLlmAuthorization({ kind: "assist", ref: r.ref }, fn);
  } catch (e) {
    const code = llmErrorCode(e);
    if (code && REFUNDED_CODES.has(code)) {
      const { refundGeneration } = await import("./credits");
      await refundGeneration(`assist ${kind}`, r.ref);
    }
    throw e;
  }
}
