import { ClaudeCodeError } from "@/lib/claude-code";
import { generateDrill } from "@/lib/drill";
import { useCourse } from "@/lib/req";
import { sqlite } from "@/db/client";
import { dueConcepts } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

export function GET(req: NextRequest) {
  useCourse(req);
  const weaknesses = (sqlite.prepare(`SELECT topic FROM weaknesses ORDER BY severity DESC LIMIT 12`).all() as { topic: string }[])
    .map((w) => w.topic)
    .filter((t) => t && t !== "(à analyser)");
  return NextResponse.json({ due: dueConcepts(15), weaknesses });
}

export async function POST(req: NextRequest) {
  useCourse(req);
  const { concept } = await req.json().catch(() => ({ concept: "" }));
  const c = String(concept ?? "").trim();
  if (!c) return NextResponse.json({ error: "concept manquant" }, { status: 400 });
  try {
    const drill = await generateDrill(c);
    return NextResponse.json({ ok: true, drill });
  } catch (e: unknown) {
    const err = e as ClaudeCodeError;
    const status = err.code === "UNAVAILABLE" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
