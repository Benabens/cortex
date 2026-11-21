/**
 * Hébreu et arabe dans un source LaTeX : XeTeX pose les mots de gauche à droite, une phrase de
 * droite à gauche se lit donc à l'envers. Chaque passage écrit dans ces écritures est enveloppé :
 * \CortexRL{…} (\beginR…\endR, TeX--XeT de XeTeX) pour l'ordre des mots, \CortexHe{…} / \CortexAr{…}
 * pour la police (latex/hebrew-fonts.tex, latex/arabic-fonts.tex), et, à l'intérieur, chaque
 * passage de gauche à droite (mot latin, nombre, formule) en \CortexLR{…} : « 2024 » ou « f(x) »
 * gardent leur sens de lecture au milieu d'une phrase en hébreu.
 *
 * Le sens d'un bout de texte suit la règle de l'algorithme bidi d'Unicode (P2) : celui de sa
 * première lettre forte. Une phrase en hébreu garde donc dans son passage le « 2024 » qui la
 * termine ; un mot hébreu cité dans une phrase française reste un passage à lui seul.
 *
 * Choix : les primitives plutôt que polyglossia ou bidi. Ces paquets veulent être chargés en
 * dernier, redéfinissent listes, tableaux et TikZ du préambule, et demandent de toute façon que
 * chaque passage soit balisé à la main ; ici, le balisage se fait sur le source, quel que soit le
 * générateur (QCM, examen écrit, questions composées). Limites assumées : le paragraphe reste
 * aligné à gauche, et un bout de texte s'arrête à toute macro autre que les mises en forme
 * simples (\textbf{…}, \emph{…}…) : \ref, \ensuremath ou une liste le coupent en deux.
 */

const RTL_CHAR = "[\\p{scx=Hebrew}\\p{scx=Arabic}]";
const HEBREW = /\p{scx=Hebrew}/u;
const ARABIC = /\p{scx=Arabic}/u;
const RTL = new RegExp(RTL_CHAR, "u");
const LATIN = /[A-Za-z]/;

/** Groupes de mise en forme qu'un bout de texte traverse (contenu sans accolade ni macro). */
const FORMAT_GROUP = String.raw`\\(?:textbf|textit|emph|textsl|underline|textsf|texttt)\{[^{}\\$%]*\}`;
/** Ce qui forme un bout de texte : lettres, espaces, ponctuation, chiffres, maths en ligne, mises en forme. */
const PIECE = String.raw`${FORMAT_GROUP}|\\[%&_#$]|\$[^$\n]+\$|[ \t~]|\n(?![ \t]*\n)|[A-Za-z0-9.,;:!?'"()\[\]/+\-–—*<>=|…]|${RTL_CHAR}`;
// Jamais au milieu d'un nom de macro : les lettres de « \item » ne sont pas du texte.
const STRETCH = new RegExp(`(?<!\\\\[A-Za-z]*)(?:${PIECE})+`, "gu");
const TOKEN = new RegExp(PIECE, "gu");

/** Code verbatim et commentaires : jamais touchés. */
const PROTECTED = /(\\begin\{(lstlisting|verbatim|Verbatim|minted)\}[\s\S]*?\\end\{\2\}|\\(?:verb|lstinline)(\S)[\s\S]*?\3|(?<!\\)%.*$)/m;

type Kind = "he" | "ar" | "ltr" | "digit" | "neutral" | "rtl-group";
type Token = { text: string; kind: Kind };

