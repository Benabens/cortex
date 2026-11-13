import Link from "next/link";
import { Wordmark } from "@/components/shell/Logo";

/**
 * 404 — page introuvable, aux jetons de l'app (sombre ou clair selon le thème ;
 * replis littéraux du sombre si le CSS global manque). Server Component.
 */
export default function NotFound() {
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
        <h1 style={{ fontSize: 44, fontWeight: 700, margin: "12px 0 4px", lineHeight: 1 }}>404</h1>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Page introuvable</h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--color-ink-2, #bfc1c9)", margin: 0 }}>
          Cette page n’existe pas (ou plus). Vérifie l’adresse, ou reviens à
          l’accueil.
        </p>
        <div style={{ marginTop: 22 }}>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 9999,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-on-primary, #111214)",
              textDecoration: "none",
              background: "var(--color-primary, #ececee)",
            }}
          >
            Retour à l’accueil
          </Link>
        </div>
      </div>
    </div>
  );
}
