import NextAuth, { type NextAuthConfig } from "next-auth";
import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from "next-auth/adapters";
import crypto from "node:crypto";
import { authGet, authRun } from "@/db/auth-store";
import { authProviders } from "@/lib/auth-providers";
import { isDisposableEmail } from "@/lib/email-identity";
import { requestIp } from "@/lib/client-ip";
import { inviteAllows } from "@/lib/invite";
import { MAGIC_LINK_REFUSAL_CODE, takeMagicLinkSend } from "@/lib/magic-link-limits";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability-scrub";
import { REVIEW_PROVIDER_ID, reviewLoginActive } from "@/lib/review-login";

/**
 * AUTH — Auth.js v5 (NextAuth), OPT-IN par AUTH_ENABLED=1.
 * Défaut (non posé) : AUCUNE auth — l'app tourne mono-user « owner » comme
 * historiquement (dev €0). Voir proxy.ts pour la garde des routes.
 *
 * - Sessions : JWT (cookie signé par AUTH_SECRET) — pas de table session.
 * - Providers (lib/auth-providers) : Google OAuth si GOOGLE_CLIENT_ID/SECRET
 *   sont posés ; magic-link e-mail seulement si AUTH_EMAIL_ENABLED=1 (le lien
 *   est LOGGÉ en console hors prod si aucun envoi n'est configuré).
 * - Persistance users/accounts/tokens : db/auth-store (sqlite data/auth.db
 *   ou schéma public Postgres).
 */

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "1";
}

type UserRow = { id: string; email: string | null; name: string | null; image: string | null; email_verified: string | null };

function toAdapterUser(r: UserRow): AdapterUser {
  return {
    id: r.id,
    email: r.email ?? "",
    name: r.name,
    image: r.image,
    emailVerified: r.email_verified ? new Date(r.email_verified) : null,
  };
}

async function getUserById(id: string): Promise<AdapterUser | null> {
  const r = await authGet<UserRow>(`SELECT * FROM users WHERE id = ?`, id);
  return r ? toAdapterUser(r) : null;
}

/** Adapter minimal (JWT sessions → pas de méthodes session) sur le store portable.
 * ⚠ Auth.js DÉSTRUCTURE les méthodes (this perdu) → aucune méthode ne référence this. */
function cortexAdapter(): Adapter {
  return {
    async createUser(user) {
      const id = crypto.randomUUID();
      await authRun(
        `INSERT INTO users (id, email, name, image, email_verified) VALUES (?,?,?,?,?)`,
        id, user.email ?? null, user.name ?? null, user.image ?? null,
        user.emailVerified ? user.emailVerified.toISOString() : null
      );
      return (await getUserById(id))!;
    },
    getUser: getUserById,
    async getUserByEmail(email) {
      const r = await authGet<UserRow>(`SELECT * FROM users WHERE email = ?`, email);
      return r ? toAdapterUser(r) : null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const r = await authGet<UserRow>(
        `SELECT u.* FROM users u JOIN accounts a ON a.user_id = u.id
         WHERE a.provider = ? AND a.provider_account_id = ?`,
        provider, providerAccountId
      );
      return r ? toAdapterUser(r) : null;
    },
    async updateUser(user) {
      const existing = await authGet<UserRow>(`SELECT * FROM users WHERE id = ?`, user.id);
      if (!existing) throw new Error("updateUser : utilisateur inconnu");
      await authRun(
        `UPDATE users SET email = ?, name = ?, image = ?, email_verified = ? WHERE id = ?`,
        user.email ?? existing.email, user.name ?? existing.name, user.image ?? existing.image,
        user.emailVerified ? user.emailVerified.toISOString() : existing.email_verified, user.id
      );
      return (await getUserById(user.id))!;
    },
    async linkAccount(account: AdapterAccount) {
      await authRun(
        `INSERT INTO accounts (provider, provider_account_id, user_id, type, access_token, refresh_token, expires_at, token_type, scope, id_token)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (provider, provider_account_id) DO NOTHING`,
        account.provider, account.providerAccountId, account.userId, account.type,
        (account.access_token as string) ?? null, (account.refresh_token as string) ?? null,
        (account.expires_at as number) ?? null, (account.token_type as string) ?? null,
        (account.scope as string) ?? null, (account.id_token as string) ?? null
      );
      return account;
    },
    async createVerificationToken(vt: VerificationToken) {
      await authRun(
        `INSERT INTO verification_tokens (identifier, token, expires) VALUES (?,?,?)`,
        vt.identifier, vt.token, vt.expires.toISOString()
      );
      return vt;
    },
    async useVerificationToken({ identifier, token }) {
      const r = await authGet<{ identifier: string; token: string; expires: string }>(
        `SELECT * FROM verification_tokens WHERE identifier = ? AND token = ?`,
        identifier, token
      );
      if (!r) return null;
      await authRun(`DELETE FROM verification_tokens WHERE identifier = ? AND token = ?`, identifier, token);
      return { identifier: r.identifier, token: r.token, expires: new Date(r.expires) };
    },
  };
}

