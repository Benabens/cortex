import { AsyncLocalStorage } from "node:async_hooks";
import { esc, mathSymbolTex } from "@/lib/tex-escape";

/**
 * TEXTE DU MODÈLE → LaTeX, AVEC SES FORMULES (QCM et questions composées : énoncés, options,
 * corrigés). `esc` échappe tout : une formule écrite par le modèle sortait en texte brut
 * (« $\frac{a}{b}$ », « x_{t+1} » imprimés tels quels, signalé le 22/11/2026).
 *
 * Seule une formule SÛRE passe en mode mathématique, le reste suit `esc` comme avant :
 *  - délimitée : `$…$`, `\(…\)`, ou en display `$$…$$`, `\[…\]` (imprimés `$\displaystyle …$` :
 *    une ligne à part casserait une option ou un titre). Le `$` suit la règle de pandoc : pas
 *    d'espace juste après celui qui ouvre ni juste avant celui qui ferme, pas de chiffre après
 *    celui qui ferme (« $5 et $10 » reste du texte) ;
 *  - le contenu ne garde que des commandes mathématiques connues (MATH_COMMANDS), avec leurs
 *    arguments, des accolades équilibrées, de l'ASCII et des symboles Unicode qui ont une
 *    commande mathématique (≤, α…) ; sinon (`\begin`, `%`, `&`, `\\`, accent…) le passage reste
 *    du texte : une formule mal formée ne doit jamais faire échouer tout le PDF.
 */

/**
 * CONSIGNE DES PROMPTS dont le texte passe par ce module (QCM, questions composées, corrections) :
 * la forme qu'il reconnaît à coup sûr. Sans elle, le modèle écrivait « x_{t+1} = 2x_t » en texte nu.
 */
export const FORMULA_RULE = String.raw`FORMULES : chaque formule mathématique, même un simple indice ou exposant, s'écrit entre $…$ collés à la formule ($x_{t+1} = 2x_t$, jamais $ x $), ou entre \[…\] quand elle est détachée ; jamais en texte nu (x_{t+1}, x^2 ou \frac{a}{b} hors des dollars). Le code et les noms de fichiers restent entre accents graves, sans dollars.`;

/** Même consigne pour un LaTeX libre (questions ouvertes, corrigés d'examen écrit). */
export const LATEX_FORMULA_RULE = String.raw`Toute formule, même un simple indice ou exposant (x_{t+1}, x^2), est entre $...$ ou \[ ... \] : écrite hors des maths, elle casse la compilation.`;

/** Actif : formules en texte échappé (cf. withFormulasAsText). */
const plainMath = new AsyncLocalStorage<true>();
/** Formules composées pendant un rendu (cf. formulasOrText). */
const composed = new AsyncLocalStorage<{ n: number }>();

