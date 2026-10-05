import { emailLoginConfigured, googleLoginConfigured } from "@/lib/auth";
import { contactEmail } from "@/lib/contact";
import { DEFAULT_LANDING_URL, landingOrigin, legalLinks } from "@/lib/legal";
import { LoginCard } from "./LoginCard";

// Police système + Funnel Display pour le titre, comme le reste de l'app (Geist retirée : liste interdite anti-slop).
export const dynamic = "force-dynamic";

/**
 * Page de connexion — DA sombre de la landing (fond #0b0b0f), un seul chemin
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
      legal={legalLinks()}
      landing={landingOrigin() ?? DEFAULT_LANDING_URL}
      contact={contactEmail()}
    />
  );
}
