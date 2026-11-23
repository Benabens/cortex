import { NextRequest, NextResponse } from "next/server";
import { mathHtmlBatch } from "@/lib/math-html";
import { MATH_MAX_CHARS, MATH_MAX_TEXTS, MATH_MAX_TOTAL_CHARS } from "@/lib/math-limits";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {texts: string[]} → {html: (string | null)[]} : le texte du modèle avec ses formules
 * composées côté serveur (lib/math-html), dans l'ordre reçu ; null = rien à composer. Sans état ni
 * données : le client (components/ui/MathText) renvoie le texte qu'il affiche déjà.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const b = await readJson(req, {}, 400_000);
  const texts: unknown[] = Array.isArray(b?.texts) ? b.texts.slice(0, MATH_MAX_TEXTS) : [];
  let total = 0;
  const kept = texts.map((t) => {
    if (typeof t !== "string" || t.length > MATH_MAX_CHARS || (total += t.length) > MATH_MAX_TOTAL_CHARS) return "";
    return t;
  });
  const html = mathHtmlBatch(kept).map((h, i) => (kept[i] ? h : null));
  return NextResponse.json({ html }, { headers: { "Cache-Control": "no-store" } });
});
