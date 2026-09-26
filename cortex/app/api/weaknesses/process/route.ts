import { q } from "@/db/q";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { currentCourse } from "@/db/client";
import { courseLabel } from "@/lib/courses";
import { uploadsDir } from "@/lib/paths";
import { LlmError, completeText, extractJson } from "@/lib/llm";
import { isLlmModel } from "@/lib/llm/config";
import { getWeakness, updateWeaknessAnalysis } from "@/lib/weaknesses";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

type Analysis = { topic: string; concepts: string[]; explanation: string };

function buildPrompt(w: { topic: string; description: string | null; imageRel: string | null }): string {
  const lines: string[] = [
    `Tu aides un étudiant en ${courseLabel(currentCourse())} à structurer une faiblesse de révision.`,
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

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "weakness-process", t0);
  }
})

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id, model } = await readJson(req, ({ id: null }));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  // Le client ne choisit qu'un ALIAS de la liste blanche (le serveur décide de
  // l'id réel et de son prix) ; un id complet contournerait LLM_ALLOW_OPUS.
  if (model !== undefined && model !== null && model !== "" && !isLlmModel(model)) {
    return NextResponse.json({ error: "Modèle inconnu : choisis opus, sonnet ou haiku." }, { status: 400 });
  }
  const chosenModel = isLlmModel(model) ? model : "opus";

  const row = await q.get<{ topic: string; description: string | null; screenshot_path: string | null }>(
    "SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?",
    Number(id)
  );
  if (!row) return NextResponse.json({ error: "faiblesse introuvable" }, { status: 404 });

  // Chemin image relatif au cwd (l'outil Read du provider CLI lit dans le projet).
  let imageRel: string | null = null;
  if (row.screenshot_path) {
    const abs = path.join(uploadsDir(), path.basename(row.screenshot_path));
    if (fs.existsSync(abs)) imageRel = `${path.relative(process.cwd(), uploadsDir())}/${path.basename(row.screenshot_path)}`;
  }

  try {
    // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
    // l'appel au modèle, APRÈS validation de la demande : 0,1 crédit, non remboursé.
    const { assistCall } = await import("@/lib/billing/reserve");
    const text = await assistCall("weakness-process", () => completeText({
      prompt: buildPrompt({ topic: row.topic, description: row.description, imageRel }),
      model: chosenModel,
      timeoutMs: 190_000,
    }));
    const parsed = extractJson<Analysis>(text);
    if (!parsed?.topic || !Array.isArray(parsed.concepts)) {
      throw new Error("Réponse IA incomplète.");
    }
    const description = `${parsed.explanation}\n\nConcepts clés : ${parsed.concepts.join(" · ")}`;
    await updateWeaknessAnalysis(Number(id), parsed.topic, description);
    return NextResponse.json({ ok: true, weakness: await getWeakness(Number(id)) });
  } catch (e: unknown) {
    const { AssistRefused } = await import("@/lib/billing/reserve");
    if (e instanceof AssistRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    const err = e as LlmError;
    const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" || err.code === "QUOTA" || err.code === "CREDITS" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
