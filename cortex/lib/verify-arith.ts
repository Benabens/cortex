/**
 * CONTRÔLES DÉTERMINISTES D'UN CORRIGÉ, sans modèle (banc du 23/11/2026 : égalités fausses écrites
 * en clair, sous-question laissée sans réponse). Deux contrôles, conservateurs : une égalité qui ne
 * se lit pas sans doute (unités, indices, exposants, milliers séparés par une espace, membre de
 * droite qui est lui-même une expression) est ignorée, jamais signalée.
 *
 *  - arithmeticSlips : chaque égalité « a op b … = c » entièrement numérique (décimal, virgule
 *    française, hexadécimal 0x…, \times, \cdot, \frac{a}{b}) est recalculée ;
 *  - missingSubquestions : les \subq{…} de l'énoncé que le corrigé ne nomme jamais.
 *
 * Les deux nourrissent la comparaison de lib/verify (le modèle tranche) : une égalité fausse peut
 * être citée exprès (« et non 600 + 350 = 900 »), elle ne rejette donc rien à elle seule.
 */

export type ArithSlip = { expr: string; claimed: string; actual: string };

const HEX = String.raw`0[xX][0-9A-Fa-f]+`;
// Milliers par espace fine ou « \, » seulement : une espace ordinaire sépare aussi deux nombres.
const DEC = String.raw`\d+(?:(?:\\,|\{\\,\}|[   ])\d{3})*(?:(?:\{,\}|[.,])\d+)?`;
const NUM = `(?:${HEX}|${DEC})`;
const OP = String.raw`(?:\+|-|−|\*|×|·|/|\\times|\\cdot)`;
const TERM = String.raw`\(*\s*${NUM}\s*\)*`;
// Premier terme signé admis (« z = −0.12 + 0.6 = 0.48 ») : le signe fait partie de l'expression.
const EXPR = `[-−]?\\s*${TERM}(?:\\s*${OP}\\s*${TERM})+`;
/** Expression la plus longue en fin de texte (avant « = »). */
const LEFT = new RegExp(String.raw`(${EXPR})\s*$`);
/**
 * Ce qui peut précéder une expression autonome : début, « = », « : », séparateur, flèche, ou un mot
 * de deux lettres au moins (« soit », « donc »). Une lettre seule (« e −1.21 + 0.35 » : exposant
 * aplati), une fonction (√, exp, log, ½…), un opérateur, un chiffre, une parenthèse ou une commande
 * LaTeX font de l'expression la fin d'une autre plus grande : elle n'est pas recalculée.
 */
const FUNCS = new Set(["exp", "log", "ln", "lg", "sqrt", "sin", "cos", "tan", "max", "min", "mod", "det", "tr", "abs"]);
function standsAlone(before: string): boolean {
  const b = before.replace(/\s+$/u, "");
  if (!b || b.endsWith("\\\\")) return true;
  const c = b[b.length - 1];
  if ("=:;,←→⇒⟹≡|".includes(c)) return true;
  const word = /(\\?)(\p{L}+)$/u.exec(b);
  return !!word && !word[1] && word[2].length >= 2 && !FUNCS.has(word[2].toLowerCase()) && !/[_^]$/.test(b.slice(0, -word[2].length));
}
/** Valeur annoncée juste après « = » (gras, encadré, signe admis). */
const RIGHT = new RegExp(String.raw`^\s*(?:\\(?:textbf|mathbf|boxed)\{)?\s*([-−]?\s*${NUM})`);

/** \frac{3}{4} → (3)/(4) quand numérateur et dénominateur sont des nombres. */
function unfrac(s: string): string {
  return s.replace(new RegExp(String.raw`\\[dt]?frac\{\s*(${NUM})\s*\}\{\s*(${NUM})\s*\}`, "g"), "($1)/($2)");
}

