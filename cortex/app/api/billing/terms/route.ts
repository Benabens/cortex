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
 * POST /api/billing/terms {version, withdrawal: true} — trace, pour la version
 * COURANTE des CGV, l'acceptation (date) ET l'accord exprès à l'exécution
 * immédiate avec reconnaissance de la perte du droit de rétractation (date) —
 * art. L221-28 13° du Code de la consommation : sans cet accord recueilli AVANT
 * le paiement, le droit de rétractation de 14 jours ne s'éteint pas quand les
 * crédits sont consommés. Les deux sont donc exigés ensemble ; un compte qui
 * avait accepté les CGV avant l'arrivée de cette case complète sa ligne.
 * Rejouer ne crée pas de doublon et ne réécrit aucune date.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  const body = (await readJson(req, {})) as { version?: unknown };
  const version = String(body.version ?? "").trim();
  if (!version || version !== termsVersion()) {
    return NextResponse.json({ error: `Version des conditions inattendue (courante : ${termsVersion()}).` }, { status: 400 });
  }
  const t = nowStr();
  await authRun(
    `INSERT INTO terms_acceptances (user_id, version, accepted_at) VALUES (?,?,?) ON CONFLICT (user_id, version) DO NOTHING`,
    currentUser(), version, t,
  );
  return NextResponse.json({ ok: true, version });
});
