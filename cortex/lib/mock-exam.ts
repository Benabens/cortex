import { generateExamViaClaudeCode, type StepCb } from "@/lib/exam";
import { planMockExam, resolveExamFormat } from "@/lib/exam-format";

/**
 * EXAMEN BLANC — point d'entrée unique du job « exam » (app, connecteur MCP).
 * Le format du cours décide du générateur (lib/exam-format) : QCM (et mixte)
 * → architecte QCM ; exercices, essai, oral → générateur d'exercices, avec les
 * archétypes de la discipline. Le focus n'est qu'un accent thématique.
 */
export type MockExamResult = { id: number; url: string; texError?: string };

export async function generateMockExam(opts: { count?: number; focus?: string; onStep?: StepCb; jobId?: number } = {}): Promise<MockExamResult> {
  const step = opts.onStep ?? (() => {});
  const format = await resolveExamFormat();
  const plan = planMockExam(format, { count: opts.count, focus: opts.focus });
  if (plan.generator === "none") throw new Error(plan.reason);
  step(`Format : ${format.summary}`, 3);
  if (plan.generator === "qcm") {
    const { generateQcmExam } = await import("@/lib/qcm");
    const r = await generateQcmExam({ count: plan.qcmCount, openCount: plan.openCount, focus: opts.focus, onStep: step });
    return { id: r.id, url: `/mock/${r.id}`, texError: r.texError };
  }
  // Exercices : sans nombre demandé, le plan du cours décide (comportement historique, CS-202 compris).
  return generateExamViaClaudeCode({ count: plan.exerciseCount ?? undefined, focus: opts.focus, onStep: step, jobId: opts.jobId });
}
