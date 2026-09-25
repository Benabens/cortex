import { renderPrometheus, snapshot } from "@/lib/metrics";
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Égalité en temps constant (les longueurs différentes sont refusées sans fuite d'information utile). */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * /api/metrics — métriques d'instance. PROTÉGÉ par un token (METRICS_TOKEN),
 * accepté UNIQUEMENT en en-tête `Authorization: Bearer …` — en query string il
 * finirait dans les logs d'accès, l'historique et le Referer. Comparaison en
 * temps constant. Sans token configuré, l'endpoint est refusé (401) par défaut.
 * Format Prometheus texte par défaut, JSON avec ?format=json.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.METRICS_TOKEN;
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : null;
  if (!expected || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: "métriques protégées (METRICS_TOKEN requis)" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json(snapshot());
  }
  return new NextResponse(renderPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4" } });
}
