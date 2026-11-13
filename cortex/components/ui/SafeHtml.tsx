import type { CSSProperties } from "react";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Seul point de l'interface autorisé à injecter du HTML : tout ce qui vient du
 * modèle ou d'un utilisateur passe par `sanitizeHtml` (liste blanche). Le test
 * tests/sanitize-html.test.ts refuse tout autre dangerouslySetInnerHTML.
 */
export function SafeHtml({ html, className, style }: { html: string; className?: string; style?: CSSProperties }) {
  return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: focusablePre(sanitizeHtml(html)) }} />;
}

/** Un bloc <pre> ou un tableau (div.tab) défile horizontalement sur mobile : il doit être atteignable au clavier (WCAG 2.1.1). */
function focusablePre(clean: string): string {
  return clean.replace(/<pre(?=[\s>])|<div class="tab"(?=>)/g, (m) => `${m} tabindex="0"`);
}