/** Disponibilité des méthodes de connexion (page /login) — source unique : lib/auth-providers. */
export { e2eTestLoginConfigured, emailLoginConfigured, googleLoginConfigured, reviewLoginConfigured } from "@/lib/auth-providers";


/** Code d'erreur de /login pour une inscription avec une adresse jetable (message dans app/login/LoginCard). */
const DISPOSABLE_REFUSAL_CODE = "EmailDisposable";

/**
 * AUDIT FUITES I8 — une adresse jetable ne crée pas de compte : chaque nouvelle
 * boîte serait une nouvelle personne pour l'offre gratuite (lib/billing/free-offer).
 * Un compte qui existe déjà avec une telle adresse se connecte toujours (refuser
 * l'enfermerait dehors avec ses crédits) ; il ne reçoit simplement pas l'offre.
 */
async function disposableSignup(address: string): Promise<boolean> {
  if (!address || !(await isDisposableEmail(address))) return false;
  const existing = await authGet<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower(?)`, address.trim());
  return !existing;
}

/** Rappels Auth.js (exportés pour les tests : invitation, coupure de la connexion relecteur). */
export const authCallbacks = {
  /**
   * Inscriptions ouvertes à tous, sauf lancement fermé (INVITE_ONLY=1 : seules
   * les adresses d'INVITE_EMAILS passent — cf. lib/invite). Magic-link : le
   * callback est appelé dès la DEMANDE de lien → un non-invité ne reçoit même
   * pas d'e-mail. Le compte démo des relecteurs (lib/review-login) passe : les
   * variables qui l'ouvrent valent invitation, et ce chemin ne crée que lui.
   *
   * Demande de lien (audit fuites B4) : comptée et bornée par adresse et par IP AVANT
   * l'envoi (lib/magic-link-limits) ; un refus renvoie vers /login avec son code.
   */
  async signIn({ user, profile, account, email }) {
    if (account?.provider === REVIEW_PROVIDER_ID) return true;
    const address = user?.email ?? (profile?.email as string | undefined) ?? "";
    if (!inviteAllows(address)) return false;
    if (await disposableSignup(address)) {
      log("info", "auth.disposable_refused", {});
      return `/login?error=${DISPOSABLE_REFUSAL_CODE}`;
    }
    if (email?.verificationRequest) {
      const verdict = await takeMagicLinkSend(user?.email ?? "", await requestIp());
      if (!verdict.ok) {
        log("warn", "auth.magic_link_limited", { reason: verdict.reason });
        return `/login?error=${MAGIC_LINK_REFUSAL_CODE[verdict.reason]}`;
      }
    }
    return true;
  },
  jwt({ token, user, account }) {
    if (user?.id) token.uid = user.id;
    if (account?.provider === REVIEW_PROVIDER_ID) token.review = true;
    // Connexion relecteur coupée (variables retirées, REVIEW_LOGIN_UNTIL passée) :
    // les sessions ouvertes par elle tombent aussi, sans attendre leurs 30 jours.
    if (token.review && !reviewLoginActive()) return null;
    return token;
  },
  session({ session, token }) {
    if (token.uid && session.user) session.user.id = String(token.uid);
    return session;
  },
} satisfies NextAuthConfig["callbacks"];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: cortexAdapter(),
  session: { strategy: "jwt" },
  trustHost: true,
  // Pages sur mesure (DA sombre de la landing) au lieu des pages NextAuth par défaut.
  pages: { signIn: "/login", error: "/login", verifyRequest: "/verify-request", signOut: "/signout" },
  providers: authProviders(),
  callbacks: authCallbacks,
  // Erreurs d'Auth.js dans le journal structuré (audit fuites I14) : sans logger, elles
  // n'allaient qu'à console.error, sans type. Message nettoyé (adresses, chemins).
  logger: {
    error(error) {
      log("warn", "auth.error", { type: (error as { type?: string }).type ?? error.name, message: redactMessage(error.message ?? "").slice(0, 300) });
    },
  },
});
