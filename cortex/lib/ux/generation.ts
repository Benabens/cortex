/**
 * SUIVI D'UNE GÉNÉRATION, RÈGLES PURES — ce que le composant de suivi (components/generation)
 * déduit d'un job : sa phase, l'état de l'orbe, la fourchette de temps à annoncer, une barre qui
 * ne recule jamais, la page où le retrouver. Sans React ni réseau : testé tel quel.
 */
import type { Job } from "./job-status";
import { STAGES, type Stage } from "@/lib/job-stage";

/** L'étape lisible d'un job, si le worker l'a écrite. */
export function stageOf(job: Pick<Job, "stepInfo"> | null): { stage: Stage; done?: number; total?: number; unit?: string } | null {
  const info = job?.stepInfo;
  if (!info || info.key !== "stage" || !(STAGES as readonly string[]).includes(info.stage ?? "")) return null;
  return { ...info, stage: info.stage as Stage };
}

/** États de thinking-orbs utilisés ici (le paquet en a neuf). */
export type OrbState = "working" | "searching" | "solving" | "connecting" | "weaving" | "composing" | "breathing" | "shaping";

/**
 * L'orbe dit ce que fait le moteur : il cherche dans le cours, relie les notions, écrit, vérifie,
 * met en page. En file ou au lancement, il respire.
 */
export function orbStateFor(job: Pick<Job, "type" | "status" | "stepInfo"> | null): OrbState {
  if (!job || job.status === "queued") return "breathing";
  if (job.type === "drill") return "composing";
  if (job.type === "check") return "solving";
  switch (stageOf(job)?.stage) {
    case "read": case "format": case "program": return "searching";
    case "plan": return "connecting";
    case "write": return "composing";
    case "check": return "solving";
    case "refill": return "weaving";
    case "review": return "searching";
    case "render": return "shaping";
    default: return "working";
  }
}

const MIN = 60_000;

/** Fourchette à annoncer, en minutes entières ; « under » : moins d'une minute. */
export type RangeText = { kind: "under" } | { kind: "about"; minutes: number } | { kind: "range"; low: number; high: number };

/**
 * Minutes affichées : bas arrondi vers le bas, haut vers le haut (une fourchette honnête englobe),
 * jamais « 0 à 1 min ». Les deux bornes égales : « environ N min ».
 */
export function rangeText(lowMs: number | null | undefined, highMs: number | null | undefined): RangeText | null {
  if (highMs == null || !Number.isFinite(highMs)) return null;
  if (highMs < MIN) return { kind: "under" };
  const high = Math.ceil(highMs / MIN);
  const low = Math.max(1, Math.floor((lowMs ?? highMs) / MIN));
  return low >= high ? { kind: "about", minutes: high } : { kind: "range", low, high };
}

/** Minutes écoulées depuis la création du job (horodatage SQL en UTC, sans fuseau). */
export function elapsedMinutes(createdAt: string | null | undefined, now: number): number | null {
  if (!createdAt) return null;
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? createdAt : `${createdAt.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / MIN)) : null;
}

/**
 * La barre ne recule jamais pour un même job : l'avancement du moteur peut redescendre quand
 * il ajoute un lot de reprise (lib/progress), l'étudiant y lisait un retour en arrière.
 * En file : un trait minimal, pour que la barre existe sans mentir.
 */
export function barValue(prev: { id: number; value: number } | null, job: Pick<Job, "id" | "status" | "progress">): number {
  const raw = job.status === "queued" ? 2 : Math.max(2, Math.min(100, Math.round(job.progress)));
  return prev && prev.id === job.id ? Math.max(prev.value, raw) : raw;
}

/** La question d'examen corrigée par un job de correction lancé par l'app (lib/check-job), lue dans sa cible. */
export type JobQuestion = { examId: number; questionId: number };
export function questionOfTarget(target: string | null | undefined): JobQuestion | null {
  try {
    const q = (JSON.parse(target ?? "null") as { question?: { examId?: unknown; questionId?: unknown } } | null)?.question;
    return q && Number.isInteger(q.examId) && Number.isInteger(q.questionId) ? { examId: q.examId as number, questionId: q.questionId as number } : null;
  } catch {
    return null;
  }
}

/** Aide lancée depuis l'app (`from: "web"`, lib/jobs ASSIST_FROM_WEB) : celles d'un assistant ne se suivent pas dans la page. */
export function launchedFromApp(target: string | null | undefined): boolean {
  try {
    return (JSON.parse(target ?? "null") as { from?: unknown } | null)?.from === "web";
  } catch {
    return false;
  }
}

/** La page où l'on retrouve une génération (pastille, notification de fin). `question` : la correction d'une question. */
export function pageOfJob(type: string, course: string, question?: JobQuestion | null): string | null {
  const q = `?course=${encodeURIComponent(course)}`;
  switch (type) {
    case "exam": case "qcm": return `/examens${q}`;
    case "ingest": case "prepare": case "format": return `/sources${q}`;
    case "blueprint": return `/programme${q}`;
    case "exercise": case "lab-exercise": case "drill": return `/entrainement${q}`;
    case "check": return question ? `/mock/${question.examId}${q}` : null;
    default: return null;
  }
}

/**
 * Le lien d'une notification de fin : le résultat lui-même quand il a une adresse (examen en ligne,
 * PDF), l'exercice ciblé ou la correction relus par leur job (`job=`), sinon la page d'où relancer.
 */
export function finishedHref(t: { type: string; course: string; id: number; status: "done" | "failed"; resultPath: string | null; question?: JobQuestion | null }): string | null {
  const page = pageOfJob(t.type, t.course, t.question);
  if (t.status !== "done") return page;
  if (t.resultPath?.startsWith("/mock/")) return `${t.resultPath}?course=${encodeURIComponent(t.course)}`;
  if (t.resultPath?.startsWith("/")) return t.resultPath;
  return page && (t.type === "drill" || t.type === "check") ? `${page}&job=${t.id}` : page;
}

/** L'avancement mesure-t-il quelque chose ? Un seul appel au modèle (exercice ciblé, correction) : non, la barre n'a pas de pourcentage. */
export function measuredProgress(type: string): boolean {
  return type !== "drill" && type !== "check";
}

/**
 * Ce que l'annulation garde ou rend (lib/jobs cancelJob). `charged` false : la génération ne coûte
 * rien à ce compte (propriétaire, facturation coupée), on ne parle pas de crédits ; absent : payée.
 */
export type CancelOutcome = "refunded" | "keepsReady" | "notRefunded" | "free" | "keepsReadyFree";
export const CANCEL_REFUND_MAX_PROGRESS = 10;
export function cancelOutcome(job: Pick<Job, "type" | "progress" | "resultId" | "charged">): CancelOutcome {
  const free = job.charged === false;
  if (job.type === "qcm" && job.resultId) return free ? "keepsReadyFree" : "keepsReady";
  if (free) return "free";
  return job.progress <= CANCEL_REFUND_MAX_PROGRESS ? "refunded" : "notRefunded";
}
