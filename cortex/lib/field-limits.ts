import { NextResponse } from "next/server";

/**
 * PLAFONDS PAR CHAMP des routes d'assistance (prix FIXE : 0,1 crédit l'appel).
 *
 * Le corps est déjà borné à 1 Mo (lib/upload-limit), mais 1 Mo de texte dans
 * un « concept » de drill = ~250 000 tokens facturés au prix d'une question :
 * le prix fixe n'a de sens que si la taille de ce qui part au modèle est
 * bornée elle aussi. Les plafonds sont larges pour un usage réel (un énoncé
 * d'examen tient en 8 000 caractères) et fermés pour un abus.
 */
export const FIELD_LIMITS = {
  /** drill : concept à travailler */
  concept: 500,
  /** check-solution : énoncé et réponse de l'étudiant */
  statement: 8000,
  answer: 8000,
  /** exercises/generate : cible et note libre */
  target: 2000,
  note: 2000,
  /** weaknesses/mine : texte collé (notes, énoncé raté) */
  text: 8000,
} as const;

export type LimitedField = keyof typeof FIELD_LIMITS;

const LABELS: Record<LimitedField, string> = {
  concept: "Le concept", statement: "L’énoncé", answer: "La réponse", target: "La cible", note: "La note", text: "Le texte",
};

/** Réponse 413 si `value` dépasse le plafond du champ, sinon null. */
export function fieldTooLong(field: LimitedField, value: string): NextResponse | null {
  const max = FIELD_LIMITS[field];
  if (value.length <= max) return null;
  return NextResponse.json(
    { error: `${LABELS[field]} dépasse ${max.toLocaleString("fr-FR")} caractères (${value.length.toLocaleString("fr-FR")} reçus). Raccourcis-le : l’assistance travaille sur un extrait, pas sur un document entier.`, field, max },
    { status: 413 },
  );
}
