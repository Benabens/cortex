"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Wordmark } from "@/components/shell/Logo";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useLocale, useTranslations } from "use-intl/react";

/** Messages clairs par code d'erreur NextAuth (cause + quoi faire). */
function errorMessage(code: string, t: ReturnType<typeof useTranslations<"login">>): string {
  switch (code) {
    case "AccessDenied":
      return t("errorAccessDenied");
    case "Verification":
      return t("errorVerification");
    case "OAuthAccountNotLinked":
      return t("errorOAuthAccountNotLinked");
    case "CredentialsSignin":
      return t("errorCredentialsSignin");
    case "rate_limited":
      return t("errorRateLimited");
    case "EmailWait":
      return t("errorEmailWait");
    case "EmailDay":
      return t("errorEmailDay");
    case "EmailIp":
      return t("errorEmailIp");
    case "Configuration":
      return t("errorConfiguration");
    default:
      return t("errorDefault");
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
  e2eTest,
  review = false,
  legal,
  landing,
  english,
  contact,
}: {
  error: string | null;
  callbackUrl: string;
  google: boolean;
  email: boolean;
  e2eTest: boolean;
  /** Connexion par mot de passe du compte démo des relecteurs d'annuaires (lib/review-login). */
  review?: boolean;
  /** Liens légaux (LEGAL_*_URL ou vitrine déclarée) ; repli sur `landing` s'ils ne sont pas posés. */
  legal?: { terms: string | null; privacy: string | null; refund?: string | null; notice?: string | null };
  /** Origine de la vitrine, lue côté serveur à la requête (pas de variable figée au build). */
  landing: string;
  /** Traduction anglaise des documents légaux sur la vitrine (elle renvoie aux autres documents en anglais). */
  english: string;
  /** Adresse de contact (lib/contact). */
  contact: string;
}) {
  const t = useTranslations("login");
  // En anglais, les liens légaux mènent à leur traduction ; en français, aux documents qui font foi.
  const inEnglish = useLocale() === "en";
  const termsHref = inEnglish ? english : legal?.terms ?? `${landing}/terms`;
  const privacyHref = inEnglish ? english : legal?.privacy ?? `${landing}/privacy`;
  const noticeHref = inEnglish ? english : legal?.notice ?? `${landing}/mentions-legales`;
  const [busy, setBusy] = useState<null | "google" | "email" | "review">(null);
  const [addr, setAddr] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  return (
    <main
      style={{ background: "var(--bare-bg)", color: "var(--bare-ink)" }}
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="d2-card w-full max-w-[28rem] p-6 sm:p-9">
        <div className="flex justify-center">
          <Wordmark markSize={30} />
        </div>

        <h1 className="mt-8 text-center text-[1.8rem] font-semibold tracking-tight">
          {t("title")}
        </h1>
        <p className="mt-2 text-center text-[0.88rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
          {t("tagline")}
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg px-4 py-3 text-[0.83rem] leading-relaxed"
            style={{ background: "var(--bare-error-bg)", border: "1px solid var(--bare-error-line)", color: "var(--error-ink)" }}
          >
            {errorMessage(error, t)}
          </div>
        )}

        <div className="mt-7 flex flex-col gap-3">
          {e2eTest && (
            <button
              type="button"
              data-testid="e2e-login"
              disabled={busy !== null}
              onClick={() => {
                setBusy("email");
                const params = new URLSearchParams(window.location.search);
                const email = params.get("persona") ?? "alice@e2e.cortex.test";
                // Clé exigée par une preview de PR (lib/auth-providers, personaKeyAccepted) ; vide en local.
                void signIn("e2e-test", { email, key: params.get("persona_key") ?? "", callbackUrl });
              }}
              className="inline-flex h-12 w-full items-center justify-center rounded-full border border-dashed text-[0.92rem] font-semibold"
            >
              {t("e2eLogin")}
            </button>
          )}
          {google && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy("google");
                void signIn("google", { callbackUrl });
              }}
              // Couleurs en classes : un `style` inline l'emporterait sur le survol. En clair, le
              // bouton reste blanc bordé : le « G » multicolore ne se pose pas sur un aplat bleu.
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-full border border-[var(--bare-cta-line)] bg-[var(--bare-cta)] text-[0.92rem] font-semibold text-[var(--bare-cta-ink)] transition-[background-color,opacity] duration-150 enabled:hover:bg-[var(--bare-cta-hover)] enabled:active:bg-[var(--bare-cta-active)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <GoogleGlyph />
              {busy === "google" ? t("redirecting") : t("continueGoogle")}
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
              <div className="my-1 flex items-center gap-3 text-[0.72rem]" style={{ color: "var(--bare-faint)" }}>
                <span className="h-px flex-1" style={{ background: "var(--bare-line)" }} />
                {t("or")}
                <span className="h-px flex-1" style={{ background: "var(--bare-line)" }} />
              </div>
              <label htmlFor="login-email" className="text-[0.75rem] font-medium" style={{ color: "var(--bare-muted)" }}>
                {t("emailLabel")}
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder={t("emailPlaceholder")}
                className="h-12 w-full rounded-lg border px-3.5 text-[0.9rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-hi"
                style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
              />
              {/* Chemin secondaire : surface neutre bordée (le bouton clair reste Google, l'action principale). */}
              <button
                type="submit"
                disabled={busy !== null}
                className="inline-flex h-12 w-full items-center justify-center rounded-full border text-[0.92rem] font-medium transition-[background,opacity] duration-150 disabled:opacity-60"
                style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
              >
                {busy === "email" ? t("sending") : t("sendLink")}
              </button>
            </form>
          )}

          {review && reviewOpen && (
            <form
              data-testid="review-login"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                setBusy("review");
                setReviewError(null);
                // Sans redirection : une faute de frappe garde la page et son callbackUrl
                // (retour au consentement du connecteur MCP après la connexion).
                const res = await signIn("review", {
                  email: String(form.get("email") ?? "").trim(),
                  password: String(form.get("password") ?? ""),
                  redirect: false,
                  callbackUrl,
                });
                if (res?.ok && !res.error) {
                  window.location.assign(res.url ?? callbackUrl);
                  return;
                }
                setReviewError(errorMessage(res?.code === "rate_limited" ? "rate_limited" : "CredentialsSignin", t));
                setBusy(null);
              }}
              className="mt-1 flex flex-col gap-2"
            >
              <label className="text-[0.75rem] font-medium" style={{ color: "var(--bare-muted)" }} htmlFor="review-email">
                {t("emailLabel")}
              </label>
              <input
                id="review-email"
                name="email"
                type="email"
                required
                // Ouvert par un clic sur « Accès relecteur » : le focus suit, au clavier aussi.
                autoFocus
                autoComplete="username"
                className="h-12 w-full rounded-lg border px-3.5 text-[0.9rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-hi"
                style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
              />
              <label className="mt-1 text-[0.75rem] font-medium" style={{ color: "var(--bare-muted)" }} htmlFor="review-password">
                {t("passwordLabel")}
              </label>
              <input
                id="review-password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="h-12 w-full rounded-lg border px-3.5 text-[0.9rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-hi"
                style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
              />
              {reviewError && (
                <p role="alert" className="text-[0.8rem]" style={{ color: "var(--error-ink)" }}>
                  {reviewError}
                </p>
              )}
              <button
                type="submit"
                disabled={busy !== null}
                className="mt-1 inline-flex h-12 w-full items-center justify-center rounded-full border text-[0.92rem] font-medium transition-[background,opacity] duration-150 disabled:opacity-60"
                style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
              >
                {busy === "review" ? t("signingIn") : t("signIn")}
              </button>
            </form>
          )}

          {!google && !email && !e2eTest && !review && (
            <p className="text-center text-[0.83rem]" style={{ color: "var(--bare-muted)" }}>
              {t("noMethod")}
            </p>
          )}
        </div>

        <p className="mt-8 text-center text-[0.75rem] leading-relaxed" style={{ color: "var(--bare-faint)" }}>
          {t.rich("legal", {
            terms: (chunks) => <a href={termsHref} className="underline underline-offset-2" style={{ color: "var(--bare-muted)" }}>{chunks}</a>,
            privacy: (chunks) => <a href={privacyHref} className="underline underline-offset-2" style={{ color: "var(--bare-muted)" }}>{chunks}</a>,
          })}
        </p>
        <p className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-center text-[0.75rem]">
          <a href={noticeHref} className="underline underline-offset-2" style={{ color: "var(--bare-muted)" }}>
            {t("legalNotice")}
          </a>
          <a href={`mailto:${contact}`} className="underline underline-offset-2" style={{ color: "var(--bare-muted)" }}>
            {t("contact")}
          </a>
          {/* Discret : seuls les relecteurs des annuaires de connecteurs en ont l'usage. */}
          {review && !reviewOpen && (
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              className="underline underline-offset-2"
              style={{ color: "var(--bare-muted)" }}
            >
              {t("reviewerAccess")}
            </button>
          )}
        </p>
        {/* Avant connexion, le choix vit dans un cookie ; il est copié sur le compte à la première visite. */}
        <LocaleSwitcher persist={false} className="mt-5 flex flex-col items-center" />
      </div>
    </main>
  );
}