/** Commandes admises en mode mathématique (amsmath + amssymb, chargés par latex/preamble.tex) et leur nombre d'arguments. */
const MATH_COMMANDS: Record<string, number> = Object.fromEntries([
  ...[
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi",
    "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
    "le", "leq", "leqslant", "ge", "geq", "geqslant", "ne", "neq", "approx", "equiv", "sim", "simeq", "cong", "propto",
    "ll", "gg", "prec", "succ", "preceq", "succeq", "triangleq", "times", "cdot", "div", "pm", "mp", "ast", "star",
    "circ", "bullet", "oplus", "otimes", "odot", "wedge", "land", "vee", "lor", "neg", "lnot", "in", "notin", "ni",
    "subset", "subseteq", "subsetneq", "supset", "supseteq", "cup", "cap", "bigcup", "bigcap", "setminus", "emptyset",
    "varnothing", "complement", "forall", "exists", "nexists", "top", "bot", "perp", "mid", "nmid", "parallel", "vdash",
    "models", "to", "rightarrow", "leftarrow", "gets", "leftrightarrow", "Rightarrow", "implies", "Leftarrow", "impliedby",
    "Leftrightarrow", "iff", "mapsto", "longrightarrow", "longleftarrow", "Longrightarrow", "Longleftarrow",
    "Longleftrightarrow", "uparrow", "downarrow", "hookrightarrow", "infty", "partial", "nabla", "sum", "prod", "coprod",
    "int", "iint", "oint", "ldots", "dots", "cdots", "vdots", "ddots", "lfloor", "rfloor", "lceil", "rceil", "langle",
    "rangle", "lvert", "rvert", "vert", "lVert", "rVert", "Vert", "ell", "hbar", "aleph", "Re", "Im", "prime", "angle",
    "triangle", "colon", "quad", "qquad", "displaystyle", "limits", "nolimits",
    "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "deg", "det", "dim", "exp", "gcd", "inf", "ker",
    "lim", "liminf", "limsup", "ln", "log", "max", "min", "Pr", "sec", "sin", "sinh", "sup", "tan", "tanh", "bmod",
  ].map((n) => [n, 0] as const),
  ...["sqrt", "mathbb", "mathcal", "mathbf", "mathrm", "mathit", "mathsf", "text", "operatorname", "hat", "bar", "vec",
    "tilde", "dot", "ddot", "overline", "underline", "pmod", "boldsymbol"].map((n) => [n, 1] as const),
  ...["frac", "dfrac", "tfrac", "binom"].map((n) => [n, 2] as const),
]);
/** Arguments lus comme du texte : lettres, chiffres et ponctuation simple seulement. */
const TEXT_ARG = new Set(["text", "operatorname", "mathrm"]);
const SIZES = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr"]);
/** Délimiteurs qu'accepte \left / \big… */
const DELIMITER = /^(?:[()[\]|./]|\\[{}|]|\\(?:langle|rangle|lfloor|rfloor|lceil|rceil|lvert|rvert|lVert|rVert|vert|Vert)(?![a-zA-Z]))/;

/** Groupe {…} équilibré ouvert en s[i] → indice après « } », ou -1. */
function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let p = i; p < s.length; p++) {
    if (s[p] === "\\") { p++; continue; }
    if (s[p] === "{") depth++;
    else if (s[p] === "}" && --depth === 0) return p + 1;
  }
  return -1;
}

/**
 * Contenu d'une formule → LaTeX mathématique, ou null s'il n'est pas sûr (cf. en-tête). Les
 * symboles Unicode connus deviennent leur commande (« ≤ » → \le).
 */
