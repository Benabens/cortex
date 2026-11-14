import { renderPrometheus, snapshot } from "@/lib/metrics";
import { hasMetricsToken } from "@/lib/metrics-token";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/metrics — métriques d'instance. PROTÉGÉ par un token (METRICS_TOKEN),
 * accepté UNIQUEMENT en en-tête `Authorization: Bearer …` — en query string il
 * finirait dans les logs d'accès, l'historique et le Referer. Comparaison en
 * temps constant. Sans token configuré, l'endpoint est refusé (401) par défaut.
 * Format Prometheus texte par défaut, JSON avec ?format=json.
 */
export async function GET(req: NextRequest) {
  if (!hasMetricsToken(req)) {
    return NextResponse.json({ error: "métriques protégées (METRICS_TOKEN requis)" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json(snapshot());
  }
  return new NextResponse(renderPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4" } });
}