/** Valeur d'un nombre écrit (hexadécimal, décimal à point ou virgule, milliers fins). */
function numberOf(raw: string): { v: number; decimals: number; hex: boolean } {
  const t = raw.replace(/\s+/g, "");
  const neg = /^[-−]/.test(t);
  const body = t.replace(/^[-−]/, "");
  if (/^0[xX]/.test(body)) return { v: (neg ? -1 : 1) * parseInt(body.slice(2), 16), decimals: 0, hex: true };
  const plain = body.replace(/\\,|\{\\,\}|[   ]/g, "").replace("{,}", ".").replace(",", ".");
  const dot = plain.indexOf(".");
  return { v: (neg ? -1 : 1) * Number(plain), decimals: dot < 0 ? 0 : plain.length - dot - 1, hex: false };
}

type Tok = { k: "n"; v: number } | { k: "op"; v: string } | { k: "(" } | { k: ")" };

function tokens(expr: string): Tok[] | null {
  const out: Tok[] = [];
  const re = new RegExp(String.raw`\s*(?:(${NUM})|(${OP})|(\()|(\)))`, "y");
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) return expr.slice(i).trim() ? null : out;
    i = re.lastIndex;
    if (m[1]) out.push({ k: "n", v: numberOf(m[1]).v });
    else if (m[2]) out.push({ k: "op", v: /^(?:\*|×|·|\\times|\\cdot)$/.test(m[2]) ? "*" : m[2] === "−" ? "-" : m[2] });
    else if (m[3]) out.push({ k: "(" });
    else out.push({ k: ")" });
  }
  return out;
}

/** Évaluation à priorités usuelles (× et / avant + et −) ; null si l'expression est mal formée. */
function evaluate(toks: Tok[]): number | null {
  let pos = 0;
  const atom = (): number | null => {
    const t = toks[pos++];
    if (!t) return null;
    if (t.k === "n") return t.v;
    if (t.k === "op" && t.v === "-") { const a = atom(); return a === null ? null : -a; }
    if (t.k === "(") { const v = sum(); if (toks[pos++]?.k !== ")") return null; return v; }
    return null;
  };
  const product = (): number | null => {
    let v = atom();
    while (v !== null && toks[pos]?.k === "op" && ["*", "/"].includes((toks[pos] as { v: string }).v)) {
      const op = (toks[pos++] as { v: string }).v;
      const b = atom();
      if (b === null || (op === "/" && b === 0)) return null;
      v = op === "*" ? v * b : v / b;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && toks[pos]?.k === "op" && ["+", "-"].includes((toks[pos] as { v: string }).v)) {
      const op = (toks[pos++] as { v: string }).v;
      const b = product();
      if (b === null) return null;
      v = op === "+" ? v + b : v - b;
    }
    return v;
  };
  const v = sum();
  return v !== null && pos === toks.length && Number.isFinite(v) ? v : null;
}

const ENTITIES: Record<string, string> = { minus: "−", times: "×", middot: "·", nbsp: " ", thinsp: "\u2009", lt: "<", gt: ">", amp: "&" };

/**
 * Texte d'un corrigé LaTeX ou HTML ramené à ses formules : les exposants et indices HTML gardent
 * leur marque (« 10<sup>−10</sup> » → « 10^{−10} », jamais « 10 −10 »), les balises tombent.
 */
function plainMath(text: string): string {
  return String(text ?? "")
    .replace(/<sup>([^<]*)<\/sup>/gi, "^{$1}").replace(/<sub>([^<]*)<\/sub>/gi, "_{$1}")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(minus|times|middot|nbsp|thinsp|lt|gt|amp);/g, (_, e: string) => ENTITIES[e])
    .replace(/\\texttt\{([^{}]*)\}/g, "$1").replace(/\$/g, " ");
}

