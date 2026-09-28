import { LlmError } from "@/lib/llm";
import { mineConversation } from "@/lib/conversation-mining";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { createWeakness, listWeaknesses } from "@/lib/weaknesses";
import { NextRequest, NextResponse } from "next/server";
import { UPLOAD_LIMITS, readFormData, readJson, withBodyLimit } from "@/lib/upload-limit";
import { FIELD_LIMITS, fieldTooLong } from "@/lib/field-limits";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { ATTACHMENT_MAX_BYTES, pdfText, saveAttachment, sniffAttachment } from "@/lib/weakness-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * Importer une DISCUSSION (ou un PDF) → faiblesses classées.
 * Analyse le texte (via le fournisseur LLM configuré), crée des faiblesses structurées (source='conversation',
 * thème, gravité, extrait), auto-liées au corpus du cours. Renvoie les faiblesses créées + la liste.
 *
 * Envoi multipart { file: PDF, text?: note, severity? } : le texte du PDF, extrait sur le serveur, est
 * analysé exactement comme un texte collé. Un PDF sans couche texte (scan) n'est pas envoyé au moteur :
 * il rejoint le suivi tel quel, comme une capture (à analyser).
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "weakness-mine", t0);
  }
})

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  let t: string;
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    // Quota vérifié AVANT de lire l'envoi : un scan sans texte est stocké.
    const storage = await checkStorage(currentUser(), declaredBytes(req));
    if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
    const form = await readFormData(req, UPLOAD_LIMITS.image);
    const note = String(form.get("text") ?? "").trim();
    const noteTooLong = fieldTooLong("text", note);
    if (noteTooLong) return noteTooLong;
    const raw = form.get("file");
    if (!(raw instanceof File) || raw.size === 0) return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 400 });
    if (raw.size > ATTACHMENT_MAX_BYTES) return NextResponse.json({ error: "Fichier trop lourd (12 Mo au maximum)." }, { status: 413 });
    const buf = new Uint8Array(await raw.arrayBuffer());
    if (sniffAttachment(buf) !== "pdf") return NextResponse.json({ error: "Ce fichier n'est pas un PDF." }, { status: 415 });
    const extracted = await pdfText(buf, FIELD_LIMITS.text);
    if (extracted.length < 40) {
      const severity = Number(form.get("severity") ?? 2);
      await createWeakness({ topic: "(à analyser)", description: note, severity, screenshotPath: saveAttachment(buf, "pdf"), source: "pdf" });
      return NextResponse.json({
        created: 0,
        stored: true,
        weaknesses: await listWeaknesses(),
        note: "Ce PDF ne contient pas de texte lisible (scan ?) : il est ajouté au suivi tel quel.",
      });
    }
    // Note + texte du PDF, dans la limite analysée d'un texte collé (le PDF n'est pas conservé).
    t = [note, extracted].filter(Boolean).join("\n\n").slice(0, FIELD_LIMITS.text);
  } else {
    const { text } = await readJson(req, ({ text: "" }));
    t = String(text ?? "").trim();
    if (t.length < 40) return NextResponse.json({ error: "Colle une discussion (au moins quelques échanges)." }, { status: 400 });
    const tooLong = fieldTooLong("text", t);
    if (tooLong) return tooLong;
  }

  try {
    // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
    // l'appel au modèle, APRÈS validation de la demande : 0,1 crédit, non remboursé.
    const { assistCall } = await import("@/lib/billing/reserve");
    const mined = await assistCall("weakness-mine", () => mineConversation(t));
    if (!mined.length) return NextResponse.json({ created: 0, weaknesses: await listWeaknesses(), note: "Aucune faiblesse claire détectée dans cette discussion." });
    for (const m of mined) {
      await createWeakness({
        topic: m.topic,
        description: `${m.concept}${m.excerpt ? `\n\n« ${m.excerpt} »` : ""}`,
        severity: m.severity,
        source: "conversation",
        theme: m.theme,
        analyzed: true, // déjà structuré par l'IA
      });
    }
    return NextResponse.json({ created: mined.length, mined, weaknesses: await listWeaknesses() });
  } catch (e) {
    const { AssistRefused } = await import("@/lib/billing/reserve");
    if (e instanceof AssistRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof LlmError && e.code === "UNAVAILABLE") {
      return NextResponse.json({ error: "Le moteur LLM est injoignable : réessaie plus tard." }, { status: 503 });
    }
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
}
