import { q } from "@/db/q";
import { useCourse } from "@/lib/req";
import { uploadsDir } from "@/lib/paths";
import { LlmError, completeText, extractJson } from "@/lib/llm";
import { getWeakness, updateWeaknessAnalysis } from "@/lib/weaknesses";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

type Analysis = { topic: string; concepts: string[]; explanation: string };

function buildPrompt(w: { topic: string; description: string | null; imageRel: string | null }): string {
  const lines: string[] = [
    `Tu aides un étudiant en Computer Systems (CS-202, EPFL) à structurer une faiblesse de révision.`,
  ];
  if (w.imageRel) {
    lines.push(
      `Lis l'image située à ${w.imageRel} avec l'outil Read. C'est soit un exercice d'examen qu'il a raté, soit un slide de cours qu'il ne maîtrise pas — déduis lequel.`
    );
  }
  const note = [w.topic && w.topic !== "(à analyser)" ? w.topic : "", w.description ?? ""].filter(Boolean).join(" — ");
  if (note) lines.push(`L'étudiant a écrit : « ${note} ».`);
  if (!w.imageRel && !note) lines.push(`(Aucun détail fourni : déduis une faiblesse plausible et générique du cours.)`);
  lines.push(
    ``,
    `Analyse sa faiblesse de compréhension. Réponds UNIQUEMENT avec un objet JSON valide, sans aucune prose autour, sans balises markdown, avec EXACTEMENT ces clés :`,
    `{"topic": string (sujet précis, max ~8 mots), "concepts": string[] (3 à 5 concepts précis du cours mal maîtrisés), "explanation": string (2 à 4 phrases denses : ce qu'il n'a pas compris et ce qu'il doit revoir)}`
  );
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  useCourse(req);
  // Déploiement v1 : appel LLM INLINE → quota d'assistance par user/jour
  // (DAILY_ASSIST_QUOTA, no-op sans env), compté à la tentative.
  {
    const { generationGate, recordGeneration } = await import("@/lib/billing/guards");
    const gate = await generationGate("assist");
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
    await recordGeneration("assist", "weakness-process");
  }
  const { id, model } = await req.json().catch(() => ({ id: null }));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });

  const row = await q.get<{ topic: string; description: string | null; screenshot_path: string | null }>(
    "SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?",
    Number(id)
  );
  if (!row) return NextResponse.json({ error: "faiblesse introuvable" }, { status: 404 });

  // Chemin image relatif au cwd (l'outil Read de Claude Code lit dans le projet).
  let imageRel: string | null = null;
  if (row.screenshot_path) {
    const abs = path.join(uploadsDir(), path.basename(row.screenshot_path));
    if (fs.existsSync(abs)) imageRel = `${path.relative(process.cwd(), uploadsDir())}/${path.basename(row.screenshot_path)}`;
  }

  try {
    const text = await completeText({
      prompt: buildPrompt({ topic: row.topic, description: row.description, imageRel }),
      model: typeof model === "string" && model ? model : "opus",
      timeoutMs: 190_000,
    });
    const parsed = extractJson<Analysis>(text);
    if (!parsed?.topic || !Array.isArray(parsed.concepts)) {
      throw new Error("Réponse IA incomplète.");
    }
    const description = `${parsed.explanation}\n\nConcepts clés : ${parsed.concepts.join(" · ")}`;
    await updateWeaknessAnalysis(Number(id), parsed.topic, description);
    return NextResponse.json({ ok: true, weakness: await getWeakness(Number(id)) });
  } catch (e: unknown) {
    const err = e as LlmError;
    const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" || err.code === "QUOTA" || err.code === "CREDITS" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
