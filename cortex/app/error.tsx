"use client"; // Les error boundaries doivent être des Client Components (Next App Router).

import { useEffect } from "react";
import { Wordmark } from "@/components/shell/Logo";

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
    // Journalise pour le suivi d'erreurs (futur branchement Sentry).
    console.error(error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "48px 24px",
        color: "var(--color-ink-1, #f4f2fb)",
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
          boxShadow: "var(--shadow-pop, 0 8px 26px -6px rgba(0,0,0,0.6))",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Wordmark markSize={24} textSize="1.15rem" />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 8px" }}>Une erreur est survenue</h1>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--color-ink-2, #c9c7d6)", margin: 0 }}>
          Quelque chose s&apos;est mal passé de notre côté. Tu peux réessayer ; si
          ça persiste, reviens à l&apos;accueil et relance ton action.
        </p>
        {error?.digest && (
          <p style={{ fontSize: 12, color: "var(--color-ink-3, #79768a)", marginTop: 12, fontFamily: "ui-monospace, monospace" }}>
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
              borderRadius: 12,
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
              borderRadius: 12,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 550,
              color: "var(--color-ink-2, #c9c7d6)",
              border: "1px solid var(--color-line-strong, rgba(255,255,255,0.14))",
              textDecoration: "none",
            }}
          >
            Retour à l&apos;accueil
          </a>
        </div>
      </div>
    </main>
  );
}
