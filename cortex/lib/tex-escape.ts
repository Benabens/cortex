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

// Unicode math → LaTeX (pdflatex ne gère pas l'UTF-8 math ; tectonic oui mais absent ici).
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

/** `esc` sans le filet final : ce qui reste au-delà de Latin-1 n'a aucune écriture LaTeX connue. */
function escapeKnown(s: string): string {
  let t = texEscape(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "--").replace(/—/g, "---")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  for (const [re, rep] of UMATH) t = t.replace(re, rep);
  return t.replace(/[\u0100-\u024F\u1E00-\u1EFF]/g, (ch) => latinLetterTex(ch) ?? ch);
}

/**
 * Caractères qu'`esc` ne sait pas écrire (il les remplace par une espace) : une question qui en
 * contient s'imprimerait fausse, le générateur l'écarte plutôt (lib/qcm.ts).
 */
export function untypesetChars(...texts: string[]): string[] {
  return [...new Set(texts.flatMap((s) => escapeKnown(s ?? "").match(/[^\x00-\xFF]/gu) ?? []))];
}

/** Texte du modèle (énoncés, options) vers LaTeX : `texEscape`, typographie, symboles mathématiques. */
export function esc(s: string): string {
  // filet de sécurité : tout caractère exotique restant (> Latin-1) → espace, pour garantir la
  // compilation pdflatex (symboles et lettres connus déjà traités ; cf. untypesetChars).
  return escapeKnown(s).replace(/[Ā-￿]/g, " ");
}
