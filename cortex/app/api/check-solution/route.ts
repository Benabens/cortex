import { checkSolution } from "@/lib/check-solution";
import { LlmError } from "@/lib/llm";
import { useCourseOr404 } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";
import { logLoopRoute } from "@/lib/req-log";
import { uploadsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 220;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "check-solution", t0);
  }
})

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const ct = req.headers.get("content-type") ?? "";
  let statement = "";
  let answer = "";
  let imageRel: string | null = null;

  if (ct.includes("multipart/form-data")) {
    // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
    const storage = await checkStorage(currentUser(), declaredBytes(req));
    if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
    const form = await readFormData(req, UPLOAD_LIMITS.image);
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
    const body = await readJson(req, ({}));
    statement = String(body.statement ?? "").trim();
    answer = String(body.answer ?? "").trim();
  }

  if (!statement) return NextResponse.json({ error: "Énoncé manquant." }, { status: 400 });
  const tooLong = fieldTooLong("statement", statement) ?? fieldTooLong("answer", answer);
  if (tooLong) return tooLong;
  if (!answer && !imageRel) return NextResponse.json({ error: "Donne ta réponse (texte ou photo)." }, { status: 400 });

  try {
    // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
    // l'appel au modèle, APRÈS validation de la demande : 0,1 crédit, non remboursé.
    const { assistCall } = await import("@/lib/billing/reserve");
    const result = await assistCall("check-solution", () => checkSolution({ statement, answer, imageRel }));
    return NextResponse.json({ ok: true, result });
  } catch (e: unknown) {
    const { AssistRefused } = await import("@/lib/billing/reserve");
    if (e instanceof AssistRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    const err = e as LlmError;
    const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" || err.code === "QUOTA" || err.code === "CREDITS" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
