import { renderPrometheus, snapshot } from "@/lib/metrics";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/metrics — métriques d'instance. PROTÉGÉ par un token
 * (METRICS_TOKEN) : bearer OU ?token=. Sans token configuré, l'endpoint est
 * refusé (401) par défaut — pas d'exposition accidentelle.
 * Format Prometheus texte par défaut, JSON avec ?format=json.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.METRICS_TOKEN;
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.nextUrl.searchParams.get("token");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "métriques protégées (METRICS_TOKEN requis)" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json(snapshot());
  }
  return new NextResponse(renderPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4" } });
}
