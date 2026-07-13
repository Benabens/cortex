import { getComposition } from "@/lib/composer";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** V9 — GET : la composition proposée (lue du format détecté du cours courant). */
export async function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json({ plan: await getComposition() });
}
