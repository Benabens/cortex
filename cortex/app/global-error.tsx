"use client"; // Obligatoire (error boundary). global-error REMPLACE le layout racine.

import { useEffect } from "react";

/**
 * Erreur CRITIQUE au niveau du layout racine : global-error remplace tout le
 * document, il doit donc rendre ses propres <html>/<body>. Styles inline et
 * couleurs littérales : aucune dépendance au CSS global (qui peut être la cause
 * du crash). Thème DARK cohérent avec l'app.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "48px 24px",
            background: "#0c0d15",
            color: "#f4f2fb",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
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
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 8px" }}>Erreur critique</h1>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "#c9c7d6", margin: 0 }}>
              L&apos;application n&apos;a pas pu s&apos;afficher. Recharge la page ;
              si le problème persiste, réessaie dans un instant.
            </p>
            {error?.digest && (
              <p style={{ fontSize: 12, color: "#79768a", marginTop: 12, fontFamily: "ui-monospace, monospace" }}>
                réf. {error.digest}
              </p>
            )}
            <div style={{ marginTop: 22 }}>
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
                Recharger
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
