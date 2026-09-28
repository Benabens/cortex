import { createWeakness, deleteWeakness, listWeaknesses, weaknessesByTheme } from "@/lib/weaknesses";
import { useCourseOr404 } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { uploadsDir } from "@/lib/paths";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { FIELD_LIMITS, fieldTooLong } from "@/lib/field-limits";
import { currentUser } from "@/db/context";
import { ATTACHMENT_FORMATS_LABEL, ATTACHMENT_MAX_BYTES, pdfText, saveAttachment, sniffAttachment } from "@/lib/weakness-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ weaknesses: await listWeaknesses(), byTheme: await weaknessesByTheme() });
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
  const form = await readFormData(req, UPLOAD_LIMITS.image);
  let topic = String(form.get("topic") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const severity = Number(form.get("severity") ?? 2);
  // Ces champs repartent tels quels vers le modèle (weaknesses/process, prix fixe) : plafonnés ici.
  const tooLong = fieldTooLong("topic", topic) ?? fieldTooLong("description", description);
  if (tooLong) return tooLong;

  let screenshotPath: string | null = null;
  let source = "manual";
  let note = description;
  // Pièce jointe : « file » (zone de dépôt unique), « screenshot » (ancien champ, toujours accepté).
  const raw = form.get("file") ?? form.get("screenshot");
  const file = raw instanceof File && raw.size > 0 ? raw : null;
  // Sujet optionnel : l'IA le déduira. Il faut au moins une pièce jointe OU une note.
  if (!topic && !description && !file) {
    return NextResponse.json({ error: "Colle un texte, une capture ou ajoute un fichier." }, { status: 400 });
  }
  if (!topic) topic = "(à analyser)";
  if (file) {
    if (file.size > ATTACHMENT_MAX_BYTES)
      return NextResponse.json({ error: "Fichier trop lourd (12 Mo au maximum)." }, { status: 413 });
    const buf = new Uint8Array(await file.arrayBuffer());
    const kind = sniffAttachment(buf);
    if (!kind) return NextResponse.json({ error: `Format non pris en charge : ${ATTACHMENT_FORMATS_LABEL}.` }, { status: 415 });
    screenshotPath = saveAttachment(buf, kind);
    source = kind === "pdf" ? "pdf" : "screenshot";
    // PDF : son texte rejoint la note (lisible dans la liste, relié au corpus, repris par l'analyse).
    if (kind === "pdf") {
      const text = await pdfText(buf, FIELD_LIMITS.description);
      note = [description, text].filter(Boolean).join("\n\n").slice(0, FIELD_LIMITS.description);
    }
  }

  const id = await createWeakness({ topic, description: note, severity, screenshotPath, source });
  return NextResponse.json({ id });
})

export async function DELETE(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  const screenshot = await deleteWeakness(id);
  if (screenshot) {
    const p = path.join(uploadsDir(), path.basename(screenshot));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return NextResponse.json({ ok: true });
}
