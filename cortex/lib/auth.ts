import NextAuth from "next-auth";
import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from "next-auth/adapters";
import Google from "next-auth/providers/google";
import crypto from "node:crypto";
import { authGet, authRun } from "@/db/auth-store";

/**
 * AUTH (Phase B4) — Auth.js v5 (NextAuth), OPT-IN par AUTH_ENABLED=1.
 * Défaut (non posé) : AUCUNE auth — l'app tourne mono-user « owner » comme
 * historiquement (dev €0). Voir proxy.ts pour la garde des routes.
 *
 * - Sessions : JWT (cookie signé par AUTH_SECRET) — pas de table session.
 * - Providers : magic-link e-mail (le lien est LOGGÉ en console si aucun
 *   endpoint d'envoi n'est configuré — utilisable en dev sans SMTP) +
 *   Google OAuth si GOOGLE_CLIENT_ID/SECRET sont posés.
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

/** Envoi du magic-link : endpoint HTTP configurable, sinon LOG console (dev €0). */
async function sendMagicLink({ identifier, url }: { identifier: string; url: string }) {
  const endpoint = process.env.AUTH_EMAIL_ENDPOINT;
  if (endpoint) {
    // Endpoint générique (Resend, worker maison…) : POST {to, url}.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AUTH_EMAIL_TOKEN ? { authorization: `Bearer ${process.env.AUTH_EMAIL_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to: identifier, url, subject: "Connexion à Cortex" }),
    });
    if (!res.ok) throw new Error(`Envoi du magic-link échoué (HTTP ${res.status})`);
    return;
  }
  console.log(`\n🔐 [auth] Magic-link pour ${identifier} :\n   ${url}\n`);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: cortexAdapter(),
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [
    {
      id: "email",
      type: "email",
      name: "Magic link (e-mail)",
      from: process.env.AUTH_EMAIL_FROM ?? "cortex@localhost",
      maxAge: 24 * 3600,
      options: {},
      sendVerificationRequest: ({ identifier, url }) => sendMagicLink({ identifier, url }),
    },
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
  ],
  callbacks: {
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
