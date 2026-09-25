import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { guardsActive, intLimit } from "./env";

/**
 * GARDE-FOUS PAR UTILISATEUR :
 * quotas quotidiens de génération, comptés dans la table GLOBALE `gen_events`
 * (store auth — cross-cours, cross-tenant).
 *
 * Deux compteurs distincts :
 *  - bucket "gen"    : générations lourdes par jobs (exam, qcm, exercise,
 *    lab-exercise, blueprint, format, prepare) — DAILY_GEN_QUOTA (ex. 3/jour) ;
 *  - bucket "assist" : appels LLM inline (drill, check-solution, analyse de
 *    faiblesses, mining) — DAILY_ASSIST_QUOTA (ex. 20/jour).
 *
 * FAIL-CLOSED : dans une vraie mise en ligne (AUTH ou BILLING
 * actif), un quota PAR DÉFAUT s'applique même si la variable n'est pas posée —
 * un oubli de config ne lève pas les limites. Dev €0 nu → pas de quota
 * (comportement historique). Poser `=unlimited` LÈVE explicitement une limite.
 *
 * Défauts choisis sur l'audit des coûts (18/09/2026), pas au hasard :
 *  - gen 10/jour : un utilisateur normal fait 4 examens/MOIS ; 10 gros jobs/jour
 *    dépasse tout usage légitime (et un job coûte déjà des crédits). Borne un
 *    compte à 300 jobs/mois ; pire cas ≈ examen haut 2,79 CHF → ~837 CHF/mois.
 *  - assist 40/jour : le plus lourd usage réel = 20 questions/jour (période
 *    d'exams) ; 40 couvre questions + corrections + analyses. Borne un compte à
 *    ~1 200 appels/mois → pire cas ≈ check-solution haut 0,18 CHF → ~211 CHF/mois
 *    (au lieu de ~60 000 sans quota). C'est le SEUL frein du chemin « assist »
 *    (0 crédit), donc le plus important.
 * Le plafond de dépense PAR UTILISATEUR (lib/billing/usage.ts) est le backstop
 * en CHF au-dessus de ces compteurs de clics.
 */

export type GateIssue = { status: number; error: string };
export type QuotaBucket = "gen" | "assist";

const QUOTA_DEFAULT: Record<QuotaBucket, number> = { gen: 10, assist: 40 };

export function quotaFor(bucket: QuotaBucket): number | null {
  const name = bucket === "gen" ? "DAILY_GEN_QUOTA" : "DAILY_ASSIST_QUOTA";
  return intLimit(name, QUOTA_DEFAULT[bucket]);
}

/** Limite de DÉBIT par utilisateur et par minute — arrête une boucle scriptée
 *  bien avant le quota quotidien. Défaut 20/min : aucun humain ne déclenche 20
 *  générations en une minute ; le quota quotidien reste la borne de coût. */
export function ratePerUserPerMin(): number | null {
  return intLimit("RATE_LIMIT_PER_USER_MIN", 20);
}

/** Nombre d'événements du user pour AUJOURD'HUI dans un bucket.
 *  Même garde que recordGeneration : sans garde-fou actif il n'y a rien à
 *  compter, et une simple LECTURE créerait le store (fichier + DDL) — ce que
 *  le dev €0 ne doit jamais faire. */
export async function usedToday(bucket: QuotaBucket, userId = currentUser()): Promise<number> {
  if (!quotaTrackingActive()) return 0;
  const day = nowStr().slice(0, 10);
  const r = await authGet<{ n: number }>(
    `SELECT count(*) n FROM gen_events WHERE user_id = ? AND bucket = ? AND day = ?`,
    userId, bucket, day,
  );
  return Number(r?.n ?? 0);
}

/**
 * Débit du user sur les 60 dernières secondes, TOUS buckets confondus.
 * Compté dans `gen_events` (store global) → PAR UTILISATEUR et cross-instance
 * (contrairement au rate-limit in-memory de proxy.ts, qui est par processus).
 */
export async function rateGate(): Promise<GateIssue | null> {
  const cap = ratePerUserPerMin();
  if (cap === null || !quotaTrackingActive()) return null;
  const since = nowStr(-60_000);
  const r = await authGet<{ n: number }>(
    `SELECT count(*) n FROM gen_events WHERE user_id = ? AND created_at >= ?`,
    currentUser(), since,
  );
  if (Number(r?.n ?? 0) >= cap) {
    return { status: 429, error: `Trop de requêtes — patiente une minute (limite ${cap}/min par compte).` };
  }
  return null;
}

/**
 * Gate de quota : null = passe ; sinon {status: 429, error} à renvoyer tel quel.
 * À appeler AVANT de créer un job / lancer un appel inline. Enchaîne la limite
 * de débit par minute (burst) puis le quota quotidien.
 */
export async function generationGate(bucket: QuotaBucket): Promise<GateIssue | null> {
  const burst = await rateGate();
  if (burst) return burst;
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

/** Un compteur n'a de sens QUE si un garde-fou l'utilise (quota posé, ou
 *  facturation active). Sinon : ne rien écrire — le dev €0 ne doit créer
 *  AUCUN fichier/table de plus qu'avant (invariant n°1). */
export function quotaTrackingActive(): boolean {
  return (
    guardsActive() ||
    quotaFor("gen") !== null ||
    quotaFor("assist") !== null ||
    process.env.BILLING_ENABLED === "1"
  );
}

/** Comptabilise une génération/assistance (best-effort, jamais bloquant). */
export async function recordGeneration(bucket: QuotaBucket, kind: string): Promise<void> {
  if (!quotaTrackingActive()) return;
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
