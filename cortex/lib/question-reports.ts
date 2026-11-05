import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authAll, authGet, authInsert } from "@/db/auth-store";
import { nowStr, q } from "@/db/q";
import { sanitizeCorpus } from "@/lib/prompt-safety";
import type { QcmItem } from "@/lib/qcm";

/**
 * BOUCLE DE RELECTURE — un étudiant (ou un agent, par le connecteur) signale une
 * question : réponse fausse, hors programme ou définition différente du cours,
 * doublon, énoncé ambigu (relecture du mock 4 de CS-290 par Ben). Chaque
 * signalement améliore le moteur pour CE cours :
 *  - la question quitte les révisions de l'utilisateur ;
 *  - elle devient un contre-exemple des prochaines générations du cours ;
 *  - « réponse fausse » sur un QCM : re-vérifiée à l'aveugle avec les extraits
 *    du cours ; confirmée, la question est remboursée (sa part de l'examen,
 *    une seule fois) et marquée non vérifiée.
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
  let qcm: QcmItem | null = null;
  if (input.kind === "qcm") {
    const row = await q.get<QcmRow>(`SELECT topic, type, stem, options_json, correct_json, misconceptions_json, explanation FROM qcm_items WHERE id = ? AND exam_id = ?`, input.itemId, input.examId).catch(() => undefined);
    if (!row) throw new ReportError(404, "Question introuvable dans cet examen.");
    stem = row.stem;
    qcm = {
      topic: row.topic, type: row.type, stem: row.stem, options: JSON.parse(row.options_json), correct: JSON.parse(row.correct_json),
      misconceptions: JSON.parse(row.misconceptions_json ?? "[]"), explanation: row.explanation ?? "", verified: null,
    };
  } else if (input.kind === "part") {
    const row = await q.get<{ kind: string; prompt: string; options_json: string | null; correct: number | null; explanation: string | null; scenario: string; title: string }>(
      `SELECT p.kind, p.prompt, p.options_json, p.correct, p.explanation, b.scenario, b.title FROM block_parts p JOIN exam_blocks b ON b.id = p.block_id WHERE p.id = ? AND p.exam_id = ?`, input.itemId, input.examId,
    ).catch(() => undefined);
    if (!row) throw new ReportError(404, "Question introuvable dans cet examen.");
    stem = `${row.title} — ${row.prompt}`;
    // Un choix unique se re-vérifie comme un QCM : son scénario fait partie de l'énoncé.
    if (row.kind === "scq") {
      qcm = {
        topic: row.title, type: "scq", stem: `${row.scenario}\n\n${row.prompt}`, options: JSON.parse(row.options_json ?? "[]"), correct: [Number(row.correct)],
        misconceptions: [], explanation: row.explanation ?? "", verified: null,
      };
    }
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

  // « Réponse fausse » sur un QCM : re-vérification à l'aveugle avec les extraits du cours.
  // Juge indisponible (verified reste null) : le signalement reste ouvert, sans verdict.
  let status: ReportStatus = "open";
  let refunded = 0;
  // Une question ne se re-vérifie qu'UNE fois (appel au modèle non facturé) : un nouveau
  // « réponse fausse » reprend le verdict déjà rendu, sans rappeler le modèle.
  const judged = input.reason === "wrong_answer" && qcm
    ? await authGet<{ status: ReportStatus }>(
      `SELECT status FROM question_reports WHERE user_id = ? AND course = ? AND exam_id = ? AND kind = ? AND item_id = ? AND reason = 'wrong_answer' AND status <> 'open' ORDER BY id LIMIT 1`,
      currentUser(), currentCourse(), input.examId, input.kind, input.itemId,
    ).catch(() => undefined)
    : undefined;
  if (judged) status = judged.status;
  else if (input.reason === "wrong_answer" && qcm) {
    const { verifyQcmBatch } = await import("@/lib/qcm");
    // Sans l'explication : un rejet de FORME (explication par position ou par lettre) ne confirme pas
    // à lui seul un signalement ; la clé, les notions, les définitions et la matière restent jugées.
    const [checked] = await verifyQcmBatch([{ ...qcm, explanation: "" }], () => {}).catch(() => [null]);
    if (checked && checked.verified !== null) {
      const keyChanged = JSON.stringify([...checked.correct].sort()) !== JSON.stringify([...qcm.correct].sort());
      // Clé contestée, hors cours, définition différente, hors matière : le juge rejette (lib/qcm).
      const confirmed = keyChanged || checked.verified === 0 || !!checked.rejected;
      status = confirmed ? "confirmed" : "not_confirmed";
      if (confirmed) {
        if (input.kind === "qcm") await q.run(`UPDATE qcm_items SET verified = 0 WHERE id = ?`, input.itemId);
        refunded = await refundQuestion(input.examId, input.kind, input.itemId);
      }
    }
  }

  const id = await authInsert(
    `INSERT INTO question_reports (user_id, course, exam_id, kind, item_id, reason, comment, stem, status, refunded_centi, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    currentUser(), currentCourse(), input.examId, input.kind, input.itemId, input.reason, comment, stem.slice(0, 2000), status, refunded, nowStr(),
  );
  return { id, status, refundedCenti: refunded, removedFromRevision: removed };
}

/** Rembourse la part d'UNE question dans le débit de son examen (une fois par question). */
async function refundQuestion(examId: number, kind: ReportKind, itemId: number): Promise<number> {
  const job = await q.get<{ credit_ref: string | null; type: string }>(
    `SELECT credit_ref, type FROM jobs WHERE result_id = ? AND type IN ('qcm','exam') ORDER BY id DESC LIMIT 1`, examId,
  ).catch(() => undefined);
  if (!job?.credit_ref) return 0;
  // Sa part : une question parmi celles de l'examen (sous-questions d'une question composée comprises).
  const n = kind === "part"
    ? await q.get<{ n: number }>(`SELECT count(*) n FROM block_parts WHERE exam_id = ?`, examId).catch(() => undefined)
    : await q.get<{ n: number }>(
      `SELECT (SELECT count(*) FROM qcm_items WHERE exam_id = ?) + (SELECT count(*) FROM exam_questions WHERE exam_id = ?) n`, examId, examId,
    ).catch(() => undefined);
  const total = Number(n?.n ?? 0);
  if (!total) return 0;
  const { refundGeneration } = await import("@/lib/billing/credits");
  return refundGeneration(`question signalée ${job.type}`, job.credit_ref, currentUser(), 1 / total, `refund:${job.credit_ref}:${kind}:${itemId}`);
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
