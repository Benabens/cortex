"use client"; // Les error boundaries doivent être des Client Components (Next App Router).

import { useEffect } from "react";
import { Wordmark } from "@/components/shell/Logo";
import { captureClientError } from "@/lib/observability-browser";

/**
 * Erreur de segment (route sous le layout racine), aux jetons de l'app : sombre
 * ou clair selon le thème choisi. Styles inline avec replis littéraux du sombre :
 * robuste même si le CSS global n'est pas chargé au moment du crash.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // Rattrapée par cette frontière, l'erreur n'atteint jamais window.onerror : on la signale ici.
    captureClientError(error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "48px 24px",
        color: "var(--color-ink-1, #f4f5f8)",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          background: "var(--color-surface-1, rgba(255,255,255,0.03))",
          border: "1px solid var(--color-line, rgba(255,255,255,0.09))",
          borderRadius: 16,
          padding: "32px 28px",
          boxShadow: "var(--card-shadow, none)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Wordmark markSize={24} textSize="1.15rem" />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 8px" }}>Une erreur est survenue</h1>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--color-ink-2, #bfc1c9)", margin: 0 }}>
          Quelque chose s’est mal passé de notre côté. Tu peux réessayer. Si ça
          persiste, reviens à l’accueil et relance ton action.
        </p>
        {error?.digest && (
          <p style={{ fontSize: 12, color: "var(--color-ink-3, #9295a0)", marginTop: 12, fontVariantNumeric: "tabular-nums" }}>
            réf. {error.digest}
          </p>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 22, flexWrap: "wrap" }}>
          <button
            onClick={() => reset()}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid transparent",
              borderRadius: 9999,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-on-primary, #111214)",
              background: "var(--color-primary, #ececee)",
            }}
          >
            Réessayer
          </button>
          <a
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 9999,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 550,
              color: "var(--color-ink-2, #bfc1c9)",
              border: "1px solid var(--color-line-strong, rgba(255,255,255,0.14))",
              textDecoration: "none",
            }}
          >
            Retour à l’accueil
          </a>
        </div>
      </div>
    </div>
  );
}
