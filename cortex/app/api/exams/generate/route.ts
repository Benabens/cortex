import { generateExam } from "@/lib/exam";
import { requireCourse } from "@/lib/req";
import { ReservationRefused, activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { NextRequest, NextResponse } from "next/server";
import { fieldTooLong } from "@/lib/field-limits";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { dryRunAllowed } from "@/lib/boot-guards";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Génération d'examen : crée un JOB en arrière-plan et retourne immédiatement {jobId}.
 * Le worker détaché (scripts/run-job.ts) fait le travail (lots + vérif + compile) et survit
 * à la requête / au reload. L'UI poll /api/jobs/:id. (dry-run = stub local synchrone.)
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  // Outil de développement : refusé en déploiement gardé (cf. lib/boot-guards
  // dryRunAllowed) — il écrirait un examen et lancerait tectonic sans débit.
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (dry && !(await dryRunAllowed(process.env, currentUser()))) {
    return NextResponse.json({ error: "Route inconnue." }, { status: 404 });
  }
  if (dry) {
    try {
      const res = await generateExam({ dry: true });
      return NextResponse.json({ ok: true, ...res });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
    }
  }

  // composeur (CS-202) : count = nombre d'exercices choisi (optionnel ; défaut = blueprint).
  // Focus = « Mets l'accent sur… » (générique, supporté PARTOUT) — 1-2 exos ciblés.
  // Validé AVANT tout travail : un sujet trop long est refusé, jamais tronqué en
  // silence — sinon l'étudiant paie une génération à l'intention amputée.
  const body = await readJson(req, ({} as any));
  const count = Number(body?.count) > 0 ? Math.min(12, Math.floor(Number(body.count))) : undefined;
  const focusRaw = typeof body?.focus === "string" ? body.focus.trim() : "";
  const tooLong = fieldTooLong("focus", focusRaw);
  if (tooLong) return tooLong;
  const focus = focusRaw || undefined;
  const target = count || focus ? JSON.stringify({ count, focus }) : undefined;

  const existing = await activeJob("exam");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // pré-checks AVANT de lancer le worker : fournisseur LLM + corpus + moteur LaTeX
  const issue = await preflightGeneration("exam");
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });
  let jobId: number;
  try {
    ({ id: jobId } = await createJobExclusive("exam", target));
  } catch (e) {
    if (e instanceof ReservationRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
})
