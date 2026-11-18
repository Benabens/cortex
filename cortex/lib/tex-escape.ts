/** Échappements du texte brut vers LaTeX (partagés par les rendus d'examen). */
const TEX_SPECIAL: Record<string, string> = { "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
/** Échappe le texte BRUT (titres, concepts, métadonnées du cours) pour LaTeX. NE PAS appliquer au LaTeX du modèle. */
export function texEscape(s: string): string {
  // Une seule passe : échapper « \ » puis « { } » à part donnait « \textbackslash\{\} » (« \{} » dans le PDF).
  return (s ?? "").replace(/[\\&%$#_{}~^]/g, (ch) => TEX_SPECIAL[ch] ?? `\\${ch}`);
}

/** Contenu d'un QR code : le code du cours est saisi par l'utilisateur, seuls lettres, chiffres, « . » et « - » passent. */
export function qrText(s: string): string {
  return (s ?? "").replace(/[^A-Za-z0-9.-]/g, "");
}

// Unicode math → LaTeX : la police du texte n'a pas ces symboles, le mode mathématique si.
const UMATH: [RegExp, string][] = [
  [/[α]/g, "\\ensuremath{\\alpha}"], [/[β]/g, "\\ensuremath{\\beta}"], [/[γ]/g, "\\ensuremath{\\gamma}"], [/[δ]/g, "\\ensuremath{\\delta}"], [/[Δ]/g, "\\ensuremath{\\Delta}"],
  [/[ε]/g, "\\ensuremath{\\epsilon}"], [/[ζ]/g, "\\ensuremath{\\zeta}"], [/[η]/g, "\\ensuremath{\\eta}"], [/[θ]/g, "\\ensuremath{\\theta}"], [/[λ]/g, "\\ensuremath{\\lambda}"],
  [/[μ]/g, "\\ensuremath{\\mu}"], [/[ν]/g, "\\ensuremath{\\nu}"], [/[ξ]/g, "\\ensuremath{\\xi}"], [/[π]/g, "\\ensuremath{\\pi}"], [/[ρ]/g, "\\ensuremath{\\rho}"],
  [/[σ]/g, "\\ensuremath{\\sigma}"], [/[Σ]/g, "\\ensuremath{\\Sigma}"], [/[τ]/g, "\\ensuremath{\\tau}"], [/[φ]/g, "\\ensuremath{\\phi}"], [/[Φ]/g, "\\ensuremath{\\Phi}"],
  [/[χ]/g, "\\ensuremath{\\chi}"], [/[ψ]/g, "\\ensuremath{\\psi}"], [/[ω]/g, "\\ensuremath{\\omega}"], [/[Ω]/g, "\\ensuremath{\\Omega}"],
  [/[∂]/g, "\\ensuremath{\\partial}"], [/[∇]/g, "\\ensuremath{\\nabla}"], [/[∞]/g, "\\ensuremath{\\infty}"], [/[√]/g, "\\ensuremath{\\sqrt{\\ }}"],
  [/[∑]/g, "\\ensuremath{\\sum}"], [/[∏]/g, "\\ensuremath{\\prod}"], [/[∈]/g, "\\ensuremath{\\in}"], [/[∉]/g, "\\ensuremath{\\notin}"], [/[∩]/g, "\\ensuremath{\\cap}"], [/[∪]/g, "\\ensuremath{\\cup}"],
  [/[≤]/g, "\\ensuremath{\\le}"], [/[≥]/g, "\\ensuremath{\\ge}"], [/[≠]/g, "\\ensuremath{\\neq}"], [/[≈]/g, "\\ensuremath{\\approx}"], [/[≡]/g, "\\ensuremath{\\equiv}"],
  [/[×]/g, "\\ensuremath{\\times}"], [/[÷]/g, "\\ensuremath{\\div}"], [/[·∙]/g, "\\ensuremath{\\cdot}"], [/[±]/g, "\\ensuremath{\\pm}"], [/[∝]/g, "\\ensuremath{\\propto}"],
  [/[→]/g, "\\ensuremath{\\to}"], [/[⇒]/g, "\\ensuremath{\\Rightarrow}"], [/[←]/g, "\\ensuremath{\\leftarrow}"], [/[↦]/g, "\\ensuremath{\\mapsto}"],
  [/[‖]/g, "\\ensuremath{\\|}"], [/[⟨]/g, "\\ensuremath{\\langle}"], [/[⟩]/g, "\\ensuremath{\\rangle}"], [/[∀]/g, "\\ensuremath{\\forall}"], [/[∃]/g, "\\ensuremath{\\exists}"],
  [/²/g, "\\textsuperscript{2}"], [/³/g, "\\textsuperscript{3}"], [/¹/g, "\\textsuperscript{1}"],
  [/½/g, "\\ensuremath{\\frac12}"], [/¼/g, "\\ensuremath{\\frac14}"], [/[⁻]/g, "\\ensuremath{^{-}}"], [/[ℝ]/g, "\\ensuremath{\\mathbb{R}}"], [/[ℓ]/g, "\\ensuremath{\\ell}"], [/[°]/g, "\\ensuremath{^\\circ}"],
  // Ligatures du français, au-delà de Latin-1 : sans elles le filet ci-dessous coupait « cœur » en « c ur ».
  [/œ/g, "\\oe{}"], [/Œ/g, "\\OE{}"],
  [/[−]/g, "\\ensuremath{-}"], [/[′]/g, "\\ensuremath{'}"], [/[″]/g, "\\ensuremath{''}"], [/[∼∿]/g, "\\ensuremath{\\sim}"], [/[∘]/g, "\\ensuremath{\\circ}"], [/[⊙]/g, "\\ensuremath{\\odot}"],
  [/[⊗]/g, "\\ensuremath{\\otimes}"], [/[⊕]/g, "\\ensuremath{\\oplus}"], [/[⊤]/g, "\\ensuremath{\\top}"], [/[⊥]/g, "\\ensuremath{\\perp}"], [/[…]/g, "\\ldots{}"], [/[•]/g, "\\ensuremath{\\bullet}"],
  // Ensembles, logique, relations et flèches des QCM de maths et de logique : avant, le filet
  // ci-dessous les effaçait et « A ⊆ B » s'imprimait « A   B » (audit du 16/11/2026, P1-11).
  [/⊆/g, "\\ensuremath{\\subseteq}"], [/⊇/g, "\\ensuremath{\\supseteq}"], [/⊊/g, "\\ensuremath{\\subsetneq}"], [/⊋/g, "\\ensuremath{\\supsetneq}"],
  [/⊈/g, "\\ensuremath{\\nsubseteq}"], [/⊄/g, "\\ensuremath{\\not\\subset}"], [/⊂/g, "\\ensuremath{\\subset}"], [/⊃/g, "\\ensuremath{\\supset}"],
  [/∖/g, "\\ensuremath{\\setminus}"], [/∅/g, "\\ensuremath{\\emptyset}"], [/∋/g, "\\ensuremath{\\ni}"], [/∁/g, "\\ensuremath{\\complement}"],
  [/ℕ/g, "\\ensuremath{\\mathbb{N}}"], [/ℤ/g, "\\ensuremath{\\mathbb{Z}}"], [/ℚ/g, "\\ensuremath{\\mathbb{Q}}"], [/ℂ/g, "\\ensuremath{\\mathbb{C}}"], [/ℙ/g, "\\ensuremath{\\mathbb{P}}"],
  [/∧/g, "\\ensuremath{\\land}"], [/∨/g, "\\ensuremath{\\lor}"], [/⊻/g, "\\ensuremath{\\veebar}"], [/∄/g, "\\ensuremath{\\nexists}"], [/⊢/g, "\\ensuremath{\\vdash}"], [/⊨/g, "\\ensuremath{\\models}"],
  [/⇔/g, "\\ensuremath{\\Leftrightarrow}"], [/↔/g, "\\ensuremath{\\leftrightarrow}"], [/⇐/g, "\\ensuremath{\\Leftarrow}"], [/↑/g, "\\ensuremath{\\uparrow}"], [/↓/g, "\\ensuremath{\\downarrow}"],
  [/⟹/g, "\\ensuremath{\\Longrightarrow}"], [/⟸/g, "\\ensuremath{\\Longleftarrow}"], [/⟺/g, "\\ensuremath{\\Longleftrightarrow}"], [/⟶/g, "\\ensuremath{\\longrightarrow}"],
  [/≅/g, "\\ensuremath{\\cong}"], [/≃/g, "\\ensuremath{\\simeq}"], [/≪/g, "\\ensuremath{\\ll}"], [/≫/g, "\\ensuremath{\\gg}"], [/≺/g, "\\ensuremath{\\prec}"], [/≻/g, "\\ensuremath{\\succ}"],
  [/≼/g, "\\ensuremath{\\preceq}"], [/≽/g, "\\ensuremath{\\succeq}"], [/≜/g, "\\ensuremath{\\triangleq}"], [/∣/g, "\\ensuremath{\\mid}"], [/∤/g, "\\ensuremath{\\nmid}"], [/∥/g, "\\ensuremath{\\parallel}"],
  [/∫/g, "\\ensuremath{\\int}"], [/∮/g, "\\ensuremath{\\oint}"], [/⌊/g, "\\ensuremath{\\lfloor}"], [/⌋/g, "\\ensuremath{\\rfloor}"], [/⌈/g, "\\ensuremath{\\lceil}"], [/⌉/g, "\\ensuremath{\\rceil}"],
  [/∠/g, "\\ensuremath{\\angle}"], [/△/g, "\\ensuremath{\\triangle}"], [/ℏ/g, "\\ensuremath{\\hbar}"], [/ℵ/g, "\\ensuremath{\\aleph}"], [/∆/g, "\\ensuremath{\\Delta}"],
  [/Γ/g, "\\ensuremath{\\Gamma}"], [/Θ/g, "\\ensuremath{\\Theta}"], [/Λ/g, "\\ensuremath{\\Lambda}"], [/Ξ/g, "\\ensuremath{\\Xi}"], [/Π/g, "\\ensuremath{\\Pi}"], [/Ψ/g, "\\ensuremath{\\Psi}"],
  [/ι/g, "\\ensuremath{\\iota}"], [/κ/g, "\\ensuremath{\\kappa}"], [/υ/g, "\\ensuremath{\\upsilon}"], [/ϕ/g, "\\ensuremath{\\phi}"], [/ϵ/g, "\\ensuremath{\\epsilon}"], [/ο/g, "o"],
  [/€/g, "\\texteuro{}"], [/[\u2009\u202F]/g, "\\,"], [/„/g, ",,"],
];

/** Lettres sans décomposition en lettre + accent. */
const LETTERS: Record<string, string> = { "Ł": "\\L{}", "ł": "\\l{}", "Đ": "\\DJ{}", "đ": "\\dj{}", "ı": "\\i{}", "Ŋ": "\\NG{}", "ŋ": "\\ng{}", "ẞ": "\\SS{}" };
/** Accent combinant (forme NFD) → commande d'accent LaTeX du codage T1. */
const ACCENTS: Record<string, string> = {
  "\u0300": "`", "\u0301": "'", "\u0302": "^", "\u0303": "~", "\u0304": "=", "\u0306": "u", "\u0307": ".", "\u0308": '"',
  "\u030A": "r", "\u030B": "H", "\u030C": "v", "\u0323": "d", "\u0327": "c", "\u0328": "k", "\u0331": "b",
};

/**
 * Lettre latine au-delà de Latin-1 (Ł, ő, Č, ř, İ, ş, ă…) → sa commande d'accent : le filet
 * l'effaçait (« Erdős » → « Erd s »). null : aucune écriture connue, le filet décide.
 */
function latinLetterTex(ch: string): string | null {
  if (LETTERS[ch]) return LETTERS[ch];
  const [base, ...marks] = [...ch.normalize("NFD")];
  if (!marks.length || !/^[A-Za-z]$/.test(base)) return null;
  let out = base;
  for (const m of marks) {
    const cmd = ACCENTS[m];
    if (!cmd) return null;
    out = `\\${cmd}{${out}}`;
  }
  return out;
}

/** Une lettre grecque de la table : symbole mathématique isolé, mais texte dans une phrase grecque. */
const isGreekLetter = (re: RegExp) => /\p{Script=Greek}/u.test(re.source);

/** `esc` sans le filet final : ce qui reste au-delà de Latin-1 n'a aucune commande LaTeX connue. */
function escapeKnown(s: string): string {
  let t = texEscape(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "--").replace(/—/g, "---")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // Un mot grec (deux lettres de suite) : le texte est en grec, ses lettres restent du texte
  // (« η » article, pas η en italique mathématique) ; la police Unicode les imprime.
  const greekText = /\p{Script=Greek}{2}/u.test(t);
  for (const [re, rep] of UMATH) if (!(greekText && isGreekLetter(re))) t = t.replace(re, rep);
  return t.replace(/[\u0100-\u024F\u1E00-\u1EFF]/g, (ch) => latinLetterTex(ch) ?? ch);
}

/**
 * Ce qui reste au-delà de Latin-1 après `escapeKnown` et que le PDF ne sait pas écrire : un symbole
 * sans commande (⌘). Les lettres, chiffres, accents et ponctuations de toute écriture (cyrillique,
 * grec, chinois…) s'impriment tels quels, en police Unicode (latex/unicode-fonts.tex).
 */
const UNTYPESET = /(?![\p{L}\p{M}\p{N}\p{P}\p{Zs}])[^\x00-\xFF]/gu;

/** Toutes les chaînes d'une valeur (texte, liste, objet imbriqué). */
function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringsOf);
  return [];
}

/**
 * Symboles qu'`esc` ne sait pas écrire (il les remplace par une espace), dans toutes les chaînes
 * des valeurs reçues : une question qui en contient s'imprimerait fausse, le générateur l'écarte
 * (lib/qcm.ts) ou la renvoie au modèle (lib/blocks.ts) plutôt. Jamais une lettre : l'écriture du
 * cours, quelle qu'elle soit, n'est pas un motif d'écart.
 */
export function untypesetChars(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(stringsOf).flatMap((s) => escapeKnown(s).match(UNTYPESET) ?? []))];
}

/** Texte du modèle (énoncés, options) vers LaTeX : `texEscape`, typographie, symboles mathématiques. */
export function esc(s: string): string {
  // filet de sécurité : un symbole sans commande connue → espace (cf. untypesetChars) ; les
  // lettres de toute écriture restent, lib/exam-latex charge alors une police Unicode.
  return escapeKnown(s).replace(UNTYPESET, " ");
}
