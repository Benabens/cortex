/**
 * BORNE DU CORPS sur /api/auth/* — le seul chemin d'écriture PUBLIC (avant
 * login) qui ne passe pas par withBodyLimit : le gestionnaire NextAuth lit le
 * corps lui-même. Un formulaire de connexion tient en quelques centaines
 * d'octets ; on refuse au proxy, avant que quoi que ce soit ne soit lu.
 */
import { refusal, type Refusal } from "@/lib/i18n/user-error";

export const AUTH_BODY_MAX_BYTES = 64 * 1024;

type MinimalReq = { method: string; pathname: string; headers: Headers };

export function authBodyLimit(req: MinimalReq): Refusal<400 | 411 | 413> | null {
  if (!req.pathname.startsWith("/api/auth/")) return null;
  if (!["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) return null;
  const raw = req.headers.get("content-length");
  if (raw === null) {
    const te = req.headers.get("transfer-encoding");
    if (te && /chunked/i.test(te)) return refusal(411, "body_length_required");
    return null; // aucun corps annoncé : rien à borner
  }
  if (!/^\d{1,15}$/.test(raw.trim())) return refusal(400, "content_length_invalid");
  if (Number(raw) > AUTH_BODY_MAX_BYTES) return refusal(413, "auth_body_too_large", { maxKib: AUTH_BODY_MAX_BYTES / 1024 });
  return null;
}
