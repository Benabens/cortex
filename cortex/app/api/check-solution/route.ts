import { checkSolution } from "@/lib/check-solution";
import { LlmError } from "@/lib/llm";
import { useCourseOr404 } from "@/lib/req";
import { rejectOversizedBody, UPLOAD_LIMITS } from "@/lib/upload-limit";
import { logLoopRoute } from "@/lib/req-log";
import { uploadsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 220;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "check-solution", t0);
  }
}

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  // Appel LLM INLINE → quota d'assistance par user/jour
  // (DAILY_ASSIST_QUOTA, no-op sans env), compté à la tentative.
  {
    const { generationGate, recordGeneration } = await import("@/lib/billing/guards");
    const { creditsGate } = await import("@/lib/billing/credits");
    // Quota d'assistance ET solde : ces appels coûtent de l'argent au même
    // titre qu'une génération (sans ça, un solde à 0 pouvait encore consommer
    // l'API en boucle via drill/check-solution/analyse).
    const gate = (await generationGate("assist")) ?? (await creditsGate("assist"));
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
    await recordGeneration("assist", "check-solution");
  }
  const ct = req.headers.get("content-type") ?? "";
  let statement = "";
  let answer = "";
  let imageRel: string | null = null;

  if (ct.includes("multipart/form-data")) {
    const tooBig = rejectOversizedBody(req, UPLOAD_LIMITS.image);
    if (tooBig) return tooBig;
    const form = await req.formData();
    statement = String(form.get("statement") ?? "").trim();
    answer = String(form.get("answer") ?? "").trim();
    const file = form.get("image");
    if (file instanceof File && file.size > 0) {
      const ext = EXT[file.type] ?? "png";
      if (file.size > 12 * 1024 * 1024) return NextResponse.json({ error: "Image trop lourde (max 12 Mo)." }, { status: 400 });
      fs.mkdirSync(uploadsDir(), { recursive: true });
      const name = `${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir(), name), Buffer.from(await file.arrayBuffer()));
      // chemin RÉEL (scopé par utilisateur en multi-user), relatif au cwd
      imageRel = path.relative(process.cwd(), path.join(uploadsDir(), name));
    }
  } else {
    const body = await req.json().catch(() => ({}));
    statement = String(body.statement ?? "").trim();
    answer = String(body.answer ?? "").trim();
  }

  if (!statement) return NextResponse.json({ error: "Énoncé manquant." }, { status: 400 });
  if (!answer && !imageRel) return NextResponse.json({ error: "Donne ta réponse (texte ou photo)." }, { status: 400 });

  try {
    const result = await checkSolution({ statement, answer, imageRel });
    return NextResponse.json({ ok: true, result });
  } catch (e: unknown) {
    const err = e as LlmError;
    const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" || err.code === "QUOTA" || err.code === "CREDITS" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
