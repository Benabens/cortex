import { search } from "@/lib/search";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ groups: [], total: 0 });
  const groups = search(q);
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  return NextResponse.json({ groups, total });
}
