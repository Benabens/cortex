import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";

/**
 * PROVIDERS D'AUTHENTIFICATION, dérivés de l'environnement.
 *
 *  - Google OAuth : dès que GOOGLE_CLIENT_ID/SECRET sont posés — la voie
 *    d'inscription du produit.
 *  - Lien magique par e-mail : OPT-IN par AUTH_EMAIL_ENABLED=1 ET transport
 *    configuré. Actif par défaut, c'était une seconde voie d'inscription et une
 *    source de spam (n'importe qui pouvait déclencher des envois vers n'importe
 *    quelle adresse).
 */
/**
 * Le lien magique n'est proposé que si (1) il est ACTIVÉ explicitement
 * (AUTH_EMAIL_ENABLED=1) ET (2) un transport d'envoi est configuré
 * (RESEND_API_KEY ou AUTH_EMAIL_ENDPOINT) : sans transport, le bouton serait
 * mort en prod et le lien finirait dans les logs — la règle la plus stricte
 * des deux gagne.
 */
export function emailLoginConfigured(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.AUTH_EMAIL_ENABLED === "1" && !!(env.RESEND_API_KEY || env.AUTH_EMAIL_ENDPOINT);
}

/** Google OAuth disponible ? (clés posées). */
export function googleLoginConfigured(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function authProviders(env: Partial<NodeJS.ProcessEnv> = process.env): Provider[] {
  const providers: Provider[] = [];
  if (emailLoginConfigured(env)) {
    providers.push({
      id: "email",
      type: "email",
      name: "Magic link (e-mail)",
      from: env.AUTH_EMAIL_FROM ?? "cortex@localhost",
      maxAge: 24 * 3600,
      options: {},
      sendVerificationRequest: ({ identifier, url }) => sendMagicLink({ identifier, url }),
    });
  }
  if (googleLoginConfigured(env)) {
    providers.push(Google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
  }
  return providers;
}

/** Envoi du magic-link : Resend natif (RESEND_API_KEY), sinon endpoint HTTP
 *  générique (AUTH_EMAIL_ENDPOINT), sinon LOG console (dev €0). */
export async function sendMagicLink({ identifier, url }: { identifier: string; url: string }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: process.env.AUTH_EMAIL_FROM ?? "Cortex <onboarding@resend.dev>",
        to: [identifier],
        subject: "Connexion à Cortex",
        html: `<p>Clique pour te connecter à Cortex :</p><p><a href="${url}">Se connecter</a></p><p style="color:#888">Si tu n'es pas à l'origine de cette demande, ignore ce message.</p>`,
      }),
    });
    if (!res.ok) throw new Error(`Envoi Resend échoué (HTTP ${res.status}) : ${(await res.text()).slice(0, 300)}`);
    return;
  }
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
  // Aucun transport configuré. Un magic-link est un JETON DE CONNEXION : on ne
  // l'écrit en clair QUE hors production (dev €0 : c'est ainsi qu'on se
  // connecte sans SMTP). En production, l'écrire dans les logs du conteneur
  // équivaudrait à publier des sessions → on échoue bruyamment.
  if (process.env.NODE_ENV === "production" && process.env.CORTEX_ALLOW_LOGGED_MAGIC_LINK !== "1") {
    throw new Error(
      "Aucun envoi d'e-mail configuré (RESEND_API_KEY ou AUTH_EMAIL_ENDPOINT). " +
      "Le magic-link ne sera PAS écrit dans les logs en production."
    );
  }
  console.log(`\n🔐 [auth] Magic-link pour ${identifier} :\n   ${url}\n`);
}

