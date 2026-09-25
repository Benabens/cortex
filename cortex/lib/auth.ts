import NextAuth from "next-auth";
import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from "next-auth/adapters";
import crypto from "node:crypto";
import { authGet, authRun } from "@/db/auth-store";
import { authProviders } from "@/lib/auth-providers";

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
export { emailLoginConfigured, googleLoginConfigured } from "@/lib/auth-providers";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: cortexAdapter(),
  session: { strategy: "jwt" },
  trustHost: true,
  // Pages sur mesure (DA sombre de la landing) au lieu des pages NextAuth par défaut.
  pages: { signIn: "/login", error: "/login" },
  providers: authProviders(),
  callbacks: {
    /**
     * INVITE-ONLY (lancement fermé) : INVITE_ONLY=1 → seuls les e-mails de
     * l'allowlist INVITE_EMAILS (séparés par des virgules ; une entrée
     * commençant par « @ » autorise tout le domaine, ex. @epfl.ch) peuvent se
     * connecter/s'inscrire. Magic-link : le callback est appelé dès la DEMANDE
     * de lien → un non-invité ne reçoit même pas d'e-mail.
     */
    signIn({ user, profile }) {
      if (process.env.INVITE_ONLY !== "1") return true;
      const addr = (user?.email ?? (profile?.email as string) ?? "").trim().toLowerCase();
      if (!addr) return false;
      const allow = (process.env.INVITE_EMAILS ?? "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allow.some((a) => (a.startsWith("@") ? addr.endsWith(a) : a === addr));
    },
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = String(token.uid);
      return session;
    },
  },
});
