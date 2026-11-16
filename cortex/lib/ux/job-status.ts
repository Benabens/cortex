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
