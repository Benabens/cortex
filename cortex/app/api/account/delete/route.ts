import { NextRequest, NextResponse } from "next/server";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { currentUser } from "@/db/context";
import { authEnabled } from "@/lib/auth";
import { deleteAccount, isOwnerAccount } from "@/lib/account-deletion";
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
    return NextResponse.json({ error: "La suppression de compte requiert l'authentification." }, { status: 403 });
  }
  const headerUser = req.headers.get("x-cortex-user");
  if (!headerUser) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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
      return NextResponse.json({ error: "Origine non autorisée." }, { status: 403 });
    }
  }

  // Aucun cours en jeu : on n'installe QUE l'utilisateur (useCourse exigerait un
  // cours possédé et répondrait 404 à un compte sans matière).
  useUser(req);
  const userId = currentUser();

  const body = (await readJson(req, {})) as { confirm?: unknown };
  if (String(body?.confirm ?? "") !== CONFIRM_WORD) {
    return NextResponse.json(
      { error: `Confirmation manquante : tape « ${CONFIRM_WORD} » pour confirmer.` },
      { status: 400 },
    );
  }

  if (await isOwnerAccount(userId)) {
    return NextResponse.json(
      { error: "Le compte propriétaire de l'instance ne peut pas être supprimé depuis l'application." },
      { status: 403 },
    );
  }

  try {
    const res = await deleteAccount(userId);
    return NextResponse.json({ ok: true, residues: res.errors.length });
  } catch (e) {
    log("error", "account.delete_route_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return NextResponse.json(
      { error: "La suppression a échoué. Réessaie ; si le problème persiste, contacte le support." },
      { status: 500 },
    );
  }
});
