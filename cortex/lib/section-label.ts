/**
 * Le nom d'une section de l'annale modèle, sans son numéro. Les sections s'appellent souvent
 * « Question 4 » ou « Q2: Moderation » : affiché à côté du numéro de l'examen, ce numéro-là le
 * contredisait dès qu'une question tombait (prod, 22/11/2026 : « Question 3 · Question 4 »).
 * Module pur, lu par le serveur (PDF) et par l'écran.
 */
const NUMBERING = new RegExp(
  String.raw`^(?:questions?|q|exercises?|exercices?|exercise|problems?|probl[eè]mes?|parts?|parties?|sections?|tasks?|aufgabe|frage|teil|ejercicio|pregunta|parte|esercizio|domanda)` +
    String.raw`\s*(?:n[°o]\.?\s*)?(?:\d+[a-z]?|[ivxlc]+|[a-h])(?![\p{L}\p{N}])[\s.:)\-–—·,]*`,
  "iu",
);

/** Ce qui reste du nom une fois son numéro retiré ; null s'il n'était qu'un numéro. */
export function sectionLabel(name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  const rest = s.replace(NUMBERING, "").trim();
  if (rest === s) return s;
  return rest || null;
}
