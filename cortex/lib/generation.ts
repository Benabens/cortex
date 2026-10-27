import { creditsGate } from "@/lib/billing/credits";
import { generationGate } from "@/lib/billing/guards";
import { ReservationRefused, activeJob, createJobExclusive, startWorker, type JobType } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";

/**
 * LANCEMENT D'UNE GÉNÉRATION PAR JOB, pour l'utilisateur et le cours COURANTS
 * (contexte installé par l'appelant : route via lib/req, MCP via runWithUser /
 * runWithCourse). Séquence partagée par POST /api/exams/generate et le serveur
 * MCP (les autres routes de génération — qcm, exercices, labs — gardent encore
 * leur propre copie, à rapatrier ici au besoin) :
 *
 *   1. un job actif du même type est RÉUTILISÉ (un seul à la fois, rien n'est débité) ;
 *   2. pré-checks (quota du jour, solde, disque, moteur, corpus, LaTeX) ;
 *   3. réservation atomique + insertion exclusive (lib/jobs createJobExclusive) ;
 *   4. démarrage du worker détaché.
 *
 * Un refus est une VALEUR (statut HTTP + message pour l'utilisateur), jamais une
 * exception : la route le rend tel quel, le serveur MCP le traduit en erreur d'outil.
 */
export type StartedJob = { ok: true; jobId: number; existing: boolean };
export type StartRefused = { ok: false; status: number; error: string; command?: string };

export async function startGenerationJob(type: JobType, target?: string): Promise<StartedJob | StartRefused> {
  return startJob(type, target, async () => {
    const issue = await preflightGeneration(type);
    return issue && { ok: false, status: issue.status, error: issue.error, command: issue.command };
  });
}

/**
 * PRÉPARATION D'UN COURS (job « prepare » : ingestion du contenu et des annales →
 * détection du format → plan), partagée par POST /api/prepare et l'outil MCP
 * prepare_course. Même séquence qu'une génération, sans les pré-checks de corpus
 * et de LaTeX (c'est elle qui construit le corpus) : quota du jour et solde, puis
 * la réservation atomique.
 */
export async function startPrepareJob(): Promise<StartedJob | StartRefused> {
  return startJob("prepare", undefined, async () => {
    // La préparation fait de la vision LLM sur les annales (coûteux) → quota + crédits comme toute génération.
    const gate = (await generationGate("gen")) ?? (await creditsGate("prepare"));
    return gate && { ok: false, status: gate.status, error: gate.error };
  });
}

