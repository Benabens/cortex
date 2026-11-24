/**
 * État d'un job tel que l'interface le lit, et liste des statuts ACTIFS (ceux
 * qui justifient de continuer à sonder). Module sans dépendance : partagé par le
 * sondeur (lib/ux/job-watch) et par les composants.
 */
import type { IngestReport } from "@/lib/ingest-report";

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
