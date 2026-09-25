import { Geist } from "next/font/google";
import { emailLoginConfigured, googleLoginConfigured } from "@/lib/auth";
import { LoginCard } from "./LoginCard";

// Geist (police de la landing), scopée à cette page pour ne pas alourdir le reste.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });

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
    <div className={geist.variable} style={{ fontFamily: "var(--font-geist), system-ui, sans-serif" }}>
      <LoginCard
        error={error}
        callbackUrl={callbackUrl}
        google={googleLoginConfigured()}
        email={emailLoginConfigured()}
      />
    </div>
  );
}
