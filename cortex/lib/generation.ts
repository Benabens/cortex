import { creditsGate } from "@/lib/billing/credits";
import { generationGate } from "@/lib/billing/guards";
import { ReservationRefused, activeJob, createJobExclusive, startWorker, type JobType } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { planMockExam, requestedFormat, resolveExamFormat, targetKind, type ExamKind } from "@/lib/exam-format";

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
    // Un examen blanc suit le format du cours ; inconnu, il n'est jamais inventé (lib/exam-format).
    // Vérifié en premier : c'est gratuit, et c'est ce que l'étudiant doit corriger.
    if (type === "exam") {
      const plan = planMockExam(requestedFormat(await resolveExamFormat(), targetKind(target)), {});
      if (plan.generator === "none") return { ok: false, status: 409, error: plan.reason };
    }
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
 * `kind` : format demandé pour CET examen (lib/exam-format requestedFormat).
 */
export function examTarget(count?: number, focus?: string, kind?: ExamKind): string | undefined {
  return count || focus || kind ? JSON.stringify({ count, focus, kind }) : undefined;
}
