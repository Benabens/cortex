import { createHash, randomBytes } from "node:crypto";
import { authGet, authRun, authTx } from "@/db/auth-store";
import { dbDriverName } from "@/db/q";
import { ipGroup } from "@/lib/billing/free-offer";
import { spentTodayByUser } from "@/lib/billing/usage";
import { FREE_TOOL_USER, RUN_STALE_MS, freeToolLimits } from "./config";
import type { ExamTopicsResult } from "./result";

/**
 * Une analyse de l'outil gratuit = une ligne `exam_topic_runs` (base globale) : son jeton est
 * le lien partageable, son IP hachée borne le quota du jour, son statut dit au visiteur où elle
 * en est. Aucun fichier ni texte d'annale n'y est écrit : seulement le résultat agrégé.
 */

export type AdmitRefusal = "closed" | "daily_budget" | "ip_day" | "busy";
export type AdmitVerdict = { ok: true; id: string } | { ok: false; reason: AdmitRefusal };

const DAY_MS = 24 * 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Clé de quota d'une IP : hachée, groupe /64 en IPv6. Sans proxy de confiance (« direct »), pas de clé. */
function ipKey(ip: string): string | null {
  if (!ip || ip === "direct") return null;
  return createHash("sha256").update(`exam-topics-ip:${ipGroup(ip)}`).digest("hex").slice(0, 32);
}

/** Jeton du lien partageable : 128 bits, non devinable, sans ordre. */
function newRunId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Admet une analyse, ou dit pourquoi non, AVANT tout appel au modèle. Dans l'ordre : outil fermé
 * (plafond à 0), plafond du jour (le reste du jour doit couvrir le plafond d'UNE analyse), trop
 * d'analyses en cours, quota de l'IP. Admise : la ligne est écrite dans la même transaction,
 * sérialisée, pour que deux dépôts simultanés ne passent pas tous deux sous la même limite.
 */
export async function admitRun(opts: { ip: string; now?: number }): Promise<AdmitVerdict> {
  const now = opts.now ?? Date.now();
  const limits = freeToolLimits();
  if (limits.dailyUsd <= 0 || limits.runUsd <= 0) return { ok: false, reason: "closed" };
  // Dépense lue hors transaction (llm_usage passe par la même base, une authTx imbriquée attendrait sans fin en sqlite).
  const spent = await spentTodayByUser(FREE_TOOL_USER);
  if (spent + limits.runUsd > limits.dailyUsd) return { ok: false, reason: "daily_budget" };
  const key = ipKey(opts.ip);
  return authTx(async (tx): Promise<AdmitVerdict> => {
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, "exam-topic-runs");
    // Minimisation : l'IP ne sert qu'à la fenêtre de 24 h, effacée après 2 jours à chaque dépôt, admis ou non.
    await tx.run(`UPDATE exam_topic_runs SET ip_key = NULL WHERE ip_key IS NOT NULL AND created_at < ?`, at(now - 2 * DAY_MS));
    const running = Number((await tx.get<{ n: number }>(
      `SELECT count(*) n FROM exam_topic_runs WHERE status = 'running' AND created_at > ?`, at(now - RUN_STALE_MS),
    ))?.n ?? 0);
    if (running >= limits.maxConcurrent) return { ok: false, reason: "busy" };
    if (key) {
      const n = Number((await tx.get<{ n: number }>(
        `SELECT count(*) n FROM exam_topic_runs WHERE ip_key = ? AND created_at > ?`, key, at(now - DAY_MS),
      ))?.n ?? 0);
      if (n >= limits.perIpDay) return { ok: false, reason: "ip_day" };
    }
    const id = newRunId();
    await tx.run(`INSERT INTO exam_topic_runs (id, ip_key, status, created_at) VALUES (?, ?, 'running', ?)`, id, key, at(now));
    return { ok: true, id };
  });
}

/** Rend la place d'une analyse refusée avant tout appel (fichier illisible) : elle ne compte ni dans le quota ni en cours. */
export async function releaseRun(id: string): Promise<void> {
  await authRun(`DELETE FROM exam_topic_runs WHERE id = ? AND status = 'running'`, id);
}

export async function finishRun(id: string, result: ExamTopicsResult): Promise<void> {
  await authRun(
    `UPDATE exam_topic_runs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`,
    JSON.stringify(result), at(Date.now()), id,
  );
}

/** `error` : un code de message (pas de texte du modèle ni de l'annale). */
export async function failRun(id: string, error: string): Promise<void> {
  await authRun(
    `UPDATE exam_topic_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
    error.slice(0, 60), at(Date.now()), id,
  );
}

/** Une analyse admise et pas encore finie : la preuve qu'exige lib/llm pour un appel de l'outil. */
export async function runIsLive(id: string, now = Date.now()): Promise<boolean> {
  const r = await authGet<{ status: string; created_at: string }>(`SELECT status, created_at FROM exam_topic_runs WHERE id = ?`, id);
  return r?.status === "running" && r.created_at > at(now - RUN_STALE_MS);
}

export type RunView =
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "done"; result: ExamTopicsResult };

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export async function getRun(id: string, now = Date.now()): Promise<RunView | null> {
  if (!ID_RE.test(id)) return null;
  const r = await authGet<{ status: string; result_json: string | null; error: string | null; created_at: string }>(
    `SELECT status, result_json, error, created_at FROM exam_topic_runs WHERE id = ?`, id,
  );
  if (!r) return null;
  if (r.status === "done" && r.result_json) {
    try { return { status: "done", result: JSON.parse(r.result_json) as ExamTopicsResult }; } catch { return { status: "failed", error: "internal" }; }
  }
  if (r.status === "running") return r.created_at > at(now - RUN_STALE_MS) ? { status: "running" } : { status: "failed", error: "interrupted" };
  return { status: "failed", error: r.error ?? "internal" };
}
