"use client"; // Les error boundaries doivent être des Client Components (Next App Router).

import { useEffect } from "react";

/**
 * Erreur de segment (route sous le layout racine). Thème DARK cohérent avec
 * l'app — sans quoi la page d'erreur Next par défaut s'affiche en thème CLAIR
 * et casse l'identité dark-only. Styles inline : robuste même si le CSS global
 * n'est pas chargé au moment du crash.
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
        color: "#f4f2fb",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 16,
          padding: "32px 28px",
          boxShadow: "0 8px 26px -6px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#8b7bff", fontWeight: 600 }}>
          cortex.
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 8px" }}>Une erreur est survenue</h1>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: "#c9c7d6", margin: 0 }}>
          Quelque chose s&apos;est mal passé de notre côté. Tu peux réessayer ; si
          ça persiste, reviens à l&apos;accueil et relance ton action.
        </p>
        {error?.digest && (
          <p style={{ fontSize: 12, color: "#79768a", marginTop: 12, fontFamily: "ui-monospace, monospace" }}>
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
              borderRadius: 999,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              color: "#fff",
              background: "linear-gradient(180deg, #6f5cf0, #5a48d6)",
            }}
          >
            Réessayer
          </button>
          <a
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 999,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 550,
              color: "#c9c7d6",
              border: "1px solid rgba(255,255,255,0.14)",
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
