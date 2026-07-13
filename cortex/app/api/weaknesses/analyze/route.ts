import { q } from "@/db/q";
import { completeVia, type LlmImage } from "@/lib/llm";
import { updateWeaknessAnalysis } from "@/lib/weaknesses";
import { useCourse } from "@/lib/req";
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
  useCourse(req);
  const { id } = await req.json().catch(() => ({ id: null }));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });

  const w = await q.get<{ topic: string; description: string | null; screenshot_path: string | null }>(
    "SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?",
    Number(id)
  );
  if (!w) return NextResponse.json({ error: "faiblesse introuvable" }, { status: 404 });

  // Construit le message (texte + image éventuelle) — prompt inchangé, image AVANT le texte.
  const prompt =
    `Je suis étudiant en Computer Systems (CS202, EPFL). Voici un exercice/une question sur lequel j'ai eu une faiblesse de compréhension.\n` +
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
