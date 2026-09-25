import { q } from "@/db/q";
import { completeVia, type LlmImage } from "@/lib/llm";
import { updateWeaknessAnalysis } from "@/lib/weaknesses";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { currentCourse } from "@/db/client";
import { courseLabel } from "@/lib/courses";
import { uploadsDir } from "@/lib/paths";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

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

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "weakness-analyze", t0);
  }
}

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  // Appel LLM INLINE → quota d'assistance par user/jour
  // (DAILY_ASSIST_QUOTA, no-op sans env), compté à la tentative.
  {
    const { assistGate } = await import("@/lib/billing/reserve");
    // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE avant
    // l'appel au modèle : 0,1 crédit — l'assistance n'est plus gratuite.
    const gate = await assistGate("weakness-analyze");
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  const { id } = await req.json().catch(() => ({ id: null }));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });

  const w = await q.get<{ topic: string; description: string | null; screenshot_path: string | null }>(
    "SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?",
    Number(id)
  );
  if (!w) return NextResponse.json({ error: "faiblesse introuvable" }, { status: 404 });

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
    if (fs.existsSync(abs) && MEDIA[ext]) {
      images.push({ mediaType: MEDIA[ext], base64: fs.readFileSync(abs).toString("base64") });
    }
  }

  let parsed: { topic: string; concepts: string[]; explanation: string };
  try {
    // Voie « API payante » explicite (bouton historique) → provider anthropic forcé
    // ('opus' → claude-opus-4-8, ex-GEN_MODEL).
    const res = await completeVia("anthropic", {
      prompt,
      images,
      model: "opus",
      maxTokens: 2000,
      json: { schema: SCHEMA as unknown as object },
    });
    parsed = JSON.parse(res.text || "{}");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 400 : 502;
    return NextResponse.json({ error: msg }, { status });
  }

  const description = `${parsed.explanation}\n\nConcepts clés : ${parsed.concepts.join(" · ")}`;
  await updateWeaknessAnalysis(Number(id), parsed.topic, description);

  return NextResponse.json({ ok: true, topic: parsed.topic, concepts: parsed.concepts, explanation: parsed.explanation });
}
