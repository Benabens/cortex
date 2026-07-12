/**
 * Types Sources — formes réelles de GET /api/sources (500 sur cs-202) :
 * exams[] = annales/refs {path, title, year, kind, items, uploaded, isReference} ;
 * corpus[] = agrégats par type {type, sources, items}.
 * POST /api/refs/upload (multipart file[]) → {ok, files, formatJobId} ·
 * POST /api/sources/import {path} → JOB (409 sur cs-202) · POST /api/prepare → JOB.
 * NB : aucune route pour (dé)cocher isReference / activer un fichier → lecture seule.
 */

export type SourceExam = {
  path: string;
  title: string;
  year: number | null;
  kind: string; // "final" | "midterm" | …
  items: number;
  uploaded: boolean;
  isReference: boolean;
};

export type CorpusAgg = { type: string; sources: number; items: number };

export type SourcesResp = { exams: SourceExam[]; corpus: CorpusAgg[] };

export const CORPUS_LABEL: Record<string, string> = {
  course_pdf: "Cours (PDF)",
  lecture: "Cours",
  final: "Finals",
  midterm: "Midterms",
  serie: "Séries",
  exercise: "Exercices",
  cheatsheet: "Cheat sheets",
  review: "Reviews",
};

export function corpusLabel(type: string): string {
  return CORPUS_LABEL[type] ?? type;
}

export function extOf(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return (m?.[1] ?? "?").toUpperCase();
}
