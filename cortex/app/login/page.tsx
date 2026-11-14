import { e2eTestLoginConfigured, emailLoginConfigured, googleLoginConfigured } from "@/lib/auth";
import { contactEmail } from "@/lib/contact";
import { DEFAULT_LANDING_URL, LANDING_ENGLISH_PATH, landingOrigin, legalLinks } from "@/lib/legal";
import { LoginCard } from "./LoginCard";

// Inter pour l’interface, Funnel Display uniquement pour le logo.
export const dynamic = "force-dynamic";

/**
 * Page de connexion : surfaces de l'app (fond D2 en sombre ; suit le thème clair
 * via les jetons --bare-* de globals.css), un seul chemin
 * « Continuer avec Google ». Sert AUSSI de page d'erreur (NextAuth y renvoie via
 * ?error=CODE) : plus jamais la page NextAuth par défaut hors DA.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = pick(sp.error) ?? null;
  const callbackUrl = pick(sp.callbackUrl) ?? "/";

  return (
    <LoginCard
      error={error}
      callbackUrl={callbackUrl}
      google={googleLoginConfigured()}
      email={emailLoginConfigured()}
      e2eTest={e2eTestLoginConfigured()}
      legal={legalLinks()}
      landing={landingOrigin() ?? DEFAULT_LANDING_URL}
      english={`${landingOrigin() ?? DEFAULT_LANDING_URL}${LANDING_ENGLISH_PATH}`}
      contact={contactEmail()}
    />
  );
}
