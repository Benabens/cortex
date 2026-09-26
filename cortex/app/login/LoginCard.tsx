"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Wordmark } from "@/components/shell/Logo";

/** Landing (privacy / terms). Surchargeable via NEXT_PUBLIC_LANDING_URL. */
const LANDING = process.env.NEXT_PUBLIC_LANDING_URL ?? "https://cortex-landing-seven.vercel.app";

/** Messages clairs par code d'erreur NextAuth (cause + quoi faire). */
function errorMessage(code: string): string {
  switch (code) {
    case "AccessDenied":
      return "Accès refusé. Ce compte n’est pas autorisé à se connecter pour l’instant.";
    case "Verification":
      return "Ce lien de connexion a expiré ou a déjà été utilisé. Reconnecte-toi pour en recevoir un nouveau.";
    case "OAuthAccountNotLinked":
      return "Cette adresse est déjà liée à une autre méthode de connexion. Utilise celle d’origine.";
    case "Configuration":
      return "La connexion est momentanément indisponible. Réessaie dans un instant.";
    default:
      return "La connexion a échoué. Réessaie ; si le problème persiste, reviens plus tard.";
  }
}

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function LoginCard({
  error,
  callbackUrl,
  google,
  email,
  legal,
}: {
  error: string | null;
  callbackUrl: string;
  google: boolean;
  email: boolean;
  /** Liens légaux (LEGAL_*_URL) ; repli sur la landing s'ils ne sont pas posés. */
  legal?: { terms: string | null; privacy: string | null; refund?: string | null; notice?: string | null };
}) {
  const termsHref = legal?.terms ?? `${LANDING}/terms`;
  const privacyHref = legal?.privacy ?? `${LANDING}/privacy`;
  const [busy, setBusy] = useState<null | "google" | "email">(null);
  const [addr, setAddr] = useState("");

  return (
    <main
      style={{ background: "#0b0b0f", color: "#f4f2fb" }}
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="w-full max-w-[22rem]">
        <div className="flex justify-center">
          <Wordmark markSize={30} />
        </div>

        <h1 className="mt-8 text-center text-[1.35rem] font-semibold tracking-tight">
          Connexion à Cortex
        </h1>
        <p className="mt-2 text-center text-[0.88rem] leading-relaxed" style={{ color: "#a5a2b3" }}>
          Révise ce qui tombe vraiment.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg px-4 py-3 text-[0.83rem] leading-relaxed"
            style={{ background: "rgba(234,67,53,0.10)", border: "1px solid rgba(234,67,53,0.35)", color: "#f7b6ae" }}
          >
            {errorMessage(error)}
          </div>
        )}

        <div className="mt-7 flex flex-col gap-3">
          {google && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy("google");
                void signIn("google", { callbackUrl });
              }}
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-lg border text-[0.92rem] font-medium transition-[background,opacity] duration-150 disabled:opacity-60"
              style={{ background: "#ffffff", color: "#1f1f24", borderColor: "rgba(255,255,255,0.14)" }}
            >
              <GoogleGlyph />
              {busy === "google" ? "Redirection…" : "Continuer avec Google"}
            </button>
          )}

          {email && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!addr.trim()) return;
                setBusy("email");
                void signIn("email", { email: addr.trim(), callbackUrl });
              }}
              className="flex flex-col gap-2"
            >
              <div className="my-1 flex items-center gap-3 text-[0.72rem]" style={{ color: "#6f6c7d" }}>
                <span className="h-px flex-1" style={{ background: "rgba(255,255,255,0.10)" }} />
                ou
                <span className="h-px flex-1" style={{ background: "rgba(255,255,255,0.10)" }} />
              </div>
              <input
                type="email"
                required
                autoComplete="email"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="ton@email.com"
                className="h-12 w-full rounded-lg border px-3.5 text-[0.9rem] outline-none"
                style={{ background: "#141419", color: "#f4f2fb", borderColor: "rgba(255,255,255,0.14)" }}
              />
              <button
                type="submit"
                disabled={busy !== null}
                className="inline-flex h-12 w-full items-center justify-center rounded-lg text-[0.92rem] font-semibold text-white transition-[filter,opacity] duration-150 hover:brightness-110 disabled:opacity-60"
                style={{ background: "#8b7bff" }}
              >
                {busy === "email" ? "Envoi…" : "Recevoir un lien de connexion"}
              </button>
            </form>
          )}

          {!google && !email && (
            <p className="text-center text-[0.83rem]" style={{ color: "#a5a2b3" }}>
              Aucune méthode de connexion n’est configurée. Réessaie plus tard.
            </p>
          )}
        </div>

        <p className="mt-8 text-center text-[0.75rem] leading-relaxed" style={{ color: "#6f6c7d" }}>
          En continuant, tu acceptes nos{" "}
          <a href={termsHref} className="underline underline-offset-2" style={{ color: "#a5a2b3" }}>
            conditions
          </a>{" "}
          et notre{" "}
          <a href={privacyHref} className="underline underline-offset-2" style={{ color: "#a5a2b3" }}>
            politique de confidentialité
          </a>
          .
        </p>
      </div>
    </main>
  );
}
