import { apiError } from "@/lib/i18n/api-error";
import { NextRequest } from "next/server";
import { currentUser } from "@/db/context";
import { authEnabled } from "@/lib/auth";
import { ExportBusy, ExportTooLarge, streamAccountExport } from "@/lib/account-export";
import { contactEmail } from "@/lib/contact";
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
    return apiError(req, "account_export_auth_required", 403);
  }
  if (!req.headers.get("x-cortex-user")) return apiError(req, "unauthenticated", 401);
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
    if (e instanceof ExportTooLarge || e instanceof ExportBusy) return apiError(req, e, e.status);
    log("error", "account.export_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return apiError(req, { code: "account_export_failed", params: { email: contactEmail() } }, 500);
  }
}
