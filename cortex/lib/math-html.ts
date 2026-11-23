import katex from "katex";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { formulaPieces, mathTex } from "@/lib/tex-rich";

/**
 * FORMULES DU TEXTE DU MODÈLE → HTML POUR L'ÉCRAN (énoncés, options, corrigés, retours). Même
 * découpage que le PDF (lib/tex-rich) : seule une formule que `mathTex` juge sûre est composée, par
 * KaTeX côté serveur, avec son MathML (lu par les lecteurs d'écran) ; une formule que KaTeX refuse
 * reste son texte d'origine. Tout le reste est échappé : le seul balisage produit est celui de
 * KaTeX, sans `trust` (aucun \href, \htmlClass…, que MATH_COMMANDS écarte déjà).
 */

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Au-delà, ce n'est plus une formule d'examen (« x_1 x_1 … » fusionnés) : KaTeX y passerait des secondes. */
const MAX_FORMULA_CHARS = 2000;

/** Une formule (sans délimiteurs) → HTML KaTeX, ou null si elle n'est pas sûre ou ne se compose pas. */
export function formulaHtml(content: string, display: boolean): string | null {
  if (content.length > MAX_FORMULA_CHARS || mathTex(content) === null) return null;
  try {
    const html = katex.renderToString(content, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 100,
      maxSize: 20,
    });
    // une formule détachée défile dans son propre conteneur plutôt que d'élargir la page (mobile)
    return display ? `<span class="math-display">${html}</span>` : html;
  } catch {
    return null;
  }
}

/**
 * Texte du modèle → HTML : formules composées, le reste échappé tel quel (les sauts de ligne restent
 * des « \n », que la vue affiche comme avant). null : aucune formule composée, la vue garde son texte.
 * `budget` : formules encore permises (partagé par un lot) ; au-delà, leur source reste telle quelle.
 */
export function mathHtml(text: string, budget = { left: Infinity }): string | null {
  let rendered = false;
  const html = formulaPieces(text ?? "").map((p) => {
    if ("text" in p) return escHtml(p.text);
    if (budget.left <= 0) return escHtml(p.source);
    budget.left--;
    const h = formulaHtml(p.formula, p.display);
    if (h === null) return escHtml(p.source);
    rendered = true;
    return h;
  }).join("");
  return rendered ? html : null;
}

/**
 * Formules composées par requête (POST /api/math) : une page d'examen en compte quelques centaines ;
 * sans borne, un lot de textes truffés de petites formules bloquait le serveur plusieurs minutes.
 */
export const MAX_FORMULAS_PER_BATCH = 3000;

/** Plusieurs textes, dans l'ordre, sous un seul budget de formules. */
export function mathHtmlBatch(texts: string[], maxFormulas = MAX_FORMULAS_PER_BATCH): (string | null)[] {
  const budget = { left: maxFormulas };
  return texts.map((t) => mathHtml(t, budget));
}

/** Balises (attributs entre guillemets compris) et texte d'un HTML assaini, donc bien formé. */
const HTML_TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const unescHtml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', nbsp: "\u00a0", "#39": "'" })[e]!);

/**
 * HTML SIMPLE DU MODÈLE (drill : énoncé, corrigé) → le même HTML, assaini strictement D'ABORD
 * (lib/sanitize-html), puis ses formules composées dans le texte hors de <code> et <pre>. Le
 * résultat s'affiche par `SafeHtml math`. null : aucune formule, la vue garde son HTML.
 */
export function mathInHtml(html: string): string | null {
  const clean = sanitizeHtml(html);
  let out = "";
  let last = 0;
  let code = 0;
  let rendered = false;
  const text = (run: string) => {
    const h = code ? null : mathHtml(unescHtml(run));
    if (h !== null) rendered = true;
    return h ?? run;
  };
  for (const m of clean.matchAll(HTML_TAG)) {
    out += text(clean.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
    const tag = /^<(\/?)(code|pre)\b/i.exec(m[0]);
    if (tag) code = Math.max(0, code + (tag[1] ? -1 : 1));
  }
  out += text(clean.slice(last));
  return rendered ? out : null;
}
