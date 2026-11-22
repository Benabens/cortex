/**
 * Le préambule du dépôt (latex/preamble.tex) à la forme de la mise en page de l'annale : taille de
 * police et questions sur deux colonnes. Partagé par le rendu (lib/exam-layout-pdf) et par le garde
 * (lib/tex-guard), qui retire chaque forme comme texte de confiance : la forme ne vient que de ce
 * domaine fini, jamais d'un texte libre. Prod, 22/11/2026 : réécrit hors du garde, le préambule
 * d'une annale en 12 pt n'était plus reconnu, et tout examen de ce cours perdait son PDF.
 */
export type PreambleShape = { size: number; columns: number };

const SIZES = [10, 11, 12] as const;
const COLUMNS = [1, 2] as const;

/** Toutes les formes possibles : celles que le garde reconnaît. */
export const PREAMBLE_SHAPES: { size: (typeof SIZES)[number]; columns: (typeof COLUMNS)[number] }[] = SIZES.flatMap((size) => COLUMNS.map((columns) => ({ size, columns })));

/**
 * `src` à la forme `shape`. Une taille ou un nombre de colonnes hors domaine (profil relu en base)
 * garde le défaut : 11 pt, une colonne. multicol est préchauffé dans l'image (Dockerfile, contrôle
 * hors ligne de la CI).
 */
export function shapePreamble(src: string, shape: PreambleShape): string {
  let out = shape.size !== 11 && (SIZES as readonly number[]).includes(shape.size) ? src.replace(/\\documentclass\[11pt/, String.raw`\documentclass[${shape.size}pt`) : src;
  if (shape.columns === 2) out = out.replace(/\\usepackage\{needspace\}/, String.raw`\usepackage{needspace}` + "\n" + String.raw`\usepackage{multicol}`);
  return out;
}
