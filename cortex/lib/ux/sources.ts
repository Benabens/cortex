/**
 * Types Sources — formes réelles de GET /api/sources (500 sur cs-202) :
 * exams[] = annales/refs {path, title, year, kind, items, uploaded, isReference} ;
 * corpus[] = agrégats par type {type, sources, items}.
 * POST /api/refs/upload (multipart file[]) → {ok, files, formatPending} (gratuit) ·
 * POST /api/refs/format → JOB, {jobId, chargedCredits} (relire le format, payant) ·
 * POST /api/sources/import {path} → JOB (409 sur cs-202) · POST /api/prepare → JOB.
 * Choix des annales de référence : POST /api/sources {path, reference} (toggleReference) ·
 * DELETE /api/sources?path= (removeUploadedRef) — câblés en cases à cocher dans FileManager.
 */
import type { IngestProblem } from "@/lib/ingest-report";
import type { OriginalsNotice } from "@/lib/originals/retention";

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

/** Une source du corpus (tous types) avec deep-link « voir ». */
export type CorpusSourceItem = {
  type: string;
  title: string;
  path: string;
  year: number | null;
  items: number;
  href: string | null;
};

/** `unread` : les fichiers que la dernière ingestion n'a pas pu lire, encore rangés dans le cours. */
/**
 * Originaux du compte (lib/originals) : `home` « local » = compte gratuit, ses fichiers restent sur
 * son ordinateur ; `onComputer` = chemins dont Cortex ne garde que l'index ; `purgeOn` + `cloudFiles`
 * = fichiers encore dans le cloud après la fin du Premium, et le jour de leur suppression.
 */
/** Originaux du cours (GET /api/sources, lib/originals/retention courseOriginals). */
export type OriginalsInfo = OriginalsNotice & { onComputer: string[]; cloudFiles: number };

export type SourcesResp = { exams: SourceExam[]; corpus: CorpusAgg[]; sources?: CorpusSourceItem[]; unread?: IngestProblem[]; originals?: OriginalsInfo | null };

export const CORPUS_LABEL: Record<string, CorpusLabelKey> = {
  course_pdf: "corpusCoursePdf",
  lecture: "corpusLecture",
  final: "corpusFinal",
  midterm: "corpusMidterm",
  serie: "corpusSerie",
  exercise: "corpusExercise",
  cheatsheet: "corpusCheatsheet",
  review: "corpusReview",
};

export type CorpusLabelKey = "corpusCoursePdf" | "corpusLecture" | "corpusFinal" | "corpusMidterm" | "corpusSerie" | "corpusExercise" | "corpusCheatsheet" | "corpusReview";

export function corpusLabel(type: string, t: (key: CorpusLabelKey) => string): string {
  const key = CORPUS_LABEL[type];
  return key ? t(key) : type;
}

export function extOf(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return (m?.[1] ?? "?").toUpperCase();
}
