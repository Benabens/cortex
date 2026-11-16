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
