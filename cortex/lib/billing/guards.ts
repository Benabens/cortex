import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";

/**
 * GARDE-FOUS PAR UTILISATEUR (déploiement v1 — RÈGLE D'OR n°2) :
 * quotas quotidiens de génération, comptés dans la table GLOBALE `gen_events`
 * (store auth — cross-cours, cross-tenant).
 *
 * Deux compteurs distincts :
 *  - bucket "gen"    : générations lourdes par jobs (exam, qcm, exercise,
 *    lab-exercise, blueprint, format, prepare) — DAILY_GEN_QUOTA (ex. 3/jour) ;
 *  - bucket "assist" : appels LLM inline (drill, check-solution, analyse de
 *    faiblesses, mining) — DAILY_ASSIST_QUOTA (ex. 20/jour).
 *
 * Env non posée → PAS de quota (dev €0 : comportement historique intact).
 */

export type GateIssue = { status: number; error: string };
export type QuotaBucket = "gen" | "assist";

function quotaFor(bucket: QuotaBucket): number | null {
  const raw = bucket === "gen" ? process.env.DAILY_GEN_QUOTA : process.env.DAILY_ASSIST_QUOTA;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Nombre d'événements du user pour AUJOURD'HUI dans un bucket. */
export async function usedToday(bucket: QuotaBucket, userId = currentUser()): Promise<number> {
  const day = nowStr().slice(0, 10);
  const r = await authGet<{ n: number }>(
    `SELECT count(*) n FROM gen_events WHERE user_id = ? AND bucket = ? AND day = ?`,
    userId, bucket, day,
  );
  return Number(r?.n ?? 0);
}

/**
 * Gate de quota : null = passe ; sinon {status: 429, error} à renvoyer tel quel.
 * À appeler AVANT de créer un job / lancer un appel inline.
 */
export async function generationGate(bucket: QuotaBucket): Promise<GateIssue | null> {
  const cap = quotaFor(bucket);
  if (cap === null) return null;
  const used = await usedToday(bucket);
  if (used >= cap) {
    return {
      status: 429,
      error:
        bucket === "gen"
          ? `Quota quotidien de générations atteint (${used}/${cap}). Réessaie demain.`
          : `Quota quotidien d'assistance atteint (${used}/${cap}). Réessaie demain.`,
    };
  }
  return null;
}

/** Comptabilise une génération/assistance (best-effort, jamais bloquant). */
export async function recordGeneration(bucket: QuotaBucket, kind: string): Promise<void> {
  try {
    const t = nowStr();
    await authRun(
      `INSERT INTO gen_events (user_id, bucket, kind, course, day, created_at) VALUES (?,?,?,?,?,?)`,
      currentUser(), bucket, kind, currentCourse(), t.slice(0, 10), t,
    );
  } catch (e) {
    log("warn", "quota.record_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}
