import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { profile } from "@/lib/course-profile";
import type { Archetype } from "@/lib/archetypes";
import { rubricFor, styleFor, trapMenuBlock } from "@/lib/difficulty";
import {
  gatherTargetedContext,
  pickArchetype,
  persistExercise,
  regenerateExercise,
  type ExamQuestion,
  type StepCb,
} from "@/lib/exam";
import { verifyAndHarden, type VerifyReport } from "@/lib/verify";

/**
 * V3 — L'ARCHITECTE D'EXAMEN (pipeline multi-passes pour UN exercice ciblé, cs-202).
 *
 * Remplace la génération mono-passe par la boucle d'un concepteur d'examen humain :
 *   P0 Étudier (vraie page la plus dure + fiche difficulté + piège ciblé)
 *   P1 Concevoir le PIÈGE (décider l'idée fausse + le cas-limite AVANT de rédiger)
 *   P2 Rédiger (multi-étapes, format EPFL, style de la prof, piège intégré)
 *   P3 Critique ADVERSARIALE + RÉVISION (joue le pattern-matcher ET l'étudiant fort ; si le
 *      pattern-matcher réussit → trop facile, durcis ; si le fort cale → simplifie le bon endroit ;
 *      compare à la rubrique point par point ; révise chirurgicalement — boucle bornée)
 *   P4 Vérifier la JUSTESSE + scope (verifyAndHarden existant)
 *
 * Ce qu'on PRÉSERVE : format/figures verrouillées, scope (directives), justesse, fiabilité.
 * Ce qu'on AMÉLIORE : la difficulté et le style.
 */

// ───────── P1 : la fiche de conception (design brief) ─────────
type DesignBrief = {
  misconception: string;
  edge_case: string;
  reasoning_chain: string[];
  bookkeeping: string;
  discriminator: string;
  awkward_numbers: string;
  subquestion_plan: string[];
};

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    misconception: { type: "string", description: "L'idée fausse PRÉCISE que la question va punir (1 phrase)." },
    edge_case: { type: "string", description: "Le cas-limite / la subtilité qui déclenche le piège (frontière, négatif, cache, ordre, ownership…)." },
    reasoning_chain: { type: "array", items: { type: "string" }, description: "Les étapes de raisonnement de l'étudiant FORT (≥ le seuil de la rubrique)." },
    bookkeeping: { type: "string", description: "La grille/charge de réponse (taille) à imposer." },
    discriminator: { type: "string", description: "La réponse ERRONÉE que donne un étudiant qui pattern-matche (ce qui DISCRIMINE)." },
    awkward_numbers: { type: "string", description: "Les nombres NON RONDS choisis (valeurs concrètes)." },
    subquestion_plan: { type: "array", items: { type: "string" }, description: "Plan des sous-questions en escalier (titres), dont une qui DÉPEND d'une précédente." },
  },
  required: ["misconception", "edge_case", "reasoning_chain", "bookkeeping", "discriminator", "awkward_numbers", "subquestion_plan"],
  additionalProperties: false,
} as const;

const ONE_EX_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string" },
    concept: { type: "string" },
    statement_tex: { type: "string" },
    solution_tex: { type: "string" },
    points: { type: "integer" },
  },
  required: ["category", "concept", "statement_tex", "solution_tex", "points"],
  additionalProperties: false,
} as const;

// ───────── P3 : l'audit adversarial ─────────
type Audit = {
  pattern_matcher_answer: string;
  pattern_matcher_correct: boolean;
  strong_student_answer: string;
  strong_student_stuck: boolean;
  rubric_misses: string[];
  trap_present: boolean;
  hardening: string;
  verdict: "good" | "too_easy" | "broken";
};

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    pattern_matcher_answer: { type: "string", description: "Ce que répond un étudiant qui RECONNAÎT le type sans comprendre (raisonnement superficiel, par défaut/par habitude)." },
    pattern_matcher_correct: { type: "boolean", description: "true si cette approche superficielle obtient quand même la BONNE réponse → la question est TROP FACILE." },
    strong_student_answer: { type: "string", description: "Ce que répond un étudiant FORT qui résout vraiment (résous toi-même de zéro)." },
    strong_student_stuck: { type: "boolean", description: "true si même l'étudiant fort ne peut pas résoudre (énoncé cassé/ambigu/insoluble)." },
    rubric_misses: { type: "array", items: { type: "string" }, description: "Les points de la RUBRIQUE non cochés (liste vide si tout est bon)." },
    trap_present: { type: "boolean", description: "true si le piège conçu est réellement testé par l'énoncé." },
    hardening: { type: "string", description: "Instructions CONCRÈTES et CHIRURGICALES pour durcir (ajouter le piège, salir un nombre, agrandir la grille, enchaîner une sous-question) — sans tout réécrire." },
    verdict: { type: "string", description: "« good » (assez dur + style prof + juste à viser) | « too_easy » (le pattern-matcher réussit / piège absent) | « broken » (l'étudiant fort cale)." },
  },
  required: ["pattern_matcher_answer", "pattern_matcher_correct", "strong_student_answer", "strong_student_stuck", "rubric_misses", "trap_present", "hardening", "verdict"],
  additionalProperties: false,
} as const;

