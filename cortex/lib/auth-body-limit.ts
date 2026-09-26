/**
 * BORNE DU CORPS sur /api/auth/* — le seul chemin d'écriture PUBLIC (avant
 * login) qui ne passe pas par withBodyLimit : le gestionnaire NextAuth lit le
 * corps lui-même. Un formulaire de connexion tient en quelques centaines
 * d'octets ; on refuse au proxy, avant que quoi que ce soit ne soit lu.
 */
export const AUTH_BODY_MAX_BYTES = 64 * 1024;

type MinimalReq = { method: string; pathname: string; headers: Headers };

export function authBodyLimit(req: MinimalReq): { status: 400 | 411 | 413; error: string } | null {
  if (!req.pathname.startsWith("/api/auth/")) return null;
  if (!["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) return null;
  const raw = req.headers.get("content-length");
  if (raw === null) {
    const te = req.headers.get("transfer-encoding");
    if (te && /chunked/i.test(te)) return { status: 411, error: "Longueur du corps requise." };
    return null; // aucun corps annoncé : rien à borner
  }
  if (!/^\d{1,15}$/.test(raw.trim())) return { status: 400, error: "En-tête Content-Length invalide." };
  if (Number(raw) > AUTH_BODY_MAX_BYTES) return { status: 413, error: `Corps trop volumineux pour l’authentification (max ${AUTH_BODY_MAX_BYTES / 1024} Kio).` };
  return null;
}
