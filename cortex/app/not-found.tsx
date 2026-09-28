import Link from "next/link";
import { Wordmark } from "@/components/shell/Logo";

/**
 * 404 — page introuvable. Thème DARK cohérent (la page 404 Next par défaut est
 * en thème clair). Server Component (aucune interactivité requise).
 */
export default function NotFound() {
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
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Wordmark markSize={24} textSize="1.15rem" />
        </div>
        <h1 style={{ fontSize: 44, fontWeight: 700, margin: "12px 0 4px", lineHeight: 1 }}>404</h1>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Page introuvable</h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: "#c9c7d6", margin: 0 }}>
          Cette page n&apos;existe pas (ou plus). Vérifie l&apos;adresse, ou
          reviens à l&apos;accueil.
        </p>
        <div style={{ marginTop: 22 }}>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 12,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              color: "#111214",
              textDecoration: "none",
              background: "#ececee",
            }}
          >
            Retour à l&apos;accueil
          </Link>
        </div>
      </div>
    </main>
  );
}
