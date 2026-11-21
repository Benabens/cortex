"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Wordmark } from "@/components/shell/Logo";
import { loginErrorMessage } from "@/lib/i18n/login-errors";
import { useTranslations } from "use-intl/react";

/**
 * Page d'arrivée après « Recevoir un lien de connexion » (DA de /login) : NextAuth ne
 * transmet pas l'adresse à `pages.verifyRequest` (seulement `provider`/`type`) — LoginCard
 * nous l'a donnée par la query (`redirect: false` côté client, voir LoginCard.tsx). Sans
 * elle (lien direct, repli NextAuth), seul « changer d'adresse » reste possible.
 */
export function VerifyRequestCard({ email, callbackUrl }: { email: string | null; callbackUrl: string }) {
  const t = useTranslations("verifyRequest");
  const loginT = useTranslations("login");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    if (!email) return;
    setState("sending");
    setError(null);
    const res = await signIn("email", { email, callbackUrl, redirect: false }).catch(() => null);
    if (res?.ok && !res.error) {
      setState("sent");
      return;
    }
    setError(loginErrorMessage(res?.error ?? "unknown", loginT));
    setState("idle");
  }

  return (
    <main
      style={{ background: "var(--bare-bg)", color: "var(--bare-ink)" }}
      className="flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="d2-card w-full max-w-[28rem] p-6 sm:p-9">
        <div className="flex justify-center">
          <Wordmark markSize={30} />
        </div>

        <h1 className="mt-8 text-center text-[1.8rem] font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-center text-[0.88rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
          {email ? t("sentTo", { email }) : t("sentGeneric")}
        </p>
        <p className="mt-3 text-center text-[0.83rem] leading-relaxed" style={{ color: "var(--bare-faint)" }}>
          {t("spamHint")}
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg px-4 py-3 text-[0.83rem] leading-relaxed"
            style={{ background: "var(--bare-error-bg)", border: "1px solid var(--bare-error-line)", color: "var(--error-ink)" }}
          >
            {error}
          </div>
        )}
        {state === "sent" && (
          <p role="status" className="mt-6 text-center text-[0.83rem]" style={{ color: "var(--bare-muted)" }}>
            {t("resent")}
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3">
          {email && (
            <button
              type="button"
              disabled={state === "sending"}
              onClick={resend}
              className="inline-flex h-12 w-full items-center justify-center rounded-full border text-[0.92rem] font-medium transition-[background,opacity] duration-150 disabled:opacity-60"
              style={{ background: "var(--bare-surface)", color: "var(--bare-ink)", borderColor: "var(--bare-field-line)" }}
            >
              {state === "sending" ? t("resending") : t("resend")}
            </button>
          )}
          <Link
            href="/login"
            className="inline-flex h-12 w-full items-center justify-center rounded-full border border-transparent text-[0.88rem] font-medium underline underline-offset-2"
            style={{ color: "var(--bare-muted)" }}
          >
            {email ? t("changeAddress") : t("backToLogin")}
          </Link>
        </div>
      </div>
    </main>
  );
}
