import fs from "node:fs";
import path from "node:path";
import { q } from "@/db/q";
import { authAll, authGet } from "@/db/auth-store";
import { examsDir } from "@/lib/paths";
import type { BenchItem, BenchRun, PdfCheck } from "./types";

/**
 * LECTURE D'UN RUN EN BASE (scripts/bench) — dans le contexte du cours (runWithCourse) :
 * l'examen livré tel que la page /mock/N et les PDF le montrent, le plan du cours, les
 * examens déjà générés, les appels au modèle et les crédits du job. Rien n'est écrit.
 */

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Identifiants des « chapitres » tirés des supports (cours sans plan) : hors de portée des vrais plan_chapters.id. */
const SOURCE_CHAPTER = 1_000_000;

/**
 * Plan du cours : ses chapitres (plan_chapters) ; sans plan, comme le moteur (lib/coverage
 * assignChapters), un chapitre par support du cours hors annales — le juge y range les questions.
 */
export async function readPlan(): Promise<BenchRun["plan"]> {
  const chapters = await q.all<{ id: number; seq: number; title: string }>(`SELECT id, seq, title FROM plan_chapters ORDER BY seq`).catch(() => []);
  const topics = await q.all<{ label: string; plan_chapter_id: number | null }>(`SELECT label, plan_chapter_id FROM topics`).catch(() => []);
  if (!chapters.length) {
    const { EXAM_SOURCE_TYPES } = await import("@/lib/exam-format");
    const exam = new Set<string>(EXAM_SOURCE_TYPES);
    const sources = (await q.all<{ id: number; type: string; title: string }>(`SELECT id, type, title FROM sources ORDER BY id`).catch(() => [])).filter((s) => !exam.has(s.type));
    return { basis: "sources", chapters: sources.map((s, i) => ({ id: SOURCE_CHAPTER + Number(s.id), seq: i + 1, title: s.title })), topicChapter: {} };
  }
  return {
    basis: "plan",
    chapters: chapters.map((c) => ({ id: Number(c.id), seq: Number(c.seq), title: c.title })),
    topicChapter: Object.fromEntries(topics.map((t) => [t.label, t.plan_chapter_id == null ? null : Number(t.plan_chapter_id)])),
  };
}

/** Questions des examens déjà générés pour ce cours (doublons « vs examens précédents »). */
export async function readPrevious(): Promise<BenchRun["previous"]> {
  const qcm = await q.all<{ stem: string; topic: string | null }>(`SELECT stem, topic FROM qcm_items ORDER BY exam_id, idx`).catch(() => []);
  const open = await q.all<{ statement_html: string; concept: string | null }>(`SELECT statement_html, concept FROM exam_questions ORDER BY id`).catch(() => []);
  return [...qcm, ...open.map((o) => ({ stem: strip(o.statement_html ?? "").slice(0, 600), topic: o.concept }))];
}

async function pdfCheck(file: string | null | undefined): Promise<PdfCheck | null> {
  if (!file) return null;
  const abs = path.join(examsDir(), path.basename(file));
  if (!fs.existsSync(abs) || !abs.endsWith(".pdf")) return { file: path.basename(file), exists: fs.existsSync(abs), pages: 0, textChars: 0 };
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(abs)));
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    return { file: path.basename(file), exists: true, pages: totalPages, textChars: String(text).replace(/\s+/g, "").length };
  } catch {
    return { file: path.basename(file), exists: true, pages: 0, textChars: 0 };
  }
}

