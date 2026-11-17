import { apiError } from "@/lib/i18n/api-error";
import { UserFacingError } from "@/lib/i18n/user-error";
import { NextRequest, NextResponse } from "next/server";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { currentUser } from "@/db/context";
import { authEnabled } from "@/lib/auth";
import { deleteAccount, isOwnerAccount } from "@/lib/account-deletion";
import { contactEmail } from "@/lib/contact";
import { log } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mot de confirmation attendu dans le corps (saisi par l'utilisateur). */
const CONFIRM_WORD = "SUPPRIMER";

/**
 * POST /api/account/delete — supprime le compte de l'UTILISATEUR AUTHENTIFIÉ.
 *
 * Garde-fous :
 *  - méthode non-GET (POST) ;
 *  - authentification obligatoire : le proxy pose `x-cortex-user` APRÈS
 *    validation de session (et strippe tout en-tête entrant) → sa présence
 *    prouve la session ; sans auth activée, il n'y a pas de compte à supprimer ;
 *  - un utilisateur ne peut supprimer que SON compte : la cible est toujours
 *    `currentUser()` (aucun paramètre de compte cible n'existe) ;
 *  - CSRF : cookie de session SameSite + refus de toute Origin croisée ;
 *  - confirmation forte : le corps doit contenir le mot exact ;
 *  - le compte propriétaire de l'instance ne peut pas s'auto-supprimer.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  if (!authEnabled()) {
    return apiError(req, "account_delete_auth_required", 403);
  }
  const headerUser = req.headers.get("x-cortex-user");
  if (!headerUser) {
    return apiError(req, "unauthenticated", 401);
  }
  // CSRF : n'accepter que le même origine (le cookie de session est SameSite ;
  // on refuse en plus toute Origin croisée si l'en-tête est présent).
  const origin = req.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.nextUrl.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return apiError(req, "origin_forbidden", 403);
    }
  }

  // Aucun cours en jeu : on n'installe QUE l'utilisateur (useCourse exigerait un
  // cours possédé et répondrait 404 à un compte sans matière).
  useUser(req);
  const userId = currentUser();

  const body = (await readJson(req, {})) as { confirm?: unknown };
  if (String(body?.confirm ?? "") !== CONFIRM_WORD) {
    return apiError(req, { code: "account_delete_confirm_missing", params: { word: CONFIRM_WORD } }, 400);
  }

  if (await isOwnerAccount(userId)) {
    return apiError(req, "account_delete_owner_refused", 403);
  }

  try {
    const res = await deleteAccount(userId);
    return NextResponse.json({ ok: true, residues: res.errors.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "account.delete_route_failed", { message: message.slice(0, 200) });
    if (e instanceof UserFacingError) return apiError(req, e, 500);
    return apiError(req, { code: "account_delete_failed", params: { contact: contactEmail() } }, 500);
  }
});
