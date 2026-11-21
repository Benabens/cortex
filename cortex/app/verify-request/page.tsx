import { VerifyRequestCard } from "./VerifyRequestCard";

export const dynamic = "force-dynamic";

/**
 * Page d'arrivée après « Recevoir un lien de connexion » (`pages.verifyRequest`, lib/auth)
 * — DA de /login au lieu de la page NextAuth par défaut, en anglais et sans style.
 */
export default async function VerifyRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const email = pick(sp.email) ?? null;
  const callbackUrl = pick(sp.callbackUrl) ?? "/";

  return <VerifyRequestCard email={email} callbackUrl={callbackUrl} />;
}
