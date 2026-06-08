import { generateExam, generateExamViaClaudeCode } from "@/lib/exam";
import { ClaudeCodeError } from "@/lib/claude-code";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    // Dry-run = stub local (sans IA). Sinon : génération via Claude Code (abonnement Max, gratuit).
    const res = dry ? await generateExam({ dry: true }) : await generateExamViaClaudeCode();
    return NextResponse.json({ ok: true, ...res });
  } catch (e: unknown) {
    const err = e as ClaudeCodeError;
    const msg = err?.message ?? String(e);
    if (err?.code === "UNAVAILABLE") {
      return NextResponse.json({ error: msg, code: err.code }, { status: 503 });
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
