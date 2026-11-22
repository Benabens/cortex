/**
 * HTML SIMPLE ÉCRIT PAR LE MODÈLE (énoncés, indices, corrigés) : le lire sans le croire.
 *
 * Le modèle écrit des balises (p, ol, li, table, code…) mais aussi des comparaisons nues
 * (« flow=1 < 2 », « i<n », « a<b et b>c ») et des entités (&rarr;, &le;, &#8594;). Un
 * « < » n'est une balise que s'il ouvre un nom connu, suivi d'attributs connus : tout le
 * reste est du texte. Sans cette règle, une conversion naïve (/<[^>]+>/) mangeait tout
 * jusqu'au « > » suivant et coupait le corrigé au milieu d'une phrase (drill Max-flow).
 */

/**
 * Noms de balises reconnus : le HTML simple des générations, ses voisines courantes, et les
 * balises dangereuses (laissées balises pour que l'assainisseur les retire). `q` exclu : « p<q> ».
 */
const TAGS = new Set([
  "applet", "audio", "base", "body", "button", "canvas", "dialog", "embed", "form", "frame", "frameset",
  "head", "html", "iframe", "input", "label", "link", "math", "meta", "noscript", "object", "option",
  "param", "picture", "select", "source", "svg", "template", "textarea", "title", "use", "video",
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup",
  "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "nav", "ol", "p", "pre", "s", "samp", "script", "section", "small", "span", "strike", "strong", "style",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var",
]);

/**
 * Attributs plausibles écrits sans valeur. Un attribut avec « = valeur » compte toujours (y compris
 * onerror=… : l'assainisseur le retire) ; des mots nus inconnus (« <b et b> ») font du « < » un texte.
 */
const ATTRS = new Set([
  "align", "alt", "border", "cellpadding", "cellspacing", "class", "colspan", "dir", "height", "href", "id",
  "lang", "rel", "reversed", "role", "rowspan", "scope", "span", "src", "start", "style", "target", "title",
  "type", "valign", "value", "width",
]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_NAME_RE = /\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

export type HtmlToken =
  | { kind: "text"; text: string }
  | { kind: "tag"; name: string; closing: boolean; selfClosing: boolean; raw: string };

function attrsKnown(attrs: string): boolean {
  for (const m of attrs.matchAll(ATTR_NAME_RE)) {
    const name = m[1].toLowerCase();
    if (!m[2] && !ATTRS.has(name) && !name.startsWith("data-") && !name.startsWith("aria-")) return false;
  }
  return true;
}

/** Découpe en texte et balises reconnues ; tout « < » qui n'ouvre pas une balise connue reste du texte. */
export function tokenizeLlmHtml(html: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  let text = "";
  let i = 0;
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = ""; } };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text += html.slice(i); break; }
    text += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end >= 0) { i = end + 3; continue; }
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    const name = m?.[2].toLowerCase();
    if (m && name && TAGS.has(name) && (m[1] === "" || m[3] === "") && attrsKnown(m[3])) {
      flush();
      out.push({ kind: "tag", name, closing: m[1] === "/", selfClosing: m[4] === "/", raw: m[0] });
      i = lt + m[0].length;
    } else {
      text += "<";
      i = lt + 1;
    }
  }
  flush();
  return out;
}

/**
 * HTML à afficher : chaque « < » qui n'ouvre pas une balise reconnue devient « &lt; ». Sans ça, le
 * navigateur lit « d[v]<d[u]+w » ou « i<n » comme le début d'une balise et l'assainisseur emporte
 * la suite de la phrase. N'ajoute jamais de balise : ne fait que rendre du texte inerte.
 */
