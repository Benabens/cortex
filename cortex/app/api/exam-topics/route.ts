import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { apiError } from "@/lib/i18n/api-error";
import { freeToolEnabled, freeToolLimits } from "@/lib/exam-topics/config";
import { processRun, sweepStaleUploads, uploadsRoot } from "@/lib/exam-topics/analyze";
import { admitRun, releaseRun } from "@/lib/exam-topics/runs";
import { validateUploads } from "@/lib/exam-topics/upload";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Outil gratuit, sans compte : dépôt de 1 à 3 annales PDF. Fichiers contrôlés AVANT
 * l'admission (quota, plafonds), puis analyse en arrière-plan ; le visiteur suit
 * GET /api/exam-topics/<id>. Réponses : `{ id }` (202), sinon apiError (code `exam_topics_*`).
 */
const REFUSALS = {
  closed: ["exam_topics_closed", 503],
  daily_budget: ["exam_topics_daily_budget", 503],
  busy: ["exam_topics_busy", 503],
  ip_day: ["exam_topics_ip_day", 429],
} as const;
const UPLOAD_REFUSALS = {
  no_file: ["exam_topics_no_file", 400],
  too_many_files: ["exam_topics_too_many_files", 400],
  file_too_large: ["exam_topics_file_too_large", 413],
  not_pdf: ["exam_topics_not_pdf", 400],
  too_many_pages: ["exam_topics_too_many_pages", 400],
} as const;

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const POST = withBodyLimit(async function POST(req: Request) {
  if (!freeToolEnabled()) return apiError(req, "exam_topics_not_found", 404);
  void sweepStaleUploads();
  const form = await readFormData(req, UPLOAD_LIMITS.examTopics);
  // Champ piège, invisible pour un humain : un robot qui remplit tout est refusé sans rien lancer.
  if (String(form.get("website") ?? "").trim()) return apiError(req, "exam_topics_invalid", 400);
  const lang = form.get("lang") === "fr" ? "fr" : "en";
  const files: Uint8Array[] = [];
  for (const v of form.getAll("files")) if (typeof v !== "string") files.push(new Uint8Array(await v.arrayBuffer()));
  const refusal = await validateUploads(files);
  if (refusal) {
    const limits = freeToolLimits();
    const params = { max: refusal === "too_many_pages" ? limits.maxPagesPerFile : limits.maxFiles, maxMb: Math.round(limits.maxFileBytes / 1024 / 1024) };
    const [code, status] = UPLOAD_REFUSALS[refusal];
    return apiError(req, { code, params }, status);
  }

  const verdict = await admitRun({ ip: clientIp(req.headers) });
  if (!verdict.ok) return apiError(req, REFUSALS[verdict.reason][0], REFUSALS[verdict.reason][1]);

  const dir = path.join(uploadsRoot(), verdict.id);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    files.forEach((f, i) => fs.writeFileSync(path.join(dir, `${i}.pdf`), f, { mode: 0o600 }));
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    await releaseRun(verdict.id);
    return apiError(req, "exam_topics_internal", 500);
  }
  void processRun(verdict.id, dir, lang);
  return json({ id: verdict.id }, 202);
});
