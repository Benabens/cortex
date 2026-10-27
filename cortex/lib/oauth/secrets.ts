import crypto from "node:crypto";

/**
 * SECRETS OPAQUES (jetons, codes, tickets) : 32 octets aléatoires, préfixés pour
 * qu'une fuite dans un log soit reconnaissable (et filtrable). Seule l'empreinte
 * SHA-256 est stockée : une lecture de la base ne donne aucun jeton utilisable.
 */
export type SecretKind = "at" | "rt" | "code" | "req" | "cs" | "quote";

export function newSecret(kind: SecretKind): string {
  return `cx_${kind}_${crypto.randomBytes(32).toString("base64url")}`;
}

export function digest(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** Identifiant non secret (client DCR, autorisation) : 16 octets suffisent à l'unicité. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

/** PKCE S256 (RFC 7636 §4.6) : BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Comparaison à temps constant de deux chaînes (secrets clients, défis PKCE). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
