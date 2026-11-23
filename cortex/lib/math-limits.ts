/**
 * Bornes d'une requête POST /api/math, partagées par la route et le client (lib/ux/math), qui découpe
 * ses lots en dessous ; au-delà, le texte reste tel quel. Le repérage des formules sans délimiteurs
 * (lib/tex-rich) croît vite avec la longueur d'un texte : 6 000 caractères de « x_1 » ≈ 0,2 s, d'où
 * un total par requête et pas seulement par texte.
 */
export const MATH_MAX_TEXTS = 300;
export const MATH_MAX_CHARS = 6_000;
export const MATH_MAX_TOTAL_CHARS = 40_000;
