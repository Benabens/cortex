import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/db/context";
import { authEnabled } from "@/lib/auth";
import { ExportBusy, ExportTooLarge, streamAccountExport } from "@/lib/account-export";
import { log } from "@/lib/metrics";
import { useUser } from "@/lib/req";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/export — archive tar.gz des données de l'UTILISATEUR AUTHENTIFIÉ.
 * Self-only : la cible est toujours `currentUser()` (l'en-tête x-cortex-user est
 * posé par le proxy après validation de session, jamais lu du client).
 */
export async function GET(req: NextRequest) {
  if (!authEnabled()) {
    return NextResponse.json({ error: "L'export de compte requiert l'authentification." }, { status: 403 });
  }
  if (!req.headers.get("x-cortex-user")) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  useUser(req);
  const userId = currentUser();
  try {
    const { body, filename } = await streamAccountExport(userId);
    log("info", "account.exported", { user: userId });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ExportTooLarge || e instanceof ExportBusy) return NextResponse.json({ error: e.message }, { status: e.status });
    log("error", "account.export_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return NextResponse.json({ error: "L'export a échoué. Réessaie ; si le problème persiste, contacte le support." }, { status: 500 });
  }
}
