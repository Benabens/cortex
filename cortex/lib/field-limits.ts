import { NextResponse } from "next/server";
import { apiError } from "@/lib/i18n/api-error";
import type { ErrorCode } from "@/lib/i18n/user-error";

/**
 * PLAFONDS PAR CHAMP des routes d'assistance (prix FIXE : celui d'une aide, creditCost("assist")).
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
  /** « Mets l'accent sur… » : exams/qcm/labs — quelques mots, pas un document */
  focus: 400,
  /** exercises/generate : cible et note libre */
  target: 2000,
  note: 2000,
  /**
   * feedback : remarque de calibration. Plus courte que `note` — elle est
   * CONSERVÉE et réinjectée dans les prompts suivants (six notes par archétype),
   * et c'est exactement ce que l'enregistrement garde : la route acceptait 2 000
   * caractères dont 1 400 disparaissaient avec une réponse 200.
   */
  feedbackNote: 600,
  /** weaknesses/mine : texte collé (notes, énoncé raté) */
  text: 8000,
  /** weaknesses (création) : sujet et note — repris tels quels par weaknesses/process (prix fixe) */
  topic: 300,
  description: 8000,
} as const;

export type LimitedField = keyof typeof FIELD_LIMITS;

const CODES: Record<LimitedField, ErrorCode> = {
  concept: "field_too_long_concept", statement: "field_too_long_statement", answer: "field_too_long_answer",
  target: "field_too_long_target", note: "field_too_long_note", text: "field_too_long_text",
  focus: "field_too_long_focus", feedbackNote: "field_too_long_feedback_note",
  topic: "field_too_long_topic", description: "field_too_long_note",
};

/** Réponse 413 si `value` dépasse le plafond du champ, sinon null. */
export function fieldTooLong(req: Request, field: LimitedField, value: string): NextResponse | null {
  const max = FIELD_LIMITS[field];
  if (value.length <= max) return null;
  return apiError(req, { code: CODES[field], params: { max, count: value.length } }, 413, { field, max });
}
