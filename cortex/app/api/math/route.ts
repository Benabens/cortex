import { NextRequest, NextResponse } from "next/server";
import { mathHtml } from "@/lib/math-html";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bornes d'un lot : une page d'examen tient largement dedans ; au-delà, le texte reste tel quel. */
const MAX_TEXTS = 300;
const MAX_CHARS = 20_000;

/**
 * POST {texts: string[]} → {html: (string | null)[]} : le texte du modèle avec ses formules
 * composées côté serveur (lib/math-html), dans l'ordre reçu ; null = rien à composer. Sans état ni
 * données : le client (components/ui/MathText) renvoie le texte qu'il affiche déjà.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const b = await readJson(req, {}, 2_000_000);
  const texts: unknown[] = Array.isArray(b?.texts) ? b.texts.slice(0, MAX_TEXTS) : [];
  const html = texts.map((t) => (typeof t === "string" && t.length <= MAX_CHARS ? mathHtml(t) : null));
  return NextResponse.json({ html }, { headers: { "Cache-Control": "no-store" } });
});
