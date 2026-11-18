"use client"; // Obligatoire (error boundary). global-error REMPLACE le layout racine.

import { useEffect, useState } from "react";
import "./typography.css";
import { THEME_STORAGE_KEY, LIGHT_QUERY, parseThemePref, resolveTheme } from "@/lib/ux/theme";
import { captureClientError } from "@/lib/observability-browser";
import { cookieValue, isLocale, LOCALE_COOKIE, negotiateLocale, type Locale } from "@/lib/i18n/locale";
import { MESSAGES } from "@/lib/i18n/messages";

// Palette autonome des deux thèmes (le CSS global peut être la cause du crash). Rendue comme
// enfant texte de <style> : aucun caractère que React échapperait (& < > " ').
const PALETTE = `
:root{color-scheme:dark;--ge-bg:#080c14;--ge-ink:#f4f5f8;--ge-muted:#bfc1c9;--ge-faint:#9295a0;--ge-card:rgba(255,255,255,0.03);--ge-line:rgba(255,255,255,0.09);--ge-shadow:0 8px 26px -6px rgba(0,0,0,0.6);--ge-cta:#ececee;--ge-cta-ink:#111214}
:root[data-theme=light]{color-scheme:light;--ge-bg:#f4f6fb;--ge-ink:#0f172a;--ge-muted:#334155;--ge-faint:#5f6b7e;--ge-card:#ffffff;--ge-line:#e6eaf2;--ge-shadow:0 1px 2px rgba(15,23,42,0.04),0 8px 24px -12px rgba(15,23,42,0.12);--ge-cta:#2764ec;--ge-cta-ink:#ffffff}`;

/**
 * Erreur CRITIQUE au niveau du layout racine : global-error remplace tout le
 * document, il doit donc rendre ses propres <html>/<body>. Styles inline et
 * palette littérale des deux thèmes : aucune dépendance au CSS global (qui peut
 * être la cause du crash). Le thème choisi (lib/ux/theme) est réappliqué au montage.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Le premier rendu reste identique serveur/client ; la préférence du navigateur prend
  // ensuite le relais sans dépendre du provider du layout, absent dans global-error.
  const [locale, setLocale] = useState<Locale>("en");
  const t = MESSAGES[locale].globalError;
  useEffect(() => {
    const cookie = cookieValue(document.cookie, LOCALE_COOKIE);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- global-error n'a pas de contexte serveur pour cette préférence client
    setLocale(isLocale(cookie) ? cookie : negotiateLocale(navigator.languages.join(",")) ?? "en");
  }, []);

  useEffect(() => {
    console.error(error);
    captureClientError(error);
  }, [error]);

  useEffect(() => {
    try {
      const pref = parseThemePref(localStorage.getItem(THEME_STORAGE_KEY));
      const system = window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
      document.documentElement.dataset.theme = resolveTheme(pref, system);
    } catch {
      // stockage bloqué : sombre par défaut
    }
  }, []);

  return (
    <html lang={locale}>
      <head>
        <style>{PALETTE}</style>
      </head>
      <body style={{ margin: 0 }}>
        <main
          style={{
            minHeight: "100dvh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "48px 24px",
            background: "var(--ge-bg)",
            color: "var(--ge-ink)",
            fontFamily: "'Cortex Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: 460,
              width: "100%",
              background: "var(--ge-card)",
              border: "1px solid var(--ge-line)",
              borderRadius: 16,
              padding: "32px 28px",
              boxShadow: "var(--ge-shadow)",
            }}
          >
            {/* Wordmark autonome : même Funnel Display, sous un alias local indépendant du layout. */}
            <div
              style={{
                fontFamily: "'Cortex Brand', sans-serif",
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "-0.04em",
                lineHeight: 1,
              }}
            >
              {/* i18n-allow: nom de marque */}
              cortex
              <span
                aria-hidden="true"
                style={{ display: "inline-block", width: "0.17em", height: "0.17em", marginLeft: "0.035em", borderRadius: "50%", background: "#2764ec" }}
              />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 8px" }}>{t.title}</h1>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ge-muted)", margin: 0 }}>
              {t.description}
            </p>
            {error?.digest && (
              <p style={{ fontSize: 12, color: "var(--ge-faint)", marginTop: 12, fontVariantNumeric: "tabular-nums" }}>
                {t.reference.replace("{digest}", error.digest)}
              </p>
            )}
            <div style={{ marginTop: 22 }}>
              <button
                onClick={() => reset()}
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  border: "1px solid transparent",
                  borderRadius: 9999,
                  padding: "10px 20px",
                  fontSize: 14,
                  fontFamily: "inherit",
                  fontWeight: 600,
                  color: "var(--ge-cta-ink)",
                  background: "var(--ge-cta)",
                }}
              >
                {t.reload}
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
