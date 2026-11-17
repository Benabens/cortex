import { generateExamViaClaudeCode, type StepCb } from "@/lib/exam";
import { planMockExam, requestedFormat, resolveExamFormat, type ExamKind } from "@/lib/exam-format";

/**
 * EXAMEN BLANC — point d'entrée unique du job « exam » (app, connecteur MCP).
 * Le format du cours décide du générateur (lib/exam-format) : QCM (et mixte)
 * → architecte QCM ; questions composées → générateur de blocs (lib/blocks) ;
 * exercices, essai, oral → générateur d'exercices, avec les archétypes de la
 * discipline. Le focus n'est qu'un accent thématique.
 */
/** `produced` / `requested` : questions livrées sur questions demandées, quand le générateur les compte. */
export type MockExamResult = { id: number; url: string; texError?: string; produced?: number; requested?: number };

export async function generateMockExam(opts: {
  count?: number; focus?: string; kind?: ExamKind | null; onStep?: StepCb; jobId?: number;
  onExamReady?: (examId: number, order?: { requested: number }) => void | Promise<void>; phaseMs?: Record<string, number>;
  /** Prix payé pour ce job (centièmes) : un format QCM n'en produit pas plus que ce qu'il couvre (audit fuites I4). */
  paidCenti?: number;
} = {}): Promise<MockExamResult> {
  const step = opts.onStep ?? (() => {});
  // Un format demandé pour cet examen (cible du job) l'emporte sur celui du cours, sauf annales.
  const format = requestedFormat(await resolveExamFormat(), opts.kind);
  const plan = planMockExam(format, { count: opts.count, focus: opts.focus });
  if (plan.generator === "none") throw new Error(plan.reason);
  step(`Format : ${format.summary}`, 3);
  if (plan.generator === "qcm") {
    const { generateQcmExam } = await import("@/lib/qcm");
    const { jobCheckpointStore, qcmCompositionFor } = await import("@/lib/jobs");
    const checkpoint = typeof opts.jobId === "number" ? jobCheckpointStore(opts.jobId) : undefined;
    // Job « exam » tarifé au forfait : la route et le connecteur lancent un job qcm pour un format QCM ;
    // ce cas reste pour un format changé après le devis, ramené à ce que le prix payé couvre.
    const fit = opts.paidCenti === undefined ? { count: plan.qcmCount, open: plan.openCount } : qcmCompositionFor(opts.paidCenti, plan.qcmCount, plan.openCount);
    if (fit.count !== plan.qcmCount || fit.open !== plan.openCount) step(`Composition ramenée au prix de l'examen : ${fit.count} QCM${fit.open ? ` + ${fit.open} ouverte(s)` : ""}`, 3);
    const r = await generateQcmExam({ count: fit.count, openCount: fit.open, focus: opts.focus, onStep: step, onExamReady: opts.onExamReady, phaseMs: opts.phaseMs, checkpoint });
    return { id: r.id, url: `/mock/${r.id}`, texError: r.texError, produced: r.count + r.open, requested: r.requested + r.openRequested };
  }
  if (plan.generator === "blocks") {
    const { generateBlockExam } = await import("@/lib/blocks");
    const r = await generateBlockExam(plan, { focus: opts.focus, onStep: step, onExamReady: opts.onExamReady, phaseMs: opts.phaseMs });
    return { id: r.id, url: `/mock/${r.id}`, texError: r.texError, produced: r.count, requested: r.requested };
  }
  // Exercices : sans nombre demandé, le plan du cours décide (comportement historique, CS-202 compris).
  return generateExamViaClaudeCode({ count: plan.exerciseCount ?? undefined, focus: opts.focus, onStep: step, jobId: opts.jobId });
}