/** `claimed` (écrit avec `decimals` décimales) est-il `actual` arrondi ou tronqué ? Exact pour un calcul entier. */
function matchesRounded(actual: number, claimed: number, decimals: number, exact: boolean): boolean {
  const eps = 1e-9 * Math.max(1, Math.abs(actual));
  if (exact && decimals === 0) return Math.abs(actual - claimed) <= eps;
  const unit = 10 ** -decimals;
  // Opérandes décimaux eux-mêmes arrondis (« 4,0455 / 1,6189 = 2,4990 ») : écart relatif de 0,05 % admis.
  if (Math.abs(actual - claimed) <= Math.max(unit / 2, 5e-4 * Math.abs(actual)) + eps) return true;
  return Math.abs(Math.trunc(actual / unit + Math.sign(actual) * 1e-9) * unit - claimed) <= eps;
}

/** Égalités numériques fausses d'un texte (LaTeX ou HTML), dans leur ordre d'apparition. */
export function arithmeticSlips(text: string): ArithSlip[] {
  const s = unfrac(plainMath(text));
  const out: ArithSlip[] = [];
  for (let at = s.indexOf("="); at >= 0; at = s.indexOf("=", at + 1)) {
    // « == », « <= », « >= », « != » : comparaison de code, pas une égalité.
    if (/[=<>!]/.test(s[at - 1] ?? "") || s[at + 1] === "=") continue;
    const window = s.slice(Math.max(0, at - 200), at);
    const left = LEFT.exec(window);
    if (left && !standsAlone(window.slice(0, left.index))) continue;
    const right = RIGHT.exec(s.slice(at + 1, at + 80));
    if (!left || !right) continue;
    const after = s.slice(at + 1 + right[0].length);
    // Valeur suivie d'un opérateur, d'un exposant, d'une suite de chiffres ou d'un milliers à espace : pas une valeur finale.
    if (new RegExp(String.raw`^\s*(?:${OP}|\^|_)|^\s\d{3}\b|^\d|^[.,]\d`).test(after)) continue;
    const expr = left[1].trim();
    if ((expr.match(/\(/g) ?? []).length !== (expr.match(/\)/g) ?? []).length) continue;
    const toks = tokens(expr);
    const actual = toks ? evaluate(toks) : null;
    if (actual === null) continue;
    const claimed = numberOf(right[1]);
    const exact = !/\//.test(expr) && !/[.,]\d/.test(expr.replace(new RegExp(HEX, "g"), ""));
    // Valeur annoncée = le résultat arrondi ou tronqué à ses décimales (« 2/3 = 0,67 » ou « 0,66 ») ;
    // « 5.2/6.5 = 80 % » : la valeur annoncée est un pourcentage du résultat.
    const percent = /^\s*\\?%/.test(after);
    if ([actual, ...(percent ? [actual * 100] : [])].some((x) => matchesRounded(x, claimed.v, claimed.decimals, exact))) continue;
    const hex = /0[xX]/.test(expr) && claimed.hex;
    const shown = hex && Number.isInteger(actual) ? `0x${actual.toString(16).toUpperCase()}` : String(Math.round(actual * 1e6) / 1e6);
    out.push({ expr, claimed: right[1].trim(), actual: shown });
  }
  return out;
}

/** Étiquettes \subq{…} d'un énoncé. */
export function subquestionLabels(statement: string): string[] {
  return [...String(statement ?? "").matchAll(/\\subq\{([^}]+)\}/g)].map((m) => m[1].trim());
}

/** Le corrigé nomme-t-il cette étiquette (« 1.6 », sans la confondre avec « 1.61 » ni « 11.6 ») ? */
export function namesLabel(text: string, label: string): boolean {
  return new RegExp(`(?<![\\d.])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text);
}

/** Sous-questions de l'énoncé que le corrigé ne nomme jamais (corrigé interrompu, partie oubliée). */
export function missingSubquestions(statement: string, solution: string): string[] {
  return subquestionLabels(statement).filter((l) => !namesLabel(solution ?? "", l));
}
