import crypto from "node:crypto";

/**
 * Compte démo du serveur e2e local (connexion relecteur, lib/review-login) :
 * adresse et mot de passe inventés pour le banc, hash calculé au démarrage.
 * Partagé par playwright.config.ts (variables du serveur) et la spec.
 */
export const REVIEW_E2E_EMAIL = "relecteur@review.cortex.test";
export const REVIEW_E2E_PASSWORD = "mot-de-passe-du-banc-e2e-relecteur";

/** Même format que lib/review-login (`scrypt:<log2 N>:<r>:<p>:<sel>:<empreinte>`). */
export function reviewE2eHash(): string {
  const salt = crypto.createHash("sha256").update("cortex-e2e-review-salt").digest().subarray(0, 16);
  const key = crypto.scryptSync(REVIEW_E2E_PASSWORD.normalize("NFKC"), salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 14, 8, 1, salt.toString("base64url"), key.toString("base64url")].join(":");
}