export function mathTex(m: string): string | null {
  if (!/[\p{L}\p{N}\\]/u.test(m)) return null;
  let out = "";
  let depth = 0;
  let sized = 0;
  for (let i = 0; i < m.length; i++) {
    const ch = m[i];
    if (ch === "\\") {
      const name = /^[a-zA-Z]+/.exec(m.slice(i + 1))?.[0];
      if (!name) {
        // \{ \} \| et espacements ; jamais « \\ » (saut de ligne) ni un caractère spécial échappé
        if (!/[{}|,;:! ]/.test(m[i + 1] ?? "")) return null;
        out += ch + m[i + 1];
        i++;
        continue;
      }
      if (SIZES.has(name)) {
        const d = DELIMITER.exec(m.slice(i + 1 + name.length).trimStart());
        if (!d) return null;
        if (name === "left") sized++;
        if (name === "right") sized--;
        if (sized < 0) return null;
        out += `\\${name}`;
        i += name.length;
        continue;
      }
      const arity = MATH_COMMANDS[name];
      if (arity === undefined) return null;
      out += `\\${name}`;
      let j = i + 1 + name.length;
      if (name === "sqrt" && m[j] === "[") {
        const close = m.indexOf("]", j);
        const idx = close < 0 ? null : mathTex(m.slice(j + 1, close));
        if (idx === null) return null;
        out += `[${idx}]`;
        j = close + 1;
      }
      for (let a = 0; a < arity; a++) {
        while (m[j] === " ") j++;
        if (m[j] === "{") {
          const end = groupEnd(m, j);
          if (end < 0) return null;
          const inner = m.slice(j + 1, end - 1);
          const arg = TEXT_ARG.has(name) ? (/^[A-Za-z0-9 ,.'-]*$/.test(inner) ? inner : null) : mathTex(inner) ?? (inner.trim() ? null : inner);
          if (arg === null) return null;
          out += `{${arg}}`;
          j = end;
        } else if (/[A-Za-z0-9]/.test(m[j] ?? "")) {
          out += m[j];
          j++;
        } else return null;
      }
      i = j - 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return null;
    if (ch === "^" || ch === "_") {
      // un exposant ou un indice porte sur quelque chose, et jamais deux fois de suite (« Double superscript »)
      const next = m.slice(i + 1).trimStart()[0];
      if (!next || "^_}".includes(next)) return null;
      const rest = m.slice(i + 1).trimStart();
      const argLen = rest[0] === "{" ? groupEnd(rest, 0) : rest[0] === "\\" ? 1 + (/^[a-zA-Z]+/.exec(rest.slice(1))?.[0].length ?? 1) : 1;
      if (argLen < 0 || new RegExp(`^\\s*\\${ch}`).test(rest.slice(argLen))) return null;
    }
    if (/[A-Za-z0-9 +\-*/=<>()[\]|,.;:!'?{}^_]/.test(ch)) { out += ch; continue; }
    const sym = mathSymbolTex(ch);
    if (sym === null) return null;
    out += `{${sym}}`;
  }
  return depth === 0 && sized === 0 ? out : null;
}

/** Argument d'un indice ou d'un exposant écrit sans délimiteurs : `{…}`, ou court (cf. bareAtoms). */
function scriptEnd(s: string, j: number, mark: string): number {
  if (s[j] === "{") return groupEnd(s, j);
  // court : « x_t », « a_1 », « x^2 » ; jamais « a^b » (le ou exclusif du C), seulement des chiffres en exposant
  const m = (mark === "_" ? /^(?:\d+|[A-Za-z](?![A-Za-z0-9]))/ : /^\d+/).exec(s.slice(j));
  return m ? j + m[0].length : -1;
}

/** Fin des indices et exposants qui suivent s[j] (j si aucun). */
function scriptsEnd(s: string, j: number): number {
  while (s[j] === "_" || s[j] === "^") {
    const end = scriptEnd(s, j + 1, s[j]);
    if (end < 0) return j;
    j = end;
  }
  return j;
}

/**
 * FORMULE SANS DÉLIMITEURS, reconnue seulement quand elle ne peut pas être autre chose :
 *  - une lettre seule suivie d'un indice ou d'un exposant : « x_{t+1} », « a_n », « x^2 », avec son
 *    coefficient collé (« 2x_t », « 0.5x^2 » ; jamais « 0x_ff », « C++17x_y », « #2x_t », « 1,5x_t ») ; la lettre (ou le coefficient) ne
 *    suit ni une lettre, ni un chiffre, ni « _ . \ / @ : » (« snake_case », « max_iter »,
 *    « __init__ », « /tmp/a_1 », « github.com/u/x_y » restent du texte) et rien d'un mot, d'une
 *    adresse ou d'un chemin ne suit (« a_b.py », « x_tt », « a_b@epfl.ch ») ;
 *  - une commande mathématique connue (MATH_COMMANDS) avec ses arguments et ses indices :
 *    « \frac{a}{b} », « \sum_i », « \nabla » ; « \n » ou « \temp » ne le sont pas, ni une commande
 *    collée à un mot ou suivie d'une autre inconnue (« C:\Users\pi\doc » est un chemin).
 * Deux formules que séparent seulement des espaces et des opérateurs n'en font qu'une. Le code entre
 * accents graves n'est jamais lu comme une formule, délimitée ou non.
 */
const BARE_START = /(?<![\p{L}\p{N}_.\\/@:])(?:(?<![#,]|\+\+)(?:[1-9]\d*(?:\.\d+)?|0\.\d+))?[A-Za-z](?=[_^])|(?<![:/@])\\[a-zA-Z]+/gu;
const BARE_GAP = /^[ =+\-*/<>]*$/;

function bareAtoms(s: string): { start: number; end: number }[] {
  const atoms: { start: number; end: number }[] = [];
  for (const m of s.matchAll(BARE_START)) {
    const start = m.index;
    if (atoms.length && start < atoms[atoms.length - 1].end) continue;
    let end: number;
    if (m[0][0] === "\\") {
      const name = m[0].slice(1);
      const arity = MATH_COMMANDS[name];
      if (arity === undefined) continue;
      end = start + m[0].length;
      for (let a = 0; a < arity && end > 0; a++) end = s[end] === "{" ? groupEnd(s, end) : /[A-Za-z0-9]/.test(s[end] ?? "") ? end + 1 : -1;
      if (end < 0) continue;
      end = scriptsEnd(s, end);
    } else {
      end = scriptsEnd(s, start + m[0].length);
      if (end === start + m[0].length) continue;
    }
    const prev = atoms[atoms.length - 1];
    // une commande collée à un mot n'est une formule qu'à la suite d'une autre (« \eta\nabla »)
    if (m[0][0] === "\\" && /[\p{L}\p{N}]/u.test(s[start - 1] ?? "") && prev?.end !== start) continue;
    const after = s.slice(end);
    if (/^(?:[\p{L}\p{N}_@]|\.[\p{L}\p{N}]|\/[\p{L}\p{N}])/u.test(after)) continue;
    const next = /^\\([a-zA-Z]+)/.exec(after);
    if (next && MATH_COMMANDS[next[1]] === undefined) continue;
    if (mathTex(s.slice(start, end)) === null) continue;
    // fusion revalidée : la formule entière doit rester sûre, sinon les deux restent séparées
    if (prev && BARE_GAP.test(s.slice(prev.end, start)) && mathTex(s.slice(prev.start, end)) !== null) prev.end = end;
    else atoms.push({ start, end });
  }
  return atoms;
}

type Segment = { math: string } | { text: string };

/** Le texte hors délimiteurs, avec ses formules sans délimiteurs. */
function bareSegments(s: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const a of bareAtoms(s)) {
    const tex = mathTex(s.slice(a.start, a.end));
    if (tex === null) continue;
    if (a.start > last) out.push({ text: s.slice(last, a.start) });
    out.push({ math: tex });
    last = a.end;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** Formules délimitées (cf. en-tête) ; un délimiteur dont le contenu n'est pas sûr reste du texte. */
const DELIMITED = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)([^$\n]*?\S)\$(?!\d)/g;

function segments(s: string): Segment[] {
  return s.split(/(`[^`\n]+`)/).flatMap((piece, k) => (k % 2 ? [{ text: piece }] : formulaSegments(piece)));
}

function formulaSegments(s: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of s.matchAll(DELIMITED)) {
    const display = m[1] ?? m[2];
    const tex = mathTex(display ?? m[3] ?? m[4]);
    if (tex === null) continue;
    if (m.index > last) out.push(...bareSegments(s.slice(last, m.index)));
    out.push({ math: display !== undefined ? displayTex(tex) : tex });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...bareSegments(s.slice(last)));
  return out;
}

/** Une ligne de texte du modèle → LaTeX en ligne (option, titre, critère) : formules sûres en maths, le reste par `esc`. */
export function texInline(s: string): string {
  if (plainMath.getStore()) return esc(s ?? "");
  return segments(s ?? "").map((g) => ("math" in g ? composedMath(g.math) : esc(g.text))).join("");
}

/** Une formule en ligne, d'une ligne à part une fois composée : `\\displaystyle`, sans saut de ligne. */
function displayTex(tex: string): string {
  return `\\displaystyle ${tex.trim()}`;
}

/** Une formule validée entre dollars, comptée pour `formulasOrText`. */
function composedMath(tex: string): string {
  const seen = composed.getStore();
  if (seen) seen.n++;
  return `$${tex}$`;
}

/** Puce Markdown (« - », « * », « • ») ou numéro (« 1. », « 2) ») en début de ligne, suivis d'une espace. */
const ITEM = /^\s*(?:([-*•])|(\d{1,2})[.)])\s+(\S.*)$/;

type MdList = { env: "itemize" | "enumerate"; start: number; items: string[] };

/** Élément de liste Markdown d'une ligne : son environnement, son numéro, son texte ; null sinon. */
function listItem(line: string): { env: MdList["env"]; start: number; text: string } | null {
  const m = ITEM.exec(line);
  return m ? { env: m[1] ? "itemize" : "enumerate", start: m[2] ? Number(m[2]) : 1, text: m[3] } : null;
}

/** La liste en LaTeX, une ligne par élément ; une numérotation qui ne part pas de 1 est gardée. */
function listTex(l: MdList): string {
  const opts = l.env === "enumerate" && l.start !== 1 ? `nosep,start=${l.start}` : "nosep";
  return [`\\begin{${l.env}}[${opts}]`, ...l.items.map((i) => `\\item ${i}`), `\\end{${l.env}}`].join("\n");
}

/**
 * Texte de plusieurs lignes (énoncé, corrigé, scénario) → LaTeX : formules comme `texInline`,
 * lignes de puces ou de numéros consécutives en `itemize` / `enumerate` (le modèle écrit ses
 * listes en Markdown : elles se suivaient sur une seule ligne), ligne vide = nouveau paragraphe,
 * autre saut de ligne = `br` (par défaut un retour à la ligne, qui vaut une espace pour TeX).
 */
export function texText(s: string, br = "\n"): string {
  const out: string[] = [];
  let list = null as MdList | null;
  let sep = "";
  const close = () => {
    if (!list) return;
    out.push(`${sep}${listTex(list)}`);
    list = null;
    sep = "\n";
  };
  for (const line of (s ?? "").replace(/\s+$/, "").split("\n")) {
    const item = listItem(line);
    if (item) {
      if (list?.env !== item.env) {
        close();
        list = { env: item.env, start: item.start, items: [] };
        sep = out.length ? "\n" : "";
      }
      list!.items.push(texInline(item.text));
      continue;
    }
    close();
    if (!line.trim()) { if (out.length) sep = "\\par "; continue; }
    out.push(`${sep}${texInline(line)}`);
    sep = br;
  }
  close();
  return out.join("");
}

/**
 * Rend `fn` avec les formules en texte échappé, comme avant ce module : le repli d'un PDF qui ne
 * compile pas malgré la validation de `mathTex` (le PDF texte vaut mieux que pas de PDF).
 */
export function withFormulasAsText<T>(fn: () => Promise<T>): Promise<T> {
  return plainMath.run(true, fn);
}

/**
 * Rend et compile par `build` ; s'il échoue alors qu'une formule a été composée, recommence avec
 * les formules en texte (`asText`). Sans formule, l'échec remonte tel quel : rien à retenter.
 */
export async function formulasOrText<T>(build: () => Promise<T>): Promise<{ value: T; asText: boolean }> {
  const seen = { n: 0 };
  try {
    return { value: await composed.run(seen, build), asText: false };
  } catch (e) {
    if (!seen.n) throw e;
    console.error("[tex] formules en texte, la compilation échouait :", (e as Error).message);
    return { value: await withFormulasAsText(build), asText: true };
  }
}

/**
 * Une formule déjà isolée (`content`, sans ses délimiteurs) → `$…$` si `mathTex` la juge sûre,
 * sinon son source `source` échappé, lisible ; en texte aussi sous `withFormulasAsText`.
 */
export function formulaOrText(content: string, display: boolean, source: string): string {
  const tex = plainMath.getStore() ? null : mathTex(content);
  return tex === null ? esc(source) : composedMath(display ? displayTex(tex) : tex);
}

/** Maths déjà délimitées et code en ligne d'un source LaTeX : rien à y mettre entre dollars. */
const TEX_PROTECTED = /\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\(?:texttt|url|path|label|ref|eqref|cite|includegraphics)\s*(?:\[[^\]]*\])?\{[^{}]*\}|\\verb(\S)[\s\S]*?\1/g;

/**
 * Une ligne de LaTeX libre (question ouverte, examen écrit) où une formule est écrite hors des
 * maths (« Missing $ inserted ») : ses formules sans délimiteurs, reconnues comme dans
 * `texInline`, passent entre $…$. null : rien de tel, la ligne reste telle quelle.
 */
export function wrapBareFormulas(line: string): string | null {
  let out = "";
  let last = 0;
  let changed = false;
  const wrap = (piece: string) => {
    let res = "";
    let at = 0;
    for (const a of bareAtoms(piece)) {
      res += `${piece.slice(at, a.start)}$${piece.slice(a.start, a.end)}$`;
      at = a.end;
      changed = true;
    }
    return res + piece.slice(at);
  };
  for (const m of line.matchAll(TEX_PROTECTED)) {
    out += wrap(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += wrap(line.slice(last));
  return changed ? out : null;
}

/** Environnements où une ligne « - … » n'est pas une puce : code, figure, tableau, maths. */
const LITERAL_ENVS = /^(?:lstlisting|verbatim\*?|Verbatim|minted|comment|tikzpicture|tabular[x*]?|array|[pbvBV]?matrix|cases|align\*?|aligned|equation\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math|split)$/;

/**
 * Lignes d'un LaTeX libre, chacune marquée `free` hors des environnements littéraux
 * (LITERAL_ENVS) et des maths en display : là seulement une puce ou une formule nue se lisent.
 */
function texLines(tex: string): { line: string; free: boolean }[] {
  const envs: string[] = [];
  let display = false;
  return (tex ?? "").split("\n").map((line) => {
    const free = !envs.length && !display;
    for (const e of line.matchAll(/\\(begin|end)\{([^}]+)\}|\\\[|\\\]|\$\$/g)) {
      if (e[0] === "\\[") display = true;
      else if (e[0] === "\\]") display = false;
      else if (e[0] === "$$") display = !display;
      else if (LITERAL_ENVS.test(e[2])) {
        if (e[1] === "begin") envs.push(e[2]);
        else envs.pop();
      }
    }
    return { line, free };
  });
}

/**
 * Puces et numéros Markdown d'un LaTeX libre → `itemize` / `enumerate` (le texte des éléments
 * reste du LaTeX). Une ligne dans un environnement littéral (LITERAL_ENVS) ou dans des maths en
 * display ne bouge pas.
 */
export function markdownListsTex(tex: string): string {
  const out: string[] = [];
  let list = null as MdList | null;
  const close = () => {
    if (list) out.push(listTex(list));
    list = null;
  };
  for (const { line, free } of texLines(tex)) {
    const item = free ? listItem(line) : null;
    if (item) {
      if (list?.env !== item.env) {
        close();
        list = { env: item.env, start: item.start, items: [] };
      }
      list!.items.push(item.text);
      continue;
    }
    close();
    out.push(line);
  }
  close();
  return out.join("\n");
}

/** `wrapBareFormulas` sur tout un LaTeX libre, hors environnements littéraux et maths en display (aperçu HTML). */
export function wrapBareFormulasTex(tex: string): string {
  return texLines(tex).map(({ line, free }) => (free ? wrapBareFormulas(line) ?? line : line)).join("\n");
}
