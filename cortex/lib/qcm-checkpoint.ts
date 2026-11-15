import fs from "node:fs";
import path from "node:path";
import type { ExamQuestion } from "@/lib/exam";
import type { MoldKind } from "@/lib/molds";
import type { CovTopic, QcmItem, QcmSlot } from "@/lib/qcm";
import type { CourseFact } from "@/lib/qcm-facts";

/**
 * POINT DE REPRISE D'UN EXAMEN QCM — constat prod du 14-15/11/2026 : un job QCM tué par un
 * redéploiement (jobs 23 et 25, à 99 %) était repris par la pompe… depuis zéro : le job 25 a
 * duré 70 min et coûté deux fois. Le point de reprise (jobs.checkpoint_json) garde ce qui est
 * déjà payé, par étape :
 *  - `plan`     : la répartition des sujets, des moules et de la réserve de notions. Recalculée,
 *                 elle changerait : les questions déjà enregistrées comptent dans les « examens
 *                 précédents » que la répartition évite.
 *  - `designed` : après chaque lot conçu, les lots prévus (marge comprise) et les QCM déjà conçus ;
 *  - `verified` : les candidats vérifiés à l'aveugle et réparés, avant la revue finale ;
 *  - `final`    : l'ensemble passé par la porte de sortie (#90), puis l'examen enregistré ;
 *  - `open`     : chaque question ouverte terminée.
 * La reprise saute ce qui est acquis et refait le reste ; revue finale (audit et doublons),
 * plafonds et porte de sortie portent toujours sur l'ENSEMBLE, repris compris : seul un ensemble
 * qui les a déjà franchis (`final`) ne les repasse pas.
 * Version 2 (refonte du 15/11, conception en lots de 8 puis une vérification groupée) : d'un point
 * de reprise v1, seuls `final` et `open` sont repris — leur forme n'a pas changé, et un examen
 * déjà enregistré ne doit jamais l'être deux fois.
 */

/** Ce que le générateur sait lire et écrire (le worker branche jobs.checkpoint_json). */
export type QcmCheckpointStore = { load(): Promise<unknown>; save(data: unknown): Promise<void> };

export type QcmPlan = {
  notionCount: number;
  recent: { topic: string; stem: string }[];
  /** La répartition sur les chapitres a abouti (sinon : couverture par poids). */
  spread: boolean;
  covAll: CovTopic[];
  cov: QcmSlot[];
  qcmTopics: QcmSlot[];
  spareTopics: QcmSlot[];
  qcmMolds: (MoldKind | null)[];
  /** Faits testables du cours (lib/qcm-facts) quand l'examen se conçoit par faits : ceux des questions et de la réserve. */
  facts?: CourseFact[];
  /** Faits déjà posés aux examens précédents du cours, au moment du plan. */
  askedFacts?: string[];
};

export type QcmBatchState = { topics: QcmSlot[]; molds: (MoldKind | null)[]; guidance?: string };
export type QcmMissingState = { topic: QcmSlot; mold: MoldKind | null; rejected: boolean; why?: string };

/** Réserve de notions déjà consommée (takeSpare) : la reprise ne la redonne pas ; `usedFacts` : les faits déjà donnés. */
export type QcmReserveState = { nextSpare: number; used: string[]; usedFacts?: string[] };

/** Lots prévus (sujets de l'examen puis marge de réserve) et QCM conçus par lot (null : à concevoir). */
export type QcmDesignState = QcmReserveState & {
  lots: QcmBatchState[];
  items: (QcmItem[] | null)[];
};

/** Candidats vérifiés (et réparés) avant la revue finale, et sujets restés sans question. */
export type QcmVerifiedState = QcmReserveState & {
  candidates: QcmItem[];
  missing: QcmMissingState[];
  qualityDropped: number;
};

export type QcmCheckpoint = {
  v: 2;
  /** Composition demandée : un point de reprise d'une autre composition est ignoré. */
  key: string;
  plan: QcmPlan;
  designed?: QcmDesignState;
  verified?: QcmVerifiedState;
  final?: { items: QcmItem[]; examId?: number };
  open: [number, ExamQuestion][];
};

export function qcmCheckpointKey(c: { count: number; openCount: number; focus?: string }): string {
  return JSON.stringify({ count: c.count, openCount: c.openCount, focus: c.focus ?? null });
}

/** Le point de reprise s'il est lisible et de la même composition, sinon null (départ à neuf). */
export function readQcmCheckpoint(raw: unknown, key: string): QcmCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Omit<Partial<QcmCheckpoint>, "v"> & { v?: number };
  if ((c.v !== 1 && c.v !== 2) || c.key !== key || !c.plan || !Array.isArray(c.plan.qcmTopics) || !Array.isArray(c.plan.cov)) return null;
  const open = Array.isArray(c.open) ? c.open : [];
  // v1 : ses étapes intermédiaires (comblement par rondes, audit séparé) n'existent plus.
  if (c.v === 1) return { v: 2, key: c.key, plan: c.plan, open, ...(c.final ? { final: c.final } : {}) };
  return { ...c, v: 2, open } as QcmCheckpoint;
}

/**
 * Une figure générée vit dans le dossier des examens jusqu'à l'enregistrement : un conteneur
 * remplacé l'emporte avec lui. Un QCM dont la figure a disparu n'est pas repris (son énoncé peut
 * s'y référer) ; il redevient un sujet à combler.
 */
export function withFigurePresent(items: QcmItem[], dir: string): QcmItem[] {
  return items.filter((it) => !it.figureFile || fs.existsSync(path.join(dir, it.figureFile)));
}
