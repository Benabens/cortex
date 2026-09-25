import { NextResponse } from "next/server";

/**
 * BORNE DES ENVOIS MULTIPART, AVANT LECTURE DU CORPS.
 *
 * `req.formData()` tamponne tout le corps en mémoire : un plafond vérifié sur
 * `file.size` après coup ne protège de rien — un seul client pouvait faire
 * tomber le conteneur unique. Content-Length est déclaratif, mais c'est la
 * seule borne disponible avant de lire ; sans lui, on ne lit pas un corps de
 * taille inconnue (411). Le plafond par fichier reste contrôlé après parsing.
 */

export const MiB = 1024 * 1024;

/** Plafonds par route (octets). Env : UPLOAD_MAX_MB relève/abaisse le défaut « refs ». */
export const UPLOAD_LIMITS = {
  /** Annales (plusieurs PDF par envoi). */
  refs: (Number(process.env.UPLOAD_MAX_MB) > 0 ? Number(process.env.UPLOAD_MAX_MB) : 64) * MiB,
  /** Un fichier de source (30 Mo max côté fichier) + enveloppe multipart. */
  source: 32 * MiB,
  /** Une photo (12 Mo max côté fichier) + champs texte. */
  image: 16 * MiB,
} as const;

/** À appeler AVANT `req.formData()`. Renvoie une réponse 411/413 à retourner telle quelle, sinon null. */
export function rejectOversizedBody(req: Request, maxBytes: number): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (raw == null || raw === "") {
    return NextResponse.json({ error: "Content-Length requis pour un envoi de fichier." }, { status: 411 });
  }
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) {
    return NextResponse.json({ error: "Content-Length invalide." }, { status: 400 });
  }
  if (declared > maxBytes) {
    return NextResponse.json(
      { error: `Envoi trop volumineux (${Math.round(declared / 1e6)} Mo, maximum ${Math.round(maxBytes / 1e6)} Mo).` },
      { status: 413 },
    );
  }
  return null;
}