function pointsFor(a: Archetype): number {
  return a.id === "c-reading" ? 10 : a.id === "labs-reading" ? 15 : a.category === "Networking" ? 50 : 25;
}

function contextBlock(ctx: ReturnType<typeof gatherTargetedContext>): string {
  const block = (title: string, items: { src: string; text: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.text}`)].join("\n") : "";
  return [
    block(`═══ PAST-EXAMS DU MÊME TYPE (le format/difficulté de la prof — PRIORITÉ) ═══`, ctx.pastexams),
    block(`═══ SÉRIES + CORRIGÉS ═══`, ctx.exercises),
    block(`═══ COURS ═══`, ctx.course),
  ].filter((l) => l != null).join("\n");
}

/** P0+P1 — étudier la vraie page la plus dure + concevoir le piège (avant de rédiger). */
async function designTrap(a: Archetype, target: string, refImage: string | null, step: StepCb): Promise<DesignBrief> {
  const p = profile();
  const r = rubricFor(a.id);
  const prompt = [
    `Tu es l'équipe enseignante de CS-202 (EPFL) et tu CONÇOIS une question d'examen DURE, dans le style de la prof.`,
    refImage ? `ÉTUDIE D'ABORD la vraie page d'examen la plus dure de ce type : ${refImage} (outil Read) — observe sa densité, son piège, sa charge.` : ``,
    ``,
    `Type : ${a.concept} (archétype « ${a.id} », catégorie ${a.category}). Sujet ciblé : « ${target} ».`,
    ``,
    trapMenuBlock(a.id),
    ``,
    r ? `BARRE : ≥ ${r.subparts} sous-questions, la dure ≥ ${r.steps} étapes, bookkeeping = ${r.bookkeeping}, ${r.mustChain ? "au moins une sous-question enchaînée, " : ""}cas-limite obligatoire.` : ``,
    ...styleFor(a.category),
    ``,
    `NE RÉDIGE PAS encore la question. CONÇOIS-LA : choisis UN piège précis, le cas-limite qui le déclenche, la chaîne de raisonnement de l'étudiant fort, les NOMBRES NON RONDS, la grille de réponse, et la réponse erronée du pattern-matcher (ce qui discrimine). Plan des sous-questions en escalier.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier.`,
    JSON.stringify(DESIGN_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("P1 — conception du piège (étude de la vraie page + design)…", 22);
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 300_000 });
  return extractJson<DesignBrief>(text);
}

