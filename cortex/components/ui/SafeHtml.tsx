import { useMemo, type CSSProperties } from "react";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Seul point de l'interface autorisé à injecter du HTML : tout ce qui vient du
 * modèle ou d'un utilisateur passe par `sanitizeHtml` (liste blanche). Le test
 * tests/sanitize-html.test.ts refuse tout autre dangerouslySetInnerHTML.
 * `math` : HTML produit par le serveur avec ses formules KaTeX (lib/math-html,
 * texToHtml), jamais le HTML brut du modèle ; `as="span"` pour un texte en ligne.
 */
export function SafeHtml({ html, className, style, math = false, as: Tag = "div" }: { html: string; className?: string; style?: CSSProperties; math?: boolean; as?: "div" | "span" }) {
  const clean = useMemo(() => sanitizeHtml(html, { math }), [html, math]);
  return <Tag className={className} style={style} dangerouslySetInnerHTML={{ __html: clean }} />;
}
