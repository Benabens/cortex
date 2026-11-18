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
];

/** Texte du modèle (énoncés, options) vers LaTeX : `texEscape`, typographie, symboles mathématiques. */
export function esc(s: string): string {
  let t = texEscape(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "--").replace(/—/g, "---")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  for (const [re, rep] of UMATH) t = t.replace(re, rep);
  // filet de sécurité : tout caractère exotique restant (> Latin-1) → espace, pour garantir la
  // compilation pdflatex (les symboles math fréquents sont déjà traités ci-dessus).
  t = t.replace(/[Ā-￿]/g, " ");
  return t;
}
