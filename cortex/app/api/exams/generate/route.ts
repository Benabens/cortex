import { generateExam } from "@/lib/exam";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const res = await generateExam({ dry });
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 400 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
