import { runWithCourse } from "@/db/client";
import { ensureCoursesLoaded, courseLabel, listCoursesOf } from "@/lib/courses";
import { etaFields } from "@/lib/eta";
import { requestLocale } from "@/lib/i18n/api-error";
import { localizeJob } from "@/lib/i18n/job-text";
import { jobEta, listActiveJobs } from "@/lib/jobs";
import { redactMessage } from "@/lib/observability";
import { useUser } from "@/lib/req";
import { questionOfTarget } from "@/lib/ux/generation";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LES GÉNÉRATIONS EN COURS DU COMPTE, TOUS COURS CONFONDUS — la pastille de suivi : une génération
 * lancée sur un cours restait invisible depuis un autre (audit generation-ux du 24/11). Scopé au
 * compte : seuls ses cours sont lus. Étape, temps restant et erreur dans la langue du lecteur.
 */
export async function GET(req: NextRequest) {
  const user = useUser(req);
  await ensureCoursesLoaded();
  const locale = requestLocale(req);
  const out = [];
  for (const course of listCoursesOf(user)) {
    const jobs = await runWithCourse(course.id, () => listActiveJobs()).catch(() => []);
    for (const job of jobs) {
      const eta = await runWithCourse(course.id, () => jobEta(job)).catch(() => null);
      const redacted = { ...job, error: job.error ? redactMessage(job.error) : job.error, currentStep: job.currentStep ? redactMessage(job.currentStep) : job.currentStep };
      const text = localizeJob(redacted, eta, locale);
      out.push({
        id: job.id, course: course.id, courseLabel: courseLabel(course.id), type: job.type, status: job.status, progress: job.progress,
        currentStep: text.currentStep, stepInfo: job.stepInfo, eta: text.eta, ...etaFields(eta), createdAt: job.createdAt,
        // Correction lancée par l'app : la question corrigée (la pastille y ramène), jamais la cible entière.
        ...(job.type === "check" ? { question: questionOfTarget(job.target) } : {}),
      });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ jobs: out });
}
