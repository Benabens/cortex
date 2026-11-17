import { apiError } from "@/lib/i18n/api-error";
import { generateExam } from "@/lib/exam";
import { requireCourse } from "@/lib/req";
import { examCount, mockExamJob, startGenerationJob } from "@/lib/generation";
import { NextRequest, NextResponse } from "next/server";
import { fieldTooLong } from "@/lib/field-limits";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { dryRunAllowed } from "@/lib/boot-guards";
import { currentUser } from "@/db/context";
import { LlmError, llmUserError } from "@/lib/llm";
import { UserFacingError } from "@/lib/i18n/user-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Génération d'examen : crée un JOB en arrière-plan et retourne immédiatement {jobId}.
 * Le worker détaché (scripts/run-job.ts) fait le travail (lots + vérif + compile) et survit
 * à la requête / au reload. L'UI poll /api/jobs/:id. (dry-run = stub local synchrone.)
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { denied } = requireCourse(req);
  if (denied) return denied;
  // Outil de développement : refusé en déploiement gardé (cf. lib/boot-guards
  // dryRunAllowed) — il écrirait un examen et lancerait tectonic sans débit.
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (dry && !(await dryRunAllowed(process.env, currentUser()))) {
    return apiError(req, "route_unknown", 404);
  }
  if (dry) {
    try {
      const res = await generateExam({ dry: true });
      return NextResponse.json({ ok: true, ...res });
    } catch (e) {
      if (e instanceof UserFacingError) return apiError(req, e, 502);
      if (e instanceof LlmError) return apiError(req, llmUserError(e), 502);
      const detail = e instanceof Error ? e.message : String(e);
      return apiError(req, { code: "exam_generation_failed", params: { detail } }, 502);
    }
  }

  // composeur (CS-202) : count = nombre d'exercices choisi (optionnel ; défaut = blueprint).
  // Focus = « Mets l'accent sur… » (générique, supporté PARTOUT) — 1-2 exos ciblés.
  // Validé AVANT tout travail : un sujet trop long est refusé, jamais tronqué en
  // silence — sinon l'étudiant paie une génération à l'intention amputée.
  const body = await readJson(req, {});
  const count = examCount(body?.count);
  const focusRaw = typeof body?.focus === "string" ? body.focus.trim() : "";
  const tooLong = fieldTooLong(req, "focus", focusRaw);
  if (tooLong) return tooLong;
  const focus = focusRaw || undefined;

  // Même résolution que le connecteur MCP : un cours au format QCM lance un job qcm, à son prix (audit fuites I4).
  // Job actif réutilisé, pré-checks, réservation, worker : lib/generation (partagé avec le serveur MCP).
  const job = await mockExamJob({ count, focus });
  const started = await startGenerationJob(job.jobType, job.target);
  if (!started.ok) {
    return apiError(req, started, started.status, started.command ? { command: started.command } : undefined);
  }
  return NextResponse.json(started.existing ? { ok: true, jobId: started.jobId, existing: true } : { ok: true, jobId: started.jobId });
})