/** Séquence commune : job actif réutilisé → pré-checks propres au type → réservation + insertion → worker. */
async function startJob(type: JobType, target: string | undefined, precheck: () => Promise<StartRefused | null>): Promise<StartedJob | StartRefused> {
  const existing = await activeJob(type);
  if (existing) return { ok: true, jobId: existing.id, existing: true };

  const refused = await precheck();
  if (refused) return refused;

  let created: { id: number; existing: boolean };
  try {
    created = await createJobExclusive(type, target);
  } catch (e) {
    if (e instanceof ReservationRefused) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  try {
    await startWorker(created.id, undefined);
  } catch (e) {
    return { ok: false, status: 500, error: `Impossible de lancer le worker : ${(e as Error)?.message ?? e}` };
  }
  return { ok: true, jobId: created.id, existing: created.existing };
}

/** Nombre d'exercices demandé pour un examen : entier 1-12, sinon défaut du moteur (blueprint). */
export function examCount(raw: unknown): number | undefined {
  const n = Number(raw);
  return n > 0 ? Math.min(12, Math.floor(n)) : undefined;
}

/**
 * Cible d'un examen telle que le worker la lit (et que costForJob la tarife) :
 * absente quand rien n'est demandé — les défauts du moteur, au tarif de base.
 */
export function examTarget(count?: number, focus?: string): string | undefined {
  return count || focus ? JSON.stringify({ count, focus }) : undefined;
}

// ─────────────────────── composition d'un examen blanc (connecteur MCP) ───────────────────────

/** Sans annales : composition par défaut (exercices écrits, ou QCM). */
export const WRITTEN_DEFAULT = 6;
export const MCQ_DEFAULT = 20;
export const WRITTEN_MAX = 12;
export const MCQ_MAX = 40;

/** Une demande de QCM (« ~20 QCM », « des QCMs », « questions à choix multiples », « MCQ »). */
const MCQ_WORDS = /\b(qcms?|mcqs?|multiple[- ]choice|choix multiples?)\b/i;
/** …sauf si elle les écarte (« pas de QCM », « sans QCM », « no MCQ »). */
const MCQ_REFUSED = /\b(pas de|sans|aucun|no|without|not)\s+(qcms?|mcqs?|multiple[- ]choice|questions? à choix)/i;
/** Un nombre accolé à la demande : « ~30 QCM », « 15 questions à choix multiples ». */
const MCQ_COUNT = /(\d{1,2})\s*(?:qcms?|mcqs?|questions?)\b/i;

export type MockExamPlan = {
  format: "written" | "mcq";
  /** Type de job : « exam » (générateur d'examen écrit) ou « qcm » (générateur QCM). */
  jobType: "exam" | "qcm";
  /** Exercices (écrit) ou questions (QCM) ; null = comme les annales. */
  count: number | null;
  /** Cible du job telle que le worker la lit (absente = défauts du moteur). */
  target?: string;
  /** Ce qui a été décidé autrement que par les annales, à dire à la personne ; null sinon. */
  note: string | null;
};

/**
 * COMPOSITION D'UN EXAMEN BLANC demandé par le connecteur. Avec des annales, leur format
 * fait la règle (le focus n'est qu'un accent) : l'app ne génère des QCM que si ses
 * annales en contiennent, le connecteur ne contourne pas cette règle. SANS annales, rien
 * ne dit à quoi ressemble l'examen : on suit la demande — QCM si `format` vaut « mcq » ou
 * si la demande libre (`request`, jamais un titre de chapitre) en réclame, nombre `count`
 * ou celui écrit dans la demande — avec un défaut raisonnable, et on le dit. (27/10/2026 :
 * « ~20 QCM » sur HUM-285 donnait UN exercice, le plan d'un cours sans annales n'ayant
 * qu'un créneau.) `focus` = l'accent transmis au générateur (chapitre et demande libre).
 */
export function planMockExam(a: {
  format?: "written" | "mcq"; count?: number; request?: string | null; focus: string | null; hasPastExams: boolean;
}): MockExamPlan | { error: string } {
  const focus = a.focus?.trim() || null;
  const request = a.request?.trim() || "";
  const asksMcq = a.format === "mcq" || (a.format === undefined && MCQ_WORDS.test(request) && !MCQ_REFUSED.test(request));
  if (a.hasPastExams) {
    if (a.count !== undefined && a.count > WRITTEN_MAX) {
      return { error: `Un examen compte au plus ${WRITTEN_MAX} exercices : réduis exercise_count.` };
    }
    const note = a.format === "mcq" ? "Ce cours a des annales : l'examen suit leur format, la demande de QCM n'est pas appliquée." : null;
    return { format: "written", jobType: "exam", count: a.count ?? null, target: examTarget(a.count, focus ?? undefined), note };
  }
  if (asksMcq) {
    const written = Number(request.match(MCQ_COUNT)?.[1]) || undefined;
    const count = Math.min(MCQ_MAX, a.count ?? written ?? MCQ_DEFAULT);
    const target = JSON.stringify({ count, openCount: 0, focus: focus ?? undefined });
    const how = a.count !== undefined || written ? "" : " (nombre par défaut)";
    return { format: "mcq", jobType: "qcm", count, target, note: `Ce cours n'a pas d'annales : examen composé selon la demande, ${count} QCM${how}.` };
  }
  if (a.count !== undefined && a.count > WRITTEN_MAX) {
    return { error: `Un examen écrit compte au plus ${WRITTEN_MAX} exercices : réduis exercise_count, ou demande des QCM (format "mcq", jusqu'à ${MCQ_MAX}).` };
  }
  const count = a.count ?? WRITTEN_DEFAULT;
  const how = a.count !== undefined ? "" : " (nombre par défaut)";
  return {
    format: "written", jobType: "exam", count, target: examTarget(count, focus ?? undefined),
    note: `Ce cours n'a pas d'annales : ${count} exercices écrits${how}, format générique faute d'examens réels.`,
  };
}
