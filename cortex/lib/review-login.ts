import crypto from "node:crypto";
import { CredentialsSignin } from "next-auth";
import { authGet, authRun } from "@/db/auth-store";
import { isOwner } from "@/lib/billing/owner";
import { clientIp } from "@/lib/client-ip";
import { log } from "@/lib/metrics";

/**
 * CONNEXION RELECTEUR — e-mail + mot de passe, réservée au compte démo que les
 * relecteurs des annuaires de connecteurs (Claude, ChatGPT) reçoivent. ChatGPT
 * exige un identifiant et un mot de passe utilisables tels quels : ni lien
 * magique, ni code par e-mail, ni double authentification, ni inscription.
 *
 * Fermée par défaut. Ouverte seulement si REVIEW_LOGIN_EMAIL et
 * REVIEW_LOGIN_PASSWORD_HASH sont posées (et, si REVIEW_LOGIN_UNTIL l'est, avant
 * cette date) ; sinon aucun fournisseur n'est déclaré, aucun champ affiché.
 *
 *  - Un SEUL compte : toute autre adresse est refusée, même avec le bon mot de
 *    passe. Ce chemin ne crée jamais d'autre compte que celui-là.
 *  - Jamais propriétaire : une adresse ou un compte CORTEX_OWNER_* est refusé
 *    (le relecteur doit voir le devis puis la confirmation, comme un client).
 *  - Hash scrypt (crypto natif, aucune dépendance), comparaison à temps
 *    constant. Le mot de passe est toujours dérivé, même pour une mauvaise
 *    adresse : la durée de la réponse ne dit pas laquelle des deux est fausse.
 *  - Limite de débit stricte, par IP et globale (en mémoire : conteneur unique,
 *    comme la limite de bordure du proxy). Derrière Railway, TRUST_PROXY=1 est
 *    nécessaire pour compter par IP ; sans lui, tous les essais partagent la
 *    même clé et la limite par IP devient globale.
 *  - Journal sans mot de passe ni adresse saisie : la raison du refus et l'IP.
 *  - Couper (variables retirées, date passée) ferme aussi les sessions déjà
 *    ouvertes par ce chemin (lib/auth, rappel jwt).
 */

export const REVIEW_PROVIDER_ID = "review";

/** Essais par IP et essais tous clients confondus, sur la fenêtre glissante. */
export const REVIEW_WINDOW_MS = 15 * 60_000;
export const REVIEW_MAX_PER_IP = 5;
export const REVIEW_MAX_GLOBAL = 30;

/** Paramètres de dérivation : N = 2^15, r = 8, p = 1 (≈ 32 Mio, ≈ 100 ms). */
const DEFAULT_LOG_N = 15;
const KEY_LEN = 32;
const PASSWORD_MAX = 256;

type ScryptParams = { logN: number; r: number; p: number; salt: Buffer; hash: Buffer };

function b64u(b: Buffer): string {
  return b.toString("base64url");
}

/**
 * Format : `scrypt:<log2 N>:<r>:<p>:<sel>:<empreinte>` (base64url). Deux-points et
 * non « $ » : Next lit les fichiers .env avec expansion des variables, et
 * `$15` y deviendrait une chaîne vide.
 */
export function parseReviewHash(encoded: string | undefined): ScryptParams | null {
  const parts = (encoded ?? "").trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  // Bornes : une valeur posée à la main ne doit pas faire dériver des Gio par essai.
  if (!Number.isInteger(logN) || logN < 14 || logN > 20) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length < 16 || hash.length < 32 || hash.length > 64) return null;
  return { logN, r, p, salt, hash };
}

function derive(password: string, k: Omit<ScryptParams, "hash">, keyLen: number): Promise<Buffer> {
  const N = 2 ** k.logN;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), k.salt, keyLen, { N, r: k.r, p: k.p, maxmem: 256 * N * k.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Hash d'un mot de passe pour REVIEW_LOGIN_PASSWORD_HASH (scripts/review-password-hash.ts). */
export async function hashReviewPassword(password: string, logN = DEFAULT_LOG_N): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, { logN, r: 8, p: 1, salt }, KEY_LEN);
  return ["scrypt", logN, 8, 1, b64u(salt), b64u(key)].join(":");
}

/** Vrai si `password` correspond au hash. Hash illisible → faux, sans lever. */
export async function verifyReviewPassword(password: string, encoded: string): Promise<boolean> {
  const k = parseReviewHash(encoded);
  if (!k) return false;
  const key = await derive(password, k, k.hash.length);
  return crypto.timingSafeEqual(key, k.hash);
}

const normEmail = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** Égalité à temps constant de deux adresses (par leurs empreintes, de même longueur). */
function sameEmail(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length > 0;
}

export type ReviewLoginConfig = { email: string; hash: string; until: Date | null };

/**
 * Configuration en vigueur, ou null (fermée). Toute valeur douteuse ferme :
 * hash illisible, date illisible, adresse du propriétaire.
 */
