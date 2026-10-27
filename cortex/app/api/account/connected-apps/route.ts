import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/metrics";
import { listConnectedApps, revokeConnectedApp } from "@/lib/oauth/server";
import { useUser } from "@/lib/req";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * APPLICATIONS CONNECTÉES (connecteur MCP) du compte : liste et révocation.
 * Self-only : le compte est celui posé par le proxy après la session, jamais
 * un paramètre. Une autorisation d'un autre compte répond 404, comme une inconnue.
 */
export async function GET(req: NextRequest) {
  const userId = useUser(req);
  return NextResponse.json({ apps: await listConnectedApps(userId) }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const userId = useUser(req);
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id || !(await revokeConnectedApp(userId, id))) {
    return NextResponse.json({ error: "Application introuvable." }, { status: 404 });
  }
  log("info", "oauth.grant_revoked_by_user", {});
  return NextResponse.json({ ok: true });
}
