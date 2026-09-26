import { authRun } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { nowStr } from "@/db/q";
import { termsVersion } from "@/lib/legal";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/terms {version} — trace l'acceptation des CGV par
 * l'utilisateur connecté (version + date). Seule la version COURANTE vaut
 * acceptation ; rejouer ne crée pas de doublon. Exigée avant le premier achat.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  const body = (await readJson(req, {})) as { version?: unknown };
  const version = String(body.version ?? "").trim();
  if (!version || version !== termsVersion()) {
    return NextResponse.json({ error: `Version des conditions inattendue (courante : ${termsVersion()}).` }, { status: 400 });
  }
  await authRun(
    `INSERT INTO terms_acceptances (user_id, version, accepted_at) VALUES (?,?,?) ON CONFLICT (user_id, version) DO NOTHING`,
    currentUser(), version, nowStr(),
  );
  return NextResponse.json({ ok: true, version });
});