export function reviewLoginConfig(env: Partial<NodeJS.ProcessEnv> = process.env, now = new Date()): ReviewLoginConfig | null {
  const email = normEmail(env.REVIEW_LOGIN_EMAIL);
  const hash = (env.REVIEW_LOGIN_PASSWORD_HASH ?? "").trim();
  if (!email || !hash) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !parseReviewHash(hash)) return null;
  if (email === normEmail(env.CORTEX_OWNER_EMAIL)) return null;
  let until: Date | null = null;
  const rawUntil = (env.REVIEW_LOGIN_UNTIL ?? "").trim();
  if (rawUntil) {
    until = new Date(rawUntil);
    if (Number.isNaN(until.getTime()) || now >= until) return null;
  }
  return { email, hash, until };
}

/** Fournisseur déclaré au démarrage ? (variables posées et hash lisible, date non vérifiée). */
export function reviewLoginDeclared(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return reviewLoginConfig({ ...env, REVIEW_LOGIN_UNTIL: undefined }) !== null;
}

/** Connexion ouverte maintenant ? (page /login, sessions déjà ouvertes par ce chemin). */
export function reviewLoginActive(env: Partial<NodeJS.ProcessEnv> = process.env, now = new Date()): boolean {
  return reviewLoginConfig(env, now) !== null;
}

// ───────────────────────────── limite de débit ─────────────────────────────

const attempts = new Map<string, number[]>();
let globalAttempts: number[] = [];

/** Compte un essai s'il reste de la place pour cette IP ET globalement ; faux = refusé sans essayer. */
export function takeReviewAttempt(ip: string, now = Date.now()): boolean {
  const fresh = (list: number[]) => list.filter((t) => now - t < REVIEW_WINDOW_MS);
  globalAttempts = fresh(globalAttempts);
  const mine = fresh(attempts.get(ip) ?? []);
  if (mine.length >= REVIEW_MAX_PER_IP || globalAttempts.length >= REVIEW_MAX_GLOBAL) {
    attempts.set(ip, mine);
    return false;
  }
  mine.push(now);
  globalAttempts.push(now);
  attempts.set(ip, mine);
  // Mémoire bornée : on oublie d'abord les IP sans essai dans la fenêtre.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (!v.some((t) => now - t < REVIEW_WINDOW_MS)) attempts.delete(k);
  }
  return true;
}

/** (tests) remet la limite à zéro. */
export function resetReviewLoginLimiter(): void {
  attempts.clear();
  globalAttempts = [];
}

/** Trop d'essais : code lisible côté page (« réessaie dans 15 minutes »), sans rien dire du compte. */
export class ReviewRateLimited extends CredentialsSignin {
  code = "rate_limited";
}

// ───────────────────────────── vérification ─────────────────────────────

type ReviewUser = { id: string; email: string; name: string | null };

export const REVIEW_ACCOUNT_NAME = "Relecteur Cortex";

/** Compte démo : lu, ou créé avec cette seule adresse. */
export async function ensureReviewUser(email: string): Promise<ReviewUser> {
  const found = await authGet<ReviewUser>("SELECT id, email, name FROM users WHERE lower(email) = ?", email);
  if (found) return found;
  const id = crypto.randomUUID();
  await authRun(
    "INSERT INTO users (id, email, name, image, email_verified) VALUES (?,?,?,?,?)",
    id, email, REVIEW_ACCOUNT_NAME, null, new Date().toISOString(),
  );
  return { id, email, name: REVIEW_ACCOUNT_NAME };
}

/**
 * `authorize` du fournisseur Credentials : le compte démo, ou null (refus
 * générique « identifiants invalides »). Lève ReviewRateLimited au-delà de la limite.
 */
export async function authorizeReview(
  credentials: Partial<Record<string, unknown>> | undefined,
  request: Pick<Request, "headers"> | undefined,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<ReviewUser | null> {
  const ip = request ? clientIp(request.headers, env) : "direct";
  const cfg = reviewLoginConfig(env);
  if (!cfg) {
    log("warn", "auth.review_login_refused", { reason: "closed", ip });
    return null;
  }
  if (!takeReviewAttempt(ip)) {
    log("warn", "auth.review_login_refused", { reason: "rate_limited", ip });
    throw new ReviewRateLimited();
  }
  const email = normEmail(credentials?.email);
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  // Toujours dériver (même adresse fausse, même vide) : même durée de réponse.
  const passwordOk = password.length <= PASSWORD_MAX && (await verifyReviewPassword(password.slice(0, PASSWORD_MAX), cfg.hash));
  const emailOk = sameEmail(email, cfg.email);
  if (!emailOk || !passwordOk || !password) {
    log("warn", "auth.review_login_refused", { reason: emailOk ? "bad_password" : "bad_email", ip });
    return null;
  }
  const user = await ensureReviewUser(cfg.email);
  if (await isOwner(user.id, env)) {
    log("error", "auth.review_login_refused", { reason: "owner_account", ip });
    return null;
  }
  log("info", "auth.review_login_ok", { ip, user: user.id });
  return user;
}