export function escapeStrayLt(html: string): string {
  return tokenizeLlmHtml(html).map((t) => (t.kind === "tag" ? t.raw : t.text.replace(/</g, "&lt;"))).join("");
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rarr: "→", larr: "←", harr: "↔", uarr: "↑", darr: "↓", rArr: "⇒", lArr: "⇐", hArr: "⇔", map: "↦",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡", sim: "∼", prop: "∝", times: "×", divide: "÷",
  plusmn: "±", minus: "−", middot: "·", sdot: "⋅", deg: "°", infin: "∞", sum: "∑", prod: "∏", radic: "√",
  int: "∫", part: "∂", nabla: "∇", forall: "∀", exist: "∃", isin: "∈", notin: "∉", ni: "∋", empty: "∅",
  sub: "⊂", sup: "⊃", sube: "⊆", supe: "⊇", cup: "∪", cap: "∩", and: "∧", or: "∨", not: "¬", oplus: "⊕",
  otimes: "⊗", perp: "⊥", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", lang: "⟨", rang: "⟩",
  prime: "′", Prime: "″", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", lsquo: "‘",
  rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", euro: "€", copy: "©", reg: "®", trade: "™", sect: "§",
  para: "¶", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", shy: "",
  thinsp: " ", ensp: " ", emsp: " ", zwj: "", zwnj: "", check: "✓", cross: "✗",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι",
  kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ",
  sigmaf: "ς", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  agrave: "à", acirc: "â", auml: "ä", ccedil: "ç", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù", ucirc: "û", uuml: "ü", yuml: "ÿ", oelig: "œ", aelig: "æ",
  Agrave: "À", Acirc: "Â", Ccedil: "Ç", Eacute: "É", Egrave: "È", Ecirc: "Ê", Icirc: "Î", Ocirc: "Ô",
  Ugrave: "Ù", Ucirc: "Û", OElig: "Œ", szlig: "ß", ntilde: "ñ", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
};

/** Entités HTML → caractères, en une passe (« &amp;lt; » donne « &lt; », pas « < »). Inconnues : laissées. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,8});/g, (whole, e: string) => {
    if (e[0] !== "#") return NAMED[e] ?? whole;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "caption", "center", "dd", "details", "div", "dl", "dt",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav",
  "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "ul",
]);

/**
 * HTML simple du moteur → texte lisible : listes numérotées, une ligne par rangée de tableau
 * (cellules séparées par « | »), exposants en « ^ », code de <pre> tel quel. Pas un assainisseur :
 * la sortie n'est jamais réinjectée comme HTML.
 */
export function llmHtmlToText(html: string | null | undefined): string {
  let out = "";
  const lists: { ordered: boolean; n: number }[] = [];
  const scripts: number[] = []; // longueur de `out` à l'ouverture d'un sup/sub
  let pre = 0;
  let skip = 0; // dans <script>/<style>/<template>
  let cells = -1; // cellules déjà écrites dans la rangée courante (-1 : hors rangée)
  const newline = () => { if (out && !out.endsWith("\n")) out += "\n"; };
  for (const t of tokenizeLlmHtml(html ?? "")) {
    if (t.kind === "text") {
      if (skip) continue;
      let s = decodeEntities(t.text);
      // Une cellule tient sur sa rangée ; ailleurs les espaces restent (indentation d'un code écrit
      // sans <pre>, LaTeX brut des examens écrits passé par ici tel quel).
      if (!pre && cells >= 0) s = s.replace(/\s+/g, " ");
      // Entre deux balises de structure, un retour à la ligne de mise en page ne compte pas.
      if (!pre && !s.trim() && (out === "" || out.endsWith("\n") || out.endsWith(" | "))) continue;
      out += s;
      continue;
    }
    const { name, closing } = t;
    if (name === "script" || name === "style" || name === "template") { skip = Math.max(0, skip + (closing ? -1 : t.selfClosing ? 0 : 1)); continue; }
    if (skip) continue;
    if (name === "br") { out += "\n"; continue; }
    if (name === "pre") { newline(); pre = Math.max(0, pre + (closing ? -1 : 1)); continue; }
    if (name === "sup" || name === "sub") {
      if (!closing) { scripts.push(out.length); continue; }
      const start = scripts.pop();
      if (start === undefined) continue;
      const inner = out.slice(start).trim();
      out = out.slice(0, start) + (inner ? `${name === "sup" ? "^" : "_"}${/^[\p{L}\p{N}]$|^[\p{N}]+$/u.test(inner) ? inner : `(${inner})`}` : "");
      continue;
    }
    if (name === "tr") {
      if (!closing) { newline(); cells = 0; } else cells = -1;
      continue;
    }
    if (name === "td" || name === "th") {
      if (closing) continue;
      if (cells < 0) { newline(); cells = 0; }
      out = out.replace(/[ \t]+$/, "");
      if (cells > 0) out += " | ";
      cells++;
      continue;
    }
    if (name === "table" && closing) cells = -1;
    if (name === "ol" || name === "ul") {
      newline();
      if (!closing) lists.push({ ordered: name === "ol", n: 0 });
      else lists.pop();
      continue;
    }
    if (name === "li") {
      if (closing) continue;
      newline();
      const list = lists.at(-1);
      out += `${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${++list.n}. ` : "- "}`;
      continue;
    }
    if (BLOCKS.has(name)) newline();
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
