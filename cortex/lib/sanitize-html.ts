import DOMPurify from "isomorphic-dompurify";

/**
 * ASSAINISSEMENT DU HTML DE PROVENANCE MODÈLE OU UTILISATEUR.
 *
 * Les drills et les questions ouvertes des mocks sont produits par le LLM en
 * « HTML simple » puis injectés dans le DOM. Le modèle est influençable par les
 * documents uploadés (injection de prompt) : sans filtre, un cours piégé peut
 * lui faire émettre `<img onerror=…>` et exécuter du script dans la session
 * d'un autre utilisateur. On ne garde donc qu'une LISTE BLANCHE de balises de
 * mise en forme, sans attribut porteur de comportement (handlers, style, URL).
 *
 * Isomorphe : DOMPurify sur le DOM du navigateur côté client, sur jsdom côté
 * serveur (rendu SSR des composants clients).
 */

const ALLOWED_TAGS = [
  "p", "br", "hr", "div", "span", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "small", "mark", "kbd", "var",
  "code", "pre",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

// `class` : le rendu des questions ouvertes (texToHtml) pose pre.code, div.fig, span.pts.
const ALLOWED_ATTR = ["class", "colspan", "rowspan", "lang", "dir"];

export function sanitizeHtml(html: string): string {
  if (typeof html !== "string" || !html) return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Pas de MathML/SVG ni d'images : le modèle reçoit la consigne « pas de
    // LaTeX, pas d'images ». (Un USE_PROFILES ici primerait sur la liste blanche.)
    KEEP_CONTENT: true,
  });
}
