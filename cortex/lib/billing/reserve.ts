import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authRun, authTx, type AuthTx } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { billingEnabled, creditCost, ensureLedgerUnit, ensureSignupCredits, insufficient } from "./credits";
import { intLimit } from "./env";
import { quotaFor, quotaTrackingActive, ratePerUserPerMin, type GateIssue, type QuotaBucket } from "./guards";

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
 *   5. sinon : écriture du compteur, de la place active et du débit — ensemble.
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
  /** Place « génération en cours » à réserver (jobs seulement). */
  jobSlot?: { course: string; jobId: number };
  userId?: string;
  course?: string;
};

/** Plafond de générations simultanées par compte (défaut 2 en déploiement gardé ; « unlimited » pour lever). */
export function maxActiveJobs(): number | null {
  return intLimit("MAX_ACTIVE_JOBS", 2);
}

/** Au-delà de cet âge, une place active est considérée orpheline (worker mort sans état terminal). */
const SLOT_MAX_AGE_MS = 6 * 3600_000;

/** Verrou transactionnel par utilisateur (Postgres) ; sqlite sérialise déjà les écritures. */
async function lockUser(tx: AuthTx, userId: string): Promise<void> {
  if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, userId);
}

export async function reserveGeneration(o: ReserveOpts): Promise<Reservation> {
  const userId = o.userId ?? currentUser();
  const course = o.course ?? currentCourse();
  const cost = o.costCenti ?? creditCost(o.kind);
  const billing = billingEnabled();
  const tracking = quotaTrackingActive();
  const rateCap = tracking ? ratePerUserPerMin() : null;
  const dayCap = tracking ? quotaFor(o.bucket) : null;
  // Indépendant de la facturation : posé explicitement, ou défaut d'un déploiement gardé.
  const slotCap = o.jobSlot ? maxActiveJobs() : null;

  // Rien à décider ni à écrire : dev €0 nu.
  if (!billing && rateCap === null && dayCap === null && slotCap === null && !tracking) {
    return { ok: true, ref: o.ref, costCenti: 0 };
  }
  if (billing) {
    await ensureLedgerUnit();
    await ensureSignupCredits(userId);
  }

  const t = nowStr();
  const day = t.slice(0, 10);
  return authTx(async (tx): Promise<Reservation> => {
    await lockUser(tx, userId);

    if (rateCap !== null) {
      const r = await tx.get<{ n: number }>(
        `SELECT count(*) n FROM gen_events WHERE user_id = ? AND created_at >= ?`, userId, nowStr(-60_000),
      );
      if (Number(r?.n ?? 0) >= rateCap) {
        return { ok: false, status: 429, error: `Trop de requêtes — patiente une minute (limite ${rateCap}/min par compte).` };
      }
    }
    if (dayCap !== null) {
      const r = await tx.get<{ n: number }>(
        `SELECT count(*) n FROM gen_events WHERE user_id = ? AND bucket = ? AND day = ?`, userId, o.bucket, day,
      );
      const used = Number(r?.n ?? 0);
      if (used >= dayCap) {
        return {
          ok: false, status: 429,
          error: o.bucket === "gen"
            ? `Quota quotidien de générations atteint (${used}/${dayCap}). Réessaie demain.`
            : `Quota quotidien d'assistance atteint (${used}/${dayCap}). Réessaie demain.`,
        };
      }
    }
    if (o.jobSlot && slotCap !== null) {
      await tx.run(`DELETE FROM active_jobs WHERE created_at < ?`, nowStr(-SLOT_MAX_AGE_MS));
      const r = await tx.get<{ n: number }>(`SELECT count(*) n FROM active_jobs WHERE user_id = ?`, userId);
      if (Number(r?.n ?? 0) >= slotCap) {
        return { ok: false, status: 429, error: `Trop de générations en cours (${slotCap} au maximum par compte). Attends la fin d'un job.` };
      }
    }
    if (billing) {
      const seen = await tx.get<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, o.ref);
      if (!seen) {
        const bal = await tx.get<{ total: number | null }>(
          `SELECT coalesce(sum(delta), 0) total FROM credit_transactions WHERE user_id = ?`, userId,
        );
        const refusal = insufficient(Number(bal?.total ?? 0), cost);
        if (refusal) return { ok: false, ...refusal };
        if (cost > 0) {
          await tx.run(
            `INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`,
            userId, -cost, `génération ${o.kind}`, o.ref, t,
          );
        }
      }
    }
    if (tracking) {
      await tx.run(
        `INSERT INTO gen_events (user_id, bucket, kind, course, day, created_at) VALUES (?,?,?,?,?,?)`,
        userId, o.bucket, o.kind, course, day, t,
      );
    }
    if (o.jobSlot && slotCap !== null) {
      await tx.run(
        `INSERT INTO active_jobs (user_id, course, job_id, created_at) VALUES (?,?,?,?) ON CONFLICT (user_id, course, job_id) DO NOTHING`,
        userId, o.jobSlot.course, o.jobSlot.jobId, t,
      );
    }
    return { ok: true, ref: o.ref, costCenti: billing ? cost : 0 };
  });
}

/** Libère la place « en cours » d'un job arrivé à un état terminal (best-effort). */
export async function releaseJobSlot(userId: string, course: string, jobId: number): Promise<void> {
  if (maxActiveJobs() === null) return;
  try {
    await authRun(`DELETE FROM active_jobs WHERE user_id = ? AND course = ? AND job_id = ?`, userId, course, jobId);
  } catch (e) {
    log("warn", "jobs.slot_release_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/**
 * Gate des appels d'ASSISTANCE (drill, correction, analyses) : une réservation
 * complète — rafale, quota du jour, solde — débitée AVANT l'appel au modèle.
 * null = passe ; sinon {status, error} à renvoyer tel quel.
 */
export async function assistGate(kind: string): Promise<GateIssue | null> {
  // Moteur indisponible : refus AVANT toute réservation — un débit non
  // remboursable ne doit jamais précéder un appel qui ne partira pas.
  const { llmAvailable, llmUnavailableReason } = await import("@/lib/llm");
  if (!llmAvailable()) return { status: 503, error: llmUnavailableReason() ?? "Moteur LLM indisponible." };
  // `kind` (drill, check-solution…) est le libellé du compteur ; le tarif est celui d'« assist ».
  const r = await reserveGeneration({
    bucket: "assist", kind, costCenti: creditCost("assist"),
    ref: `assist:${currentUser()}:${crypto.randomUUID()}`,
  });
  if (r.ok) return null;
  return { status: r.status, error: r.error };
}
