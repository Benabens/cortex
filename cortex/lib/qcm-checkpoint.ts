import fs from "node:fs";
import path from "node:path";
import type { ExamQuestion } from "@/lib/exam";
import type { MoldKind } from "@/lib/molds";
import type { CovTopic, QcmItem, QcmSlot } from "@/lib/qcm";

/**
 * POINT DE REPRISE D'UN EXAMEN QCM — constat prod du 14-15/11/2026 : un job QCM tué par un
 * redéploiement (jobs 23 et 25, à 99 %) était repris par la pompe… depuis zéro : le job 25 a
 * duré 70 min et coûté deux fois. Le point de reprise (jobs.checkpoint_json) garde ce qui est
 * déjà payé, par étape :
 *  - `plan`    : la répartition des sujets, des moules et de la réserve de notions. Recalculée,
 *                elle changerait : les questions déjà enregistrées comptent dans les « examens
 *                précédents » que la répartition évite.
 *  - `loop`    : après chaque groupe de lots du comblement principal, les QCM construits ET
 *                vérifiés, ce qui reste à concevoir et la réserve déjà consommée ;
 *  - `audited` : le pool après l'audit de sortie ;
 *  - `final`   : l'ensemble passé par la porte de sortie (#90), puis l'examen enregistré ;
 *  - `open`    : chaque question ouverte terminée.
 * La reprise saute ce qui est acquis et refait le reste ; dédoublonnage, plafonds et porte de
 * sortie portent toujours sur l'ENSEMBLE, repris compris : seul un ensemble qui les a déjà
 * franchis (`final`) ne les repasse pas.
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
};

export type QcmBatchState = { topics: QcmSlot[]; molds: (MoldKind | null)[]; guidance?: string };
export type QcmMissingState = { topic: QcmSlot; mold: MoldKind | null; rejected: boolean; why?: string };

/** Réserve de notions déjà consommée (takeSpare) : la reprise ne la redonne pas. */
export type QcmReserveState = { nextSpare: number; used: string[] };

export type QcmLoopState = QcmReserveState & {
  round: number;
  /** Indice, dans `pending`, du prochain groupe de lots à concevoir. */
  next: number;
  pending: QcmBatchState[];
  missing: QcmMissingState[];
  extraBudget: number;
  /** QCM vérifiés acquis (pool cumulatif) ; `selected` : leurs énoncés retenus pour l'examen. */
  candidates: QcmItem[];
  selected: string[];
  qualityDropped: number;
};

export type QcmAuditedState = QcmReserveState & {
  candidates: QcmItem[];
  selected: string[];
  auditedStems: string[];
  auditRejected: string[];
  qualityDropped: number;
};

export type QcmCheckpoint = {
  v: 1;
  /** Composition demandée : un point de reprise d'une autre composition est ignoré. */
  key: string;
  plan: QcmPlan;
  loop?: QcmLoopState;
  audited?: QcmAuditedState;
  final?: { items: QcmItem[]; examId?: number };
  open: [number, ExamQuestion][];
};

export function qcmCheckpointKey(c: { count: number; openCount: number; focus?: string }): string {
  return JSON.stringify({ count: c.count, openCount: c.openCount, focus: c.focus ?? null });
}

/** Le point de reprise s'il est lisible et de la même composition, sinon null (départ à neuf). */
export function readQcmCheckpoint(raw: unknown, key: string): QcmCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<QcmCheckpoint>;
  if (c.v !== 1 || c.key !== key || !c.plan || !Array.isArray(c.plan.qcmTopics) || !Array.isArray(c.plan.cov)) return null;
  return { ...c, open: Array.isArray(c.open) ? c.open : [] } as QcmCheckpoint;
}

/**
 * Une figure générée vit dans le dossier des examens jusqu'à l'enregistrement : un conteneur
 * remplacé l'emporte avec lui. Un QCM dont la figure a disparu n'est pas repris (son énoncé peut
 * s'y référer) ; il redevient un sujet à combler.
 */
export function withFigurePresent(items: QcmItem[], dir: string): QcmItem[] {
  return items.filter((it) => !it.figureFile || fs.existsSync(path.join(dir, it.figureFile)));
}
