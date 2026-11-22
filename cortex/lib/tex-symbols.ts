/**
 * MACROS MATHS DU LaTeX DES EXAMENS → TEXTE UNICODE, pour l'aperçu HTML (texToHtml).
 *
 * Le PDF reste le vrai rendu ; l'aperçu, lui, effaçait toute macro inconnue : « $O(n \log n)$ »
 * devenait « O(n  n) », « $a \leq b$ » « a  b ». Les entrées travaillent sur du texte DÉJÀ
 * échappé pour le HTML (« < » y vaut « &lt; »).
 */

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/** Symboles sans argument. Les signes « < » « > » sortent échappés : le texte autour l'est déjà. */
export const TEX_SYMBOLS: Record<string, string> = {
  ...GREEK,
  le: "≤", leq: "≤", leqslant: "≤", ge: "≥", geq: "≥", geqslant: "≥", ne: "≠", neq: "≠", lt: "&lt;", gt: "&gt;",
  approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  prec: "≺", succ: "≻", preceq: "⪯", succeq: "⪰", triangleq: "≜", coloneqq: "≔",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  oplus: "⊕", otimes: "⊗", odot: "⊙", wedge: "∧", land: "∧", vee: "∨", lor: "∨", neg: "¬", lnot: "¬",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", subsetneq: "⊊", supset: "⊃", supseteq: "⊇",
  cup: "∪", cap: "∩", bigcup: "⋃", bigcap: "⋂", setminus: "∖", emptyset: "∅", varnothing: "∅", complement: "∁",
  forall: "∀", exists: "∃", nexists: "∄", top: "⊤", bot: "⊥", perp: "⊥", mid: "∣", nmid: "∤",
  parallel: "∥", vdash: "⊢", models: "⊨",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  implies: "⇒", Leftarrow: "⇐", impliedby: "⇐", Leftrightarrow: "⇔", iff: "⇔", mapsto: "↦",
  longrightarrow: "⟶", longleftarrow: "⟵", Longrightarrow: "⟹", Longleftarrow: "⟸",
  Longleftrightarrow: "⟺", uparrow: "↑", downarrow: "↓", hookrightarrow: "↪", rightsquigarrow: "⇝",
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", oint: "∮",
  ldots: "…", dots: "…", dotsc: "…", dotsb: "⋯", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", langle: "⟨", rangle: "⟩",
  lvert: "|", rvert: "|", vert: "|", lVert: "‖", rVert: "‖", Vert: "‖",
  ell: "ℓ", hbar: "ℏ", aleph: "ℵ", Re: "ℜ", Im: "ℑ", wp: "℘", prime: "′", angle: "∠", triangle: "△",
  square: "□", Box: "□", checkmark: "✓", colon: ":", dagger: "†", ddagger: "‡", S: "§",
  // Tailles et habillage sans contenu propre : rien à afficher.
  left: "", right: "", big: "", Big: "", bigg: "", Bigg: "", bigl: "", bigr: "", Bigl: "", Bigr: "",
  biggl: "", biggr: "", displaystyle: "", textstyle: "", scriptstyle: "", limits: "", nolimits: "",
};

/** Noms de fonctions écrits en romain : gardés (et détachés de ce qui précède : « n\log n »). */
const FUNCTIONS = [
  "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "csc", "deg", "det", "dim", "exp",
  "gcd", "hom", "inf", "ker", "lcm", "lg", "lim", "liminf", "limsup", "ln", "log", "max", "min", "Pr",
  "sec", "sin", "sinh", "sup", "tan", "tanh", "bmod", "mod",
];
const FUNC_RE = new RegExp(`([\\p{L}\\p{N})\\]]?)\\\\(${FUNCTIONS.join("|")})(?![a-zA-Z])`, "gu");

const BLACKBOARD: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", P: "ℙ", E: "𝔼", F: "𝔽" };

/** Un argument de plus d'un caractère prend des parenthèses : « n+1 » / 2 → « (n+1)/2 ». */
const group = (s: string) => (/^\s*[\p{L}\p{N}]\s*$|^\s*\p{N}+\s*$/u.test(s) ? s.trim() : `(${s.trim()})`);

/** Contenu d'un $…$ (déjà échappé HTML) → texte Unicode ; exposants et indices restent à poser. */
export function texMathSymbols(m: string): string {
  let s = m;
  for (let pass = 0; pass < 2; pass++) {
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => `${group(a)}/${group(b)}`)
      .replace(/\\[dt]?frac\s*(\d)\s*(\d)/g, "$1/$2")
      .replace(/\\binom\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => `C(${a.trim()}, ${b.trim()})`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a: string) => `√${group(a)}`);
  }
  return s
    .replace(/\\mathbb\s*\{([A-Z])\}/g, (_, l: string) => BLACKBOARD[l] ?? l)
    .replace(/\\pmod\s*\{([^{}]*)\}/g, (_, a: string) => ` (mod ${a.trim()})`)
    .replace(/\^\s*\{?\\circ\}?/g, "°")
    .replace(FUNC_RE, (_, pre: string, f: string) => `${pre}${pre ? " " : ""}${f === "bmod" ? "mod" : f}`)
    .replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, (whole, name: string) => TEX_SYMBOLS[name] ?? whole);
}