/** P2 — rédiger l'énoncé multi-étapes au format EPFL, piège intégré, style prof. */
async function writeFromDesign(a: Archetype, target: string, pts: number, design: DesignBrief, ctx: ReturnType<typeof gatherTargetedContext>, refImage: string | null, step: StepCb): Promise<ExamQuestion> {
  const p = profile();
  const corpus = contextBlock(ctx);
  const prompt = [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...p.exerciseLead(target || a.concept, a, pts, refImage),
    ``,
    corpus,
    corpus ? `` : null,
    `═══ FICHE DE CONCEPTION À RESPECTER (tu l'as conçue — RÉDIGE-LA fidèlement) ═══`,
    `• Idée fausse à punir : ${design.misconception}`,
    `• Cas-limite déclencheur : ${design.edge_case}`,
    `• Chaîne de raisonnement (étudiant fort) : ${design.reasoning_chain.join(" → ")}`,
    `• Bookkeeping imposé : ${design.bookkeeping}`,
    `• Nombres NON RONDS : ${design.awkward_numbers}`,
    `• Ce que le pattern-matcher répond (FAUX — la question doit l'y piéger) : ${design.discriminator}`,
    `• Sous-questions en escalier : ${design.subquestion_plan.map((s, i) => `${i + 1}) ${s}`).join(" ")}`,
    ``,
    rubricBlockInline(a.id),
    ``,
    p.latexContract(),
    ``,
    `Rédige l'énoncé COMPLET (statement_tex) avec ses sous-questions \\subq{N.M}{...}{pts} et ses grilles de réponse, et le corrigé COMPLET (solution_tex) résolu étape par étape (le piège y est explicité). Le piège doit être RÉELLEMENT testé : un étudiant qui pattern-matche se trompe.`,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. Aucun outil au-delà de Read, aucun fichier.`,
    JSON.stringify(ONE_EX_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("P2 — rédaction de l'énoncé multi-étapes (format EPFL + piège)…", 38);
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 480_000 });
  const q = extractJson<ExamQuestion>(text);
  return { ...q, category: a.category, points: pts };
}

function rubricBlockInline(archetypeId: string): string {
  const r = rubricFor(archetypeId);
  if (!r) return "";
  return [
    `BARRE DE DIFFICULTÉ (à cocher) : ≥ ${r.subparts} sous-questions ; la dure ≥ ${r.steps} étapes ;`,
    `bookkeeping = ${r.bookkeeping} ; ${r.mustChain ? "≥1 sous-question enchaînée ; " : ""}piège nommé réellement testé ; nombres non ronds.`,
  ].join(" ");
}

/** P3 — audit adversarial : pattern-matcher vs étudiant fort + rubrique. */
async function adversarialAudit(a: Archetype, q: ExamQuestion, refImage: string | null, step: StepCb): Promise<Audit> {
  const p = profile();
  const r = rubricFor(a.id);
  const prompt = [
    `Tu es un relecteur d'examen CS-202 (EPFL) IMPITOYABLE sur la DIFFICULTÉ. Tu joues DEUX étudiants sur la question ci-dessous.`,
    refImage ? `Réfère-toi à la vraie page de ce type : ${refImage} (outil Read) pour calibrer le niveau attendu.` : ``,
    ``,
    `ÉNONCÉ (LaTeX) :`,
    q.statement_tex,
    ``,
    `CORRIGÉ PROPOSÉ (LaTeX) :`,
    q.solution_tex,
    ``,
    `(a) Joue l'étudiant PATTERN-MATCHER : il reconnaît le type et applique la recette HABITUELLE sans réfléchir au piège. Écris sa réponse, et dis si elle est CORRECTE. Si oui → la question est TROP FACILE.`,
    `(b) Joue l'étudiant FORT : résous VRAIMENT de zéro (calcule/trace/compte). Dis si même lui CALE (énoncé cassé/ambigu).`,
    r ? `Vérifie la RUBRIQUE : ≥ ${r.subparts} sous-questions ; la dure ≥ ${r.steps} étapes ; bookkeeping = ${r.bookkeeping} ; ${r.mustChain ? "≥1 sous-question enchaînée ; " : ""}piège nommé réellement testé ; nombres non ronds. Liste les points NON cochés.` : ``,
    `Si le pattern-matcher réussit OU le piège est absent → verdict « too_easy » + hardening CHIRURGICAL (quoi ajouter/salir/agrandir/enchaîner, sans tout réécrire). Si le fort cale → « broken » + comment simplifier au bon endroit. Sinon « good ».`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier.`,
    JSON.stringify(AUDIT_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 340_000 });
  return extractJson<Audit>(text);
}

/** P3 — révision chirurgicale d'après l'audit (durcir le piège / réparer, pas réécrire de zéro). */
async function reviseFromAudit(a: Archetype, q: ExamQuestion, audit: Audit, refImage: string | null, step: StepCb): Promise<ExamQuestion> {
  const p = profile();
  const diagnostic = [
    audit.verdict === "too_easy" ? `TROP FACILE : un pattern-matcher répond « ${audit.pattern_matcher_answer} » et a raison. RENFORCE le piège pour qu'il se TROMPE.` : "",
    audit.verdict === "broken" ? `CASSÉ : l'étudiant fort cale (« ${audit.strong_student_answer} »). Rends-le résoluble sans baisser la difficulté.` : "",
    audit.rubric_misses.length ? `Rubrique non cochée : ${audit.rubric_misses.join(" ; ")}.` : "",
    `À FAIRE (chirurgical) : ${audit.hardening}`,
  ].filter(Boolean).join(" ");
  const prompt = [
    p.directivesBlock(),
    ``,
    refImage ? `Vraie page de référence : ${refImage} (outil Read).` : ``,
    `RÉVISE (ne réécris pas de zéro) la question CS-202 ci-dessous en gardant son squelette et son format, pour corriger ce diagnostic :`,
    diagnostic,
    ``,
    `ÉNONCÉ ACTUEL :`,
    q.statement_tex,
    ``,
    `CORRIGÉ ACTUEL :`,
    q.solution_tex,
    ``,
    rubricBlockInline(a.id),
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points} (version durcie/réparée). Le corrigé doit rester JUSTE. Aucun fichier.`,
    JSON.stringify(ONE_EX_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 480_000 });
  const r = extractJson<ExamQuestion>(text);
  return { ...r, category: a.category, points: q.points };
}

export type ArchitectResult = { id: number; url: string; texError?: string; auditLog: Audit[] };

/**
 * Pipeline complet pour UN exercice ciblé (cs-202). Renvoie l'exo persité + le journal d'audit.
 * Boucle adversariale bornée (maxRounds), puis vérif de justesse (verifyAndHarden, maxAttempts=1).
 */
export async function architectExercise(
  target: string,
  opts: { onStep?: StepCb; maxRounds?: number } = {}
): Promise<ArchitectResult> {
  const t0 = Date.now();
  const step = opts.onStep ?? (() => {});
  const maxRounds = opts.maxRounds ?? 2;
  const p = profile();
  const a = pickArchetype(target);
  const pts = pointsFor(a);
  const refImage = p.refImageFor(a.category, target || a.concept);
  const ctx = gatherTargetedContext(target);

  step(`P0 — étude : archétype « ${a.id} » (${a.category}), vraie page ${refImage ?? "—"}`, 12);
  // P1 — concevoir le piège
  const design = await designTrap(a, target, refImage, step);
  // P2 — rédiger (avec le contexte corpus pour ancrer le contenu)
  let q = await writeFromDesign(a, target, pts, design, ctx, refImage, step);

  // P3 — boucle adversariale + révision
  const auditLog: Audit[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    step(`P3 — critique adversariale (pattern-matcher vs étudiant fort), passe ${round}/${maxRounds}…`, 50 + round * 8);
    let audit: Audit;
    try {
      audit = await adversarialAudit(a, q, refImage, step);
    } catch (e) {
      step(`P3 — audit interrompu (${(e as Error).message}) — on garde la version courante`, 66);
      break;
    }
    auditLog.push(audit);
    if (audit.verdict === "good" && !audit.pattern_matcher_correct && audit.trap_present && audit.rubric_misses.length === 0) {
      step(`P3 — validé (piège tient, pattern-matcher échoue) à la passe ${round}`, 70);
      break;
    }
    if (round === maxRounds) {
      step(`P3 — dernière passe : ${audit.verdict} (durcissement résiduel : ${audit.hardening.slice(0, 80)})`, 70);
    }
    try {
      q = await reviseFromAudit(a, q, audit, refImage, step);
    } catch (e) {
      step(`P3 — révision interrompue (${(e as Error).message})`, 70);
      break;
    }
  }

  // P4 — justesse + scope (vérif à l'aveugle existante ; 1 tentative car la difficulté est déjà calée)
  step("P4 — vérification de la justesse + scope (à l'aveugle)…", 80);
  let report: VerifyReport | undefined;
  try {
    const v = await verifyAndHarden({ title: q.concept, questions: [q] }, regenerateExercise, 1, (m) => step(m, 84));
    q = v.spec.questions[0] ?? q;
    report = v.report;
  } catch (e) {
    step(`P4 — vérif interrompue : ${(e as Error).message}`, 86);
  }

  step("Compilation du PDF (sans garde)…", 92);
  const out = await persistExercise(q, report, "architect");
  if (out.texError) step(`⚠ LaTeX → repli HTML (${out.texError.slice(0, 140)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s · ${auditLog.length} passe(s) adversariale(s))`, 100);
  return { ...out, auditLog };
}
