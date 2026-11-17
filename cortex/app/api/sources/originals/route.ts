import { apiError } from "@/lib/i18n/api-error";
import { currentUser } from "@/db/context";
import { returnOriginal } from "@/lib/originals/intake";
import { localOriginal } from "@/lib/originals/registry";
import { originalsNotice } from "@/lib/originals/retention";
import { requireCourse } from "@/lib/req";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ORIGINAL RESTÉ SUR L'ORDINATEUR (compte gratuit, lib/originals).
 *  GET  ?p=<chemin du cours> : de quoi le retrouver sur l'ordinateur (nom, chemin d'origine,
 *       taille, empreinte) et l'offre du compte — la page /sources/locale l'ouvre en local.
 *  POST ?p=<chemin> (multipart `file`) : renvoi du MÊME fichier (empreinte vérifiée). Premium :
 *       il rejoint le cloud ; gratuit : il revient en transit, le temps d'une préparation qui
 *       relit ses pages (24 h au plus).
 */
export async function GET(req: NextRequest) {
  const { denied } = requireCourse(req);
  if (denied) return denied;
  const p = req.nextUrl.searchParams.get("p") ?? "";
  const row = p ? await localOriginal(p) : null;
  const notice = await originalsNotice(currentUser());
  if (!row) return apiError(req, "original_not_local", 404, { plan: notice });
  return NextResponse.json({
    original: { path: row.path, name: row.name, rel: row.rel, size: row.size, sha256: row.sha256, origin: row.origin, url: row.url, state: row.state },
    plan: notice,
  });
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return apiError(req, storage, storage.status);
  const p = req.nextUrl.searchParams.get("p") ?? "";
  if (!p) return apiError(req, "path_missing", 400);
  const form = await readFormData(req, UPLOAD_LIMITS.source);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return apiError(req, "no_file", 400);
  const r = await returnOriginal(course, p, Buffer.from(await file.arrayBuffer()));
  if (!r.ok) return apiError(req, r, r.status);
  return NextResponse.json({ ok: true, home: r.home });
});
