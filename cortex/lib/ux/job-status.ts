/**
 * État d'un job tel que l'interface le lit, et liste des statuts ACTIFS (ceux
 * qui justifient de continuer à sonder). Module sans dépendance : partagé par le
 * sondeur (lib/ux/job-watch) et par les composants.
 */
import type { IngestReport } from "@/lib/ingest-report";
import type { CheckResult } from "@/lib/check-solution";
import type { Drill } from "./training";

export type Job = {
  id: number;
  type: string;
  status: string;
  progress: number;
  currentStep: string | null;
  resultPath: string | null;
  error?: string | null;
  /** Ingestion et préparation : le sort de chaque fichier (lib/ingest-report). */
  report?: IngestReport | null;
  /** L'étape sans langue (lib/i18n/job-text) ; `stage` : l'étape lisible et son compteur (lib/job-stage). */
  stepInfo?: { key: string; stage?: string; done?: number; total?: number; unit?: string } | null;
  /** Temps restant dans la langue du lecteur, et sa fourchette (lib/eta) ; etaLate : plus long que d'habitude. */
  eta?: string | null;
  etaRange?: { lowMs: number | null; highMs: number | null } | null;
  etaLate?: boolean;
  /** Horodatage SQL (UTC) de la création du job. */
  createdAt?: string;
  /** Examen QCM déjà visible pendant sa génération (livraison progressive). */
  resultId?: number | null;
  /** false : la génération ne coûte rien à ce compte (propriétaire, facturation coupée). */
  charged?: boolean;
  /** Ce que le job a reçu (JSON) : la page qui le reprend y relit sa demande (série de labo, question corrigée…). */
  target?: string | null;
  /** Aides en job terminées (GET /api/jobs/[id]) : l'exercice ciblé, la correction. */
  drill?: Drill;
  check?: CheckResult;
};

export const JOB_ACTIVE = ["queued", "running", "verifying", "compiling"];

/**
 * Comment un job s'est terminé, vu de l'interface ; null tant qu'il tourne. « canceled » n'est ni
 * un succès ni un échec : le compositeur affichait « Examen généré » pour une génération annulée
 * (audit generation-ux du 24/11), le bandeau de l'Accueil « La génération a échoué ».
 * « failed » : statut posé par le sondeur quand le job est introuvable ou la connexion perdue.
 */
export type JobEnd = "done" | "failed" | "canceled";
export function jobEnd(status: string): JobEnd | null {
  if (JOB_ACTIVE.includes(status)) return null;
  if (status === "done") return "done";
  return status === "canceled" ? "canceled" : "failed";
}
