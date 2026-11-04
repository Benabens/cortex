import fs from "node:fs";
import type { SynthFormat, SynthSpec } from "./synth";

/**
 * CAS DU BANC — chacun = un cours restauré + UNE demande. Les cas synthétiques (domaine
 * inventé, lib/bench/synth) vivent ici ; les cas de vrais cours (dumps, supports) vivent
 * HORS du dépôt, dans le fichier JSON désigné par CORTEX_BENCH_CASES (même forme) : aucun
 * contenu de cours ni chemin personnel dans git.
 */

export type CaseSource =
  /** Dump Postgres d'un schéma de cours (`pg_dump -Fc -n <schéma>`), renommé au restaurer. */
  | { kind: "dump"; file: string; schema?: string; refsDir?: string }
  /** Supports locaux : copiés dans le cours puis préparés (job prepare), une fois, puis instantané. */
  | { kind: "folder"; dirs: { path: string; category?: "lecture" | "exam_info" | "sample_questions" | "notes"; exclude?: string[] }[] }
  | { kind: "synth"; spec: SynthSpec; format: SynthFormat };

export type BenchCase = {
  id: string;
  title: string;
  /** Cours créé pour le run (le cours statique cs-202 garde son identifiant : `staticId`). */
  course: { name: string; code?: string; language: string; examFormat?: { kind: string; questionCount?: number | null }; staticId?: string };
  source: CaseSource;
  request: { job: "qcm" | "exam"; target?: Record<string, unknown>; requested: number; expectRefusal?: boolean };
  /** Durée maximale (seuil de Ben : 15 QCM < 8 min, 20 QCM + 3 ouvertes < 12 min). */
  maxMinutes?: number;
  /** Rejoué en CI depuis une bande enregistrée (tests/fixtures/bench/<id>). */
  ci?: boolean;
};

const synth = (seed: number, chapters: number, concepts: number, language: SynthSpec["language"] = "fr", examples = 1): SynthSpec =>
  ({ seed, chapters, conceptsPerChapter: concepts, examplesPerConcept: examples, language });

const QCM = (count: number, openCount = 0, extra: Record<string, unknown> = {}) => ({ job: "qcm" as const, target: { count, openCount, ...extra }, requested: count + openCount });
const declared = (kind: string, questionCount?: number) => ({ kind, questionCount: questionCount ?? null });

export const SYNTH_CASES: BenchCase[] = [
  { id: "synth-3p", title: "Cours de 3 pages", course: { name: "Veltrane abrégé", language: "fr", examFormat: declared("qcm", 10) }, source: { kind: "synth", spec: synth(3, 1, 3), format: "md" }, request: QCM(10), ci: true },
  { id: "synth-500p", title: "Cours de plus de 500 pages", course: { name: "Veltrane intégral", language: "fr", examFormat: declared("qcm", 15) }, source: { kind: "synth", spec: synth(500, 40, 12, "fr", 3), format: "pdf" }, request: QCM(15), maxMinutes: 8 },
  { id: "synth-scan", title: "PDF scanné (sans couche texte)", course: { name: "Veltrane scanné", language: "fr", examFormat: declared("qcm", 15) }, source: { kind: "synth", spec: synth(31, 6, 4), format: "scan" }, request: QCM(15), maxMinutes: 8 },
  { id: "synth-docx", title: "Supports DOCX", course: { name: "Veltrane docx", language: "fr", examFormat: declared("qcm", 15) }, source: { kind: "synth", spec: synth(41, 8, 4), format: "docx" }, request: QCM(15), maxMinutes: 8 },
  { id: "synth-bilingue", title: "Sources bilingues (fr/en)", course: { name: "Veltrane bilingue", language: "fr", examFormat: declared("qcm", 15) }, source: { kind: "synth", spec: synth(51, 8, 4, "bilingual"), format: "pdf-chapters" }, request: QCM(15), maxMinutes: 8 },
  { id: "synth-sans-format", title: "Aucun format ni annale", course: { name: "Veltrane sans format", language: "fr" }, source: { kind: "synth", spec: synth(61, 8, 4), format: "pdf-chapters" }, request: { job: "exam", requested: 0, expectRefusal: true } },
  { id: "synth-focus", title: "Focus sur un seul chapitre", course: { name: "Veltrane focus", language: "fr", examFormat: declared("qcm", 15) }, source: { kind: "synth", spec: synth(71, 10, 4), format: "pdf-chapters" }, request: QCM(15, 0, { focusChapter: 3 }), maxMinutes: 8 },
  { id: "synth-40qcm", title: "40 QCM", course: { name: "Veltrane quarante", language: "fr", examFormat: declared("qcm", 40) }, source: { kind: "synth", spec: synth(81, 12, 5), format: "pdf-chapters" }, request: QCM(40) },
  { id: "synth-written12", title: "Écrit, 12 exercices", course: { name: "Veltrane écrit", language: "fr", examFormat: declared("exercises", 12) }, source: { kind: "synth", spec: synth(91, 10, 4), format: "pdf-chapters" }, request: { job: "exam", target: { count: 12, kind: "exercises" }, requested: 12 } },
];

/** Cas de vrais cours : fichier local (CORTEX_BENCH_CASES), jamais dans le dépôt. */
export function privateCases(file = process.env.CORTEX_BENCH_CASES): BenchCase[] {
  if (!file || !fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as BenchCase[];
}

export function allCases(): BenchCase[] {
  return [...privateCases(), ...SYNTH_CASES];
}

export function findCase(id: string): BenchCase {
  const c = allCases().find((x) => x.id === id);
  if (!c) throw new Error(`Cas inconnu : ${id} (cas connus : ${allCases().map((x) => x.id).join(", ")})`);
  return c;
}