function kindOf(t: string): Kind {
  if (/^\\[a-z]+\{/.test(t)) {
    const inner = t.slice(t.indexOf("{") + 1, -1);
    return RTL.test(inner) ? "rtl-group" : LATIN.test(inner) ? "ltr" : /\d/.test(inner) ? "digit" : "neutral";
  }
  if (t.startsWith("$")) return "ltr";
  if (HEBREW.test(t)) return "he";
  if (ARABIC.test(t)) return "ar";
  if (LATIN.test(t)) return "ltr";
  return /\d/.test(t) ? "digit" : "neutral";
}

const tokenize = (s: string): Token[] => [...s.matchAll(TOKEN)].map(([text]) => ({ text, kind: kindOf(text) }));
const isRtl = (k: Kind) => k === "he" || k === "ar" || k === "rtl-group";
const join = (ts: Token[]) => ts.map((t) => t.text).join("");

/**
 * Les jetons d'un passage de droite à gauche : les lettres de chaque écriture dans leur police, les
 * suites de gauche à droite (latin, chiffres, formules, et ce qui les sépare) en \CortexLR.
 */
function renderInside(tokens: Token[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; ) {
    const k = tokens[i].kind;
    if (k === "neutral") { out += tokens[i++].text; continue; }
    if (k === "rtl-group") {
      const t = tokens[i++].text;
      const open = t.indexOf("{") + 1;
      out += `${t.slice(0, open)}${renderInside(tokenize(t.slice(open, -1)))}}`;
      continue;
    }
    const ltr = k === "ltr" || k === "digit";
    const same = (x: Kind) => (ltr ? x === "ltr" || x === "digit" : x === k);
    let end = i;
    for (let j = i + 1; j < tokens.length; j++) {
      if (same(tokens[j].kind)) end = j;
      else if (tokens[j].kind !== "neutral") break;
    }
    const body = join(tokens.slice(i, end + 1));
    out += ltr ? `\\CortexLR{${body}}` : k === "he" ? `\\CortexHe{${body}}` : `\\CortexAr{${body}}`;
    i = end + 1;
  }
  return out;
}

const rl = (ts: Token[]) => `\\CortexRL{${renderInside(ts)}}`;

/** Un bout de texte balisé selon le sens de sa première lettre forte. */
function markStretch(stretch: string): string {
  const tokens = tokenize(stretch);
  const first = tokens.findIndex((t) => isRtl(t.kind));
  if (first < 0) return stretch;
  // Lettre forte : hors des groupes de mise en forme (« \textbf{A.} » d'un libellé de QCM n'en est pas une).
  const strong = tokens.find((t) => isRtl(t.kind) || (t.kind === "ltr" && !t.text.startsWith("\\")));
  if (strong && isRtl(strong.kind)) {
    // Paragraphe de droite à gauche : de la première lettre à la fin, sans les espaces qui la suivent.
    let last = tokens.length - 1;
    while (last > first && /^\s+$/.test(tokens[last].text)) last--;
    return join(tokens.slice(0, first)) + rl(tokens.slice(first, last + 1)) + join(tokens.slice(last + 1));
  }
  // Paragraphe de gauche à droite : chaque suite de lettres de droite à gauche (et ce qui les sépare,
  // hors latin) est un passage à elle seule, plus la ponctuation qui la suit.
  let out = "";
  for (let i = 0; i < tokens.length; ) {
    if (!isRtl(tokens[i].kind)) { out += tokens[i++].text; continue; }
    let end = i;
    for (let j = i + 1; j < tokens.length && tokens[j].kind !== "ltr"; j++) if (isRtl(tokens[j].kind)) end = j;
    while (end + 1 < tokens.length && /^[.?!:;…]$/.test(tokens[end + 1].text)) end++;
    out += rl(tokens.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

/** Les écritures de droite à gauche que le texte imprime. */
export function rightToLeftScripts(printed: string): { hebrew: boolean; arabic: boolean } {
  return { hebrew: HEBREW.test(printed), arabic: ARABIC.test(printed) };
}

/** Le corps d'un document avec ses passages en hébreu et en arabe balisés (cf. en-tête). */
export function markRightToLeft(body: string): string {
  return body.split(PROTECTED).map((part, i) => {
    // split avec groupes : [texte, bloc protégé, environnement, délimiteur, texte, …]
    if (i % 4 !== 0) return i % 4 === 1 ? part : "";
    return part === undefined ? "" : part.replace(STRETCH, markStretch);
  }).join("");
}

const MARK = /\\Cortex(?:RL|LR|He|Ar)\{/;

/** Le source sans le balisage de `markRightToLeft` (pdflatex ne le connaît pas). */
export function unmarkRightToLeft(tex: string): string {
  let out = tex;
  for (let m = MARK.exec(out); m; m = MARK.exec(out)) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < out.length && depth; j++) {
      if (out[j] === "\\") j++;
      else if (out[j] === "{") depth++;
      else if (out[j] === "}") depth--;
    }
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length, j - 1) + out.slice(j);
  }
  return out;
}