/** L'examen livré, ses PDF et la page en ligne (ce que lit /mock/N, sans les clés). */
export async function readExam(examId: number): Promise<{ exam: BenchRun["exam"]; render: BenchRun["render"] }> {
  const row = await q.get<{ format_template: string | null; html_path: string | null }>(`SELECT format_template, html_path FROM exams WHERE id = ?`, examId);
  const corrige = (p: string | null | undefined) => (p && p.endsWith(".pdf") ? p.replace(/\.pdf$/, "-corrige.pdf") : null);
  if (row?.format_template === "qcm") {
    const { getQcmExam } = await import("@/lib/qcm");
    const full = await getQcmExam(examId, true);
    const shown = await getQcmExam(examId, false).catch(() => null);
    const items: BenchItem[] = [
      ...(full?.items ?? []).map((it, i) => ({ idx: i, kind: "qcm" as const, topic: it.topic, stem: it.stem, options: it.options, correct: (it as { correct?: number[] }).correct, explanation: it.explanation })),
      ...(full?.open ?? []).map((o, k) => ({ idx: (full?.items.length ?? 0) + k, kind: "open" as const, topic: o.concept ?? null, stem: strip(o.statement), solution: strip(o.solution) })),
    ];
    return {
      exam: { id: examId, kind: "qcm", items },
      render: { statement: await pdfCheck(row.html_path), corrige: await pdfCheck(corrige(row.html_path)), web: { ok: !!shown, items: (shown?.items.length ?? 0) + (shown?.open.length ?? 0) } },
    };
  }
  if (row?.format_template === "blocks") {
    const { getBlockExam } = await import("@/lib/blocks");
    const full = await getBlockExam(examId, true);
    const shown = await getBlockExam(examId, false).catch(() => null);
    const items: BenchItem[] = (full?.blocks ?? []).map((b, i) => ({
      idx: i, kind: "block" as const, topic: b.section ?? b.title, stem: `${b.title}\n${b.scenario}`,
      parts: b.parts.map((p) => {
        const k = p as typeof p & { correct?: number; answer?: string; explanation?: string };
        return { prompt: p.prompt, code: p.code || undefined, options: p.options.length ? p.options : undefined, correct: k.correct != null && k.correct >= 0 ? k.correct : undefined, answer: k.answer || undefined, explanation: k.explanation || undefined };
      }),
    }));
    return {
      exam: { id: examId, kind: "blocks", items },
      render: { statement: await pdfCheck(row.html_path), corrige: await pdfCheck(corrige(row.html_path)), web: { ok: !!shown, items: shown?.blocks.length ?? 0 } },
    };
  }
  const rows = await q.all<{ statement_html: string; solution_html: string; concept: string | null }>(`SELECT statement_html, solution_html, concept FROM exam_questions WHERE exam_id = ? ORDER BY id`, examId).catch(() => []);
  const file = row?.html_path ? path.join(examsDir(), path.basename(row.html_path)) : null;
  return {
    exam: { id: examId, kind: "exercises", items: rows.map((r, i) => ({ idx: i, kind: "exercise" as const, topic: r.concept, stem: strip(r.statement_html ?? ""), solution: strip(r.solution_html ?? "") })) },
    render: {
      statement: await pdfCheck(row?.html_path), corrige: await pdfCheck(corrige(row?.html_path)),
      web: { ok: !!file && fs.existsSync(file) && fs.statSync(file).size > 0, items: rows.length },
    },
  };
}

/** Appels au modèle comptés pour ce job (llm_usage, CORTEX_TRACK_USAGE=1). */
export async function readUsage(jobId: number, course: string): Promise<BenchRun["usage"]> {
  const rows = await authAll<{ call_site: string | null; model: string; tokens_in: number; tokens_out: number; attempt: number | null; latency_ms: number | null }>(
    `SELECT call_site, model, tokens_in, tokens_out, attempt, latency_ms FROM llm_usage WHERE course = ? AND job_id = ? ORDER BY id`, course, String(jobId),
  ).catch(() => []);
  return rows.map((r) => ({ site: r.call_site, model: r.model, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), attempt: Number(r.attempt ?? 1), latencyMs: r.latency_ms == null ? null : Number(r.latency_ms) }));
}

/** Débit du job et parts remboursées (‰) ; null si la facturation n'était pas active. */
export async function readBilling(creditRef: string | null): Promise<BenchRun["billing"]> {
  if (process.env.BILLING_ENABLED !== "1") return null;
  if (!creditRef) return { debited: false, refundedMilli: 0 };
  const debit = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, creditRef);
  const refunds = await authAll<{ share_milli: number | null }>(`SELECT share_milli FROM credit_transactions WHERE ref LIKE ?`, `refund:${creditRef}%`);
  return { debited: !!debit, refundedMilli: Math.min(1000, refunds.reduce((s, r) => s + (r.share_milli == null ? 1000 : Number(r.share_milli)), 0)) };
}
