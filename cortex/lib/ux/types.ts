/**
 * Types des réponses RÉELLES de /api/* (formes confirmées par curl — cf.
 * integration/MAPPING.md). Les champs texte peuvent revenir corrompus
 * (Buffer) sur cs-202 → toujours passer par asText() avant rendu.
 */

import type { Severity, Status } from "@/lib/ux/labels";

/** Champ texte potentiellement corrompu côté back (blob binaire). */
export type MaybeText = string | { type?: string; data?: number[] } | null;

export type DashCourse = {
  id: string;
  name: string;
  short: string;
  examCode: string;
  examKind: string;
};

export type DashStats = {
  total: number;
  covered: number;
  mastered: number;
  due: number;
  coveragePct: number;
  masteryPct: number;
};

export type DashNext = {
  id: number;
  label: MaybeText;
  category: MaybeText;
  examWeight: number;
  status: string;
  mastery: number | null; // 0–10
};

export type DashExam = {
  id: number;
  createdAt: string; // "YYYY-MM-DD HH:mm:ss"
  status: string;
  questionCount: number;
  verifySummary: MaybeText;
  url: string | null;
  solutionsUrl: string | null;
};

export type DashWeakness = { id: number; topic: MaybeText; severity: number };

export type DashJob = {
  id: number;
  type: MaybeText;
  status: string;
  progress: number;
  currentStep: MaybeText;
  resultPath: string | null;
};

export type Dash = {
  course: DashCourse;
  analyzed: boolean;
  stats: DashStats;
  next: DashNext | null;
  cover: { id: number; label: MaybeText; examWeight: number } | null;
  schedule: { total: number; due: number };
  exams: DashExam[];
  weaknesses: { count: number; top: DashWeakness[] };
  countdown: { date: string; days: number } | null;
  job: DashJob | null;
};

/** Statut back ("never", …) → vocabulaire d'état UI. */
export function toStatus(status: string, mastery: number | null): Status {
  if (status === "never" || mastery === null) return "JAMAIS_VU";
  if (status === "solid" || (typeof mastery === "number" && mastery >= 7)) return "SOLIDE";
  return "EN_COURS";
}

/** Sévérité back (1–3) → vocabulaire UI. */
export function toSeverity(level: number): Severity {
  if (level >= 3) return "GROS";
  if (level === 2) return "MOYEN";
  return "LÉGER";
}

/** "2026-06-24 21:30:34" → "24 juin" (fr, sans heure). Retourne null si illisible. */
export function formatDay(sql: string | null | undefined): string | null {
  if (!sql || typeof sql !== "string") return null;
  const d = new Date(sql.replace(" ", "T"));
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
