import DOMPurify from "isomorphic-dompurify";
import { escapeStrayLt } from "./llm-html";

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

/**
 * MODE FORMULES : le HTML qu'a produit le serveur (lib/math-html, texToHtml), où le texte du modèle
 * est déjà échappé ou assaini strictement, et où seul KaTeX a posé son balisage. On y ajoute ce que
 * KaTeX émet (relevé sur toutes les commandes de lib/tex-rich) : MathML (lu par les lecteurs
 * d'écran), SVG des racines et des flèches, et des `style` de mise en page dont chaque déclaration
 * est une longueur en em (ou position:relative), jamais une couleur, une URL ou un position:fixed.
 */
const KATEX_TAGS = [
  "math", "semantics", "annotation", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "mpadded", "mphantom", "mstyle",
  "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "menclose",
  "svg", "path", "line",
];
const KATEX_ATTR = [
  "style", "aria-hidden", "xmlns", "encoding", "display", "displaystyle", "scriptlevel", "mathvariant", "stretchy", "fence",
  "separator", "lspace", "rspace", "minsize", "maxsize", "linethickness", "accent", "accentunder", "voffset",
  "width", "height", "viewBox", "preserveAspectRatio", "d",
];
const KATEX_STYLE = /^(?:\s*(?:(?:border-(?:top|right|bottom)-width|top|bottom|left|height|width|min-width|vertical-align|margin-(?:left|right)|padding-left)\s*:\s*-?(?:\d+\.?\d*|\.\d+)em|position\s*:\s*relative)\s*(?:;|$))*\s*$/;
/** Vrai pendant un `sanitizeHtml(…, { math: true })` (DOMPurify est synchrone). */
let mathMode = false;

/** Un bloc de code, un tableau (div.tab) ou une formule détachée (span.math-display) défile horizontalement sur mobile : il doit être atteignable au clavier (WCAG 2.1.1). */
const isScrollBlock = (el: Element) => {
  const classes = (el.getAttribute("class") ?? "").split(/\s+/);
  return el.nodeName === "PRE" || (el.nodeName === "DIV" && classes.includes("tab")) || (el.nodeName === "SPAN" && classes.includes("math-display"));
};

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style" && !(mathMode && KATEX_STYLE.test(data.attrValue))) data.keepAttr = false;
});

// Posé sur le DOM, APRÈS le filtre des attributs : jamais par une regex sur le HTML sérialisé
// (une valeur d'attribut contenant « <pre » y fabriquerait un vrai attribut).
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element; // côté serveur (jsdom), pas de classe Element globale : on teste nodeType
  if (el.nodeType === 1 && isScrollBlock(el)) el.setAttribute("tabindex", "0");
});

/** `math` : HTML produit par le serveur avec ses formules KaTeX (cf. KATEX_TAGS), jamais le HTML brut du modèle. */
export function sanitizeHtml(html: string, { math = false }: { math?: boolean } = {}): string {
  if (typeof html !== "string" || !html) return "";
  mathMode = math;
  try {
    // « flow < 2 » ou « d[v]<d[u]+w » écrits tels quels par le modèle : du texte, pas une balise ouverte.
    // En mode formules le HTML vient du serveur, bien formé : les balises MathML n'y sont pas du texte.
    return DOMPurify.sanitize(math ? html : escapeStrayLt(html), {
      ALLOWED_TAGS: math ? [...ALLOWED_TAGS, ...KATEX_TAGS] : ALLOWED_TAGS,
      ALLOWED_ATTR: math ? [...ALLOWED_ATTR, ...KATEX_ATTR] : ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
      // Pas de MathML/SVG ni d'images hors mode formules : le modèle reçoit la consigne « pas de
      // LaTeX, pas d'images ». (Un USE_PROFILES ici primerait sur la liste blanche.)
      KEEP_CONTENT: true,
    });
  } finally {
    mathMode = false;
  }
}
