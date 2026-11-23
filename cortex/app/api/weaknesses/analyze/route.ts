// i18n-allow-file: consignes et schéma envoyés au modèle (le texte destiné à l’étudiant vient de messages/*.json)
import { apiError } from "@/lib/i18n/api-error";
import { q } from "@/db/q";
import { completeVia, LlmError, llmUserError, type LlmImage } from "@/lib/llm";
import { UserFacingError } from "@/lib/i18n/user-error";
import { updateWeaknessAnalysis } from "@/lib/weaknesses";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { currentCourse } from "@/db/client";
import { courseLabel } from "@/lib/courses";
import { uploadsDir } from "@/lib/paths";
import path from "node:path";
import { storage } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MEDIA: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "Sujet court et précis de la faiblesse (max 8 mots)" },
    concepts: {
      type: "array",
      items: { type: "string" },
      description: "Concepts précis du cours mal maîtrisés",
    },
    explanation: {
      type: "string",
      description: "Explication structurée de la faiblesse de compréhension + ce qu'il faut revoir",
    },
  },
  required: ["topic", "concepts", "explanation"],
  additionalProperties: false,
} as const;

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "weakness-analyze", t0);
  }
})

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await readJson(req, ({ id: null }));
  if (!id) return apiError(req, "id_missing", 400);

  const w = await q.get<{ topic: string; description: string | null; screenshot_path: string | null }>(
    "SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?",
    Number(id)
  );
  if (!w) return apiError(req, "weakness_not_found", 404);

  // Construit le message (texte + image éventuelle) — le cours est dérivé du
  // cours ACTIF (useCourse ci-dessus), jamais codé en dur.
  const prompt =
    `Je suis étudiant en ${courseLabel(currentCourse())}. Voici un exercice/une question sur lequel j'ai eu une faiblesse de compréhension.\n` +
    `Sujet noté : « ${w.topic} »\n` +
    (w.description ? `Ma note : « ${w.description} »\n` : "") +
    `\nAnalyse ma faiblesse de compréhension : identifie le sujet précis, les concepts du cours que je maîtrise mal, ` +
    `et explique clairement ce que je n'ai pas compris et ce que je dois revoir. Réponds en français, de façon dense et actionnable.`;

  const images: LlmImage[] = [];
  if (w.screenshot_path) {
    const abs = path.join(uploadsDir(), path.basename(w.screenshot_path));
    const ext = w.screenshot_path.split(".").pop()?.toLowerCase() ?? "png";
    const buf = MEDIA[ext] ? await storage().read(abs) : null;
    if (buf) images.push({ mediaType: MEDIA[ext], base64: buf.toString("base64") });
  }

  let parsed: { topic: string; concepts: string[]; explanation: string };
  try {
    // Voie « API payante » explicite (bouton historique) → provider anthropic forcé.
    // Lire une capture et la classer est mécanique : Sonnet (lib/llm/config, classement des sites).
    // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
    // l'appel au modèle, APRÈS validation de la demande : 0,3 crédit, rendu seulement si
    // l'appel n'est pas parti ou si la réponse est inutilisable (lib/billing/reserve).
    const { assistCall } = await import("@/lib/billing/reserve");
    const res = await assistCall("weakness-analyze", () => completeVia("anthropic", {
      prompt,
      images,
      model: "sonnet",
      maxTokens: 2000,
      json: { schema: SCHEMA as unknown as object },
    }));
    parsed = JSON.parse(res.text || "{}");
  } catch (e: unknown) {
    const { AssistRefused } = await import("@/lib/billing/reserve");
    if (e instanceof AssistRefused) return apiError(req, e, e.status);
    const err = e as { message?: unknown; code?: unknown };
    const msg = String(err.message ?? e);
    const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" ? 503 : msg.includes("ANTHROPIC_API_KEY") ? 400 : 502;
    if (e instanceof UserFacingError) return apiError(req, e, status);
    if (e instanceof LlmError) return apiError(req, llmUserError(e), status);
    return apiError(req, { code: "weakness_analysis_failed", params: { detail: msg } }, status);
  }

  const description = `${parsed.explanation}\n\nConcepts clés : ${parsed.concepts.join(" · ")}`;
  await updateWeaknessAnalysis(Number(id), parsed.topic, description);

  return NextResponse.json({ ok: true, topic: parsed.topic, concepts: parsed.concepts, explanation: parsed.explanation });
}
