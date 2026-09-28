/**
 * État d'un job tel que l'interface le lit, et liste des statuts ACTIFS (ceux
 * qui justifient de continuer à sonder). Module sans dépendance : partagé par le
 * sondeur (lib/ux/job-watch) et par les composants.
 */
export type Job = {
  id: number;
  type: string;
  status: string;
  progress: number;
  currentStep: string | null;
  resultPath: string | null;
  error?: string | null;
};

export const JOB_ACTIVE = ["queued", "running", "verifying", "compiling"];
