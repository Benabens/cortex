import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authAll, authInsert } from "@/db/auth-store";
import { nowStr, q } from "@/db/q";
import { sanitizeCorpus } from "@/lib/prompt-safety";

/**
 * BOUCLE DE RELECTURE — un étudiant (ou un agent, par le connecteur) signale une
 * question : réponse fausse, hors programme ou définition différente du cours,
 * doublon, énoncé ambigu (relecture du mock 4 de CS-290 par Ben). Chaque
 * signalement améliore le moteur pour CE cours :
 *  - la question quitte les révisions de l'utilisateur ;
 *  - elle devient un contre-exemple des prochaines générations du cours ;
 *  - il reste ouvert pour une revue humaine, sans dépense LLM cachée.
 * Stockés dans le store global (compte + cours) : le propriétaire de
 * l'instance les liste sans parcourir les bases de chaque cours.
 */

export const REPORT_REASONS = ["wrong_answer", "off_course", "duplicate", "ambiguous"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REASON_LABELS: Record<ReportReason, string> = {
  wrong_answer: "Réponse fausse",
  off_course: "Hors programme / définition différente du cours",
  duplicate: "Doublon",
  ambiguous: "Énoncé ambigu",
};
/** qcm : un QCM ; open : une question ouverte ; part : une sous-question d'une question composée (lib/blocks). */
export type ReportKind = "qcm" | "open" | "part";
export type ReportStatus = "open" | "confirmed" | "not_confirmed";

/** Refus montrable tel quel (message en français), avec son statut HTTP. */
export class ReportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export type ReportInput = { examId: number; kind: ReportKind; itemId: number; reason: ReportReason; comment?: string | null };
export type ReportResult = { id: number; status: ReportStatus; refundedCenti: number; removedFromRevision: number };

type QcmRow = { topic: string; type: "scq" | "mcq"; stem: string; options_json: string; correct_json: string; misconceptions_json: string | null; explanation: string | null };

export async function reportQuestion(input: ReportInput): Promise<ReportResult> {
  if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) throw new ReportError(400, "Motif de signalement inconnu.");
  if (input.kind !== "qcm" && input.kind !== "open" && input.kind !== "part") throw new ReportError(400, "Type de question inconnu (qcm, open ou part).");
  if (!Number.isInteger(input.examId) || !Number.isInteger(input.itemId)) throw new ReportError(400, "Examen ou question invalide.");
  const comment = (input.comment ?? "").trim().slice(0, 1000) || null;

  let stem: string;
  if (input.kind === "qcm") {
    const row = await q.get<QcmRow>(`SELECT topic, type, stem, options_json, correct_json, misconceptions_json, explanation FROM qcm_items WHERE id = ? AND exam_id = ?`, input.itemId, input.examId).catch(() => undefined);
    if (!row) throw new ReportError(404, "Question introuvable dans cet examen.");
    stem = row.stem;
  } else if (input.kind === "part") {
    const row = await q.get<{ kind: string; prompt: string; options_json: string | null; correct: number | null; explanation: string | null; scenario: string; title: string }>(
      `SELECT p.kind, p.prompt, p.options_json, p.correct, p.explanation, b.scenario, b.title FROM block_parts p JOIN exam_blocks b ON b.id = p.block_id WHERE p.id = ? AND p.exam_id = ?`, input.itemId, input.examId,
    ).catch(() => undefined);
    if (!row) throw new ReportError(404, "Question introuvable dans cet examen.");
    stem = `${row.title} — ${row.prompt}`;
  } else {
    const row = await q.get<{ concept: string; statement_html: string }>(`SELECT concept, statement_html FROM exam_questions WHERE id = ? AND exam_id = ?`, input.itemId, input.examId).catch(() => undefined);
    if (!row) throw new ReportError(404, "Question introuvable dans cet examen.");
    stem = `${row.concept} — ${row.statement_html}`;
  }

  // La question quitte les révisions de l'utilisateur (banque de révision : même énoncé).
  let removed = 0;
  try {
    removed = Number((await q.get<{ n: number }>(`SELECT count(*) n FROM revision_plan WHERE statement = ?`, stem))?.n ?? 0);
    if (removed) await q.run(`DELETE FROM revision_plan WHERE statement = ?`, stem);
  } catch { /* pas de banque de révision pour ce cours */ }

  // Le signalement reste gratuit : il est enregistré pour revue, sans déclencher
  // de juge LLM caché. Sa confirmation et son éventuel remboursement sont donc
  // asynchrones/manuels, jamais une dépense provoquée par un compte sans crédits.
  const status: ReportStatus = "open";
  const refunded = 0;

  const id = await authInsert(
    `INSERT INTO question_reports (user_id, course, exam_id, kind, item_id, reason, comment, stem, status, refunded_centi, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    currentUser(), currentCourse(), input.examId, input.kind, input.itemId, input.reason, comment, stem.slice(0, 2000), status, refunded, nowStr(),
  );
  return { id, status, refundedCenti: refunded, removedFromRevision: removed };
}

/**
 * Contre-exemples pour les prochaines générations du cours courant : les derniers
 * signalements du compte (une « réponse fausse » que la re-vérification n'a pas
 * confirmée n'en est pas un). Texte de l'étudiant assaini (jamais une balise de données).
 */
export async function counterExamplesBlock(limit = 8): Promise<string> {
  let rows: { reason: ReportReason; stem: string; comment: string | null }[] = [];
  try {
    rows = await authAll<{ reason: ReportReason; stem: string; comment: string | null }>(
      `SELECT reason, stem, comment FROM question_reports WHERE user_id = ? AND course = ? AND status <> 'not_confirmed' ORDER BY id DESC LIMIT ?`,
      currentUser(), currentCourse(), limit,
    );
  } catch { return ""; }
  if (!rows.length) return "";
  return [
    `NE REFAIS PAS CES ERREURS — questions signalées par l'étudiant sur ce cours :`,
    ...rows.map((r) => `  - [${REASON_LABELS[r.reason] ?? r.reason}] « ${sanitizeCorpus(r.stem).replace(/\s+/g, " ").slice(0, 220)} »${r.comment ? ` — ${sanitizeCorpus(r.comment).slice(0, 220)}` : ""}`),
  ].join("\n");
}

export type ReportRow = {
  id: number; userId: string; course: string; examId: number; kind: ReportKind; itemId: number;
  reason: ReportReason; comment: string | null; stem: string; status: ReportStatus; refundedCenti: number; createdAt: string;
};

/** Tous les signalements de l'instance, les plus récents d'abord (page du propriétaire). */
export async function listReports(limit = 200): Promise<ReportRow[]> {
  const rows = await authAll<Record<string, unknown>>(
    `SELECT id, user_id, course, exam_id, kind, item_id, reason, comment, stem, status, refunded_centi, created_at FROM question_reports ORDER BY id DESC LIMIT ?`, limit,
  );
  return rows.map((r) => ({
    id: Number(r.id), userId: String(r.user_id), course: String(r.course), examId: Number(r.exam_id), kind: r.kind as ReportKind,
    itemId: Number(r.item_id), reason: r.reason as ReportReason, comment: (r.comment as string | null) ?? null, stem: String(r.stem),
    status: r.status as ReportStatus, refundedCenti: Number(r.refunded_centi ?? 0), createdAt: String(r.created_at),
  }));
}
