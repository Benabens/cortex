import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import type { Archetype } from "@/lib/archetypes";
import { calibrationBlock } from "@/lib/calibration";
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
import { getExamDna, fewShotForMold } from "@/lib/exam-dna";
import { MOLD_DEFS, type MoldKind } from "@/lib/molds";
import { renderFigure, figureSpecPromptBlock, injectFigureTex, type FigureSpec } from "@/lib/figure-gen";
import { examsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * V3 — L'ARCHITECTE D'EXAMEN (pipeline multi-passes pour UN exercice ciblé).
 *
 * moteur-v2 (P3) — 100 % GÉNÉRIQUE : la persona, les archétypes et le barème viennent du PROFIL
 * DU COURS COURANT (détecté/configuré), plus AUCUNE mention de matière en dur dans ce chemin
 * partagé (les questions ouvertes de tout cours passent ici). Le MOULE imposé (ADN détecté) et
 * les few-shot RÉELS du moule resserrent l'imitation ; une figure (FIGURE SPEC) peut être exigée.
 *
 * Boucle : P0 Étudier (vraie page + fiche difficulté) → P1 Concevoir le PIÈGE → P2 Rédiger →
 * P3 Critique ADVERSARIALE + RÉVISION (bornée) → P4 Vérifier la JUSTESSE (verifyAndHarden).
 */

/** Persona dérivée du cours courant (jamais une matière en dur dans ce module partagé). */
function persona(): string {
  return profile().qaIntro?.() ?? "Tu es l'équipe enseignante du cours.";
}

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

/** Barème d'un archétype : dérivé des SLOTS du PROFIL du cours (catégorie correspondante),
 *  repli 25. (Reproduit le barème historique du cours par défaut via ses propres slots — zéro constante ici.) */
async function pointsFor(a: Archetype): Promise<number> {
  try {
    const slots = await profile().examSlots();
    const hit = slots.find((s) => s.category === a.category);
    if (hit && hit.points > 0) return hit.points;
  } catch {}
  return 25;
}

// ───────── Image → exo : identification du concept par VISION (avant l'architecte) ─────────
type ImageId = { archetype_id: string; concept: string; technique: string; student_error: string };

/** Schéma d'identification construit sur les archétypes DU COURS COURANT (jamais une liste en dur). */
function imageIdSchema(): object {
  const ids = profile().archetypes.map((a) => a.id);
  return {
    type: "object",
    properties: {
      archetype_id: { type: "string", description: `L'archétype du cours le plus proche, EXACTEMENT l'un de : ${ids.join(" | ")}.` },
      concept: { type: "string", description: "Le concept testé par l'exercice de l'image (court)." },
      technique: { type: "string", description: "La TECHNIQUE/MÉTHODE précise à maîtriser (ce que le nouvel exo doit retester sur un autre setup)." },
      student_error: { type: "string", description: "Si une note d'erreur est fournie : l'erreur sous-jacente à punir ; sinon vide." },
    },
    required: ["archetype_id", "concept", "technique", "student_error"],
    additionalProperties: false,
  } as const;
}

/** Lit l'image d'un exo (vision) et identifie l'archétype + le concept + la technique à retester. */
async function identifyFromImage(image: string, note: string | undefined, step: StepCb): Promise<ImageId> {
  step("Lecture de l'image (vision) — identification du concept…", 8);
  const ids = new Set(profile().archetypes.map((a) => a.id));
  const prompt = [
    `${persona()} OUVRE et observe attentivement cette image : ${image} (outil Read).`,
    `C'est un exercice (d'examen, de série, ou un exo que l'étudiant a raté).`,
    note ? `Note de l'étudiant (pourquoi il a buté) : « ${note} ».` : ``,
    `Identifie le CONCEPT et la TECHNIQUE précise testés, et l'archétype du cours le plus proche.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(imageIdSchema(), null, 2),
  ].filter((l) => l != null).join("\n");
  const text = await completeText({ prompt, model: "opus", timeoutMs: 220_000 });
  const r = extractJson<ImageId>(text);
  if (!ids.has(r.archetype_id)) r.archetype_id = "";
  return r;
}

/** Bloc « dérivé d'une source » (image OU consigne d'exo collée) : même concept, setup ENTIÈREMENT
 *  différent, JAMAIS un copier-coller. */
function derivedSourceBlock(opts: { image?: string | null; note?: string | null; statement?: string | null }): string {
  const { image, note, statement } = opts;
  if (!image && !statement) return "";
  const head = image
    ? [`═══ DÉRIVÉ D'UNE IMAGE D'EXERCICE (point de départ) ═══`,
       `L'étudiant est parti de l'exercice montré dans : ${image} (outil Read — observe-le).`]
    : [`═══ DÉRIVÉ D'UNE CONSIGNE D'EXERCICE COLLÉE (point de départ) ═══`,
       `L'étudiant a collé l'énoncé COMPLET d'un exercice qu'il veut retravailler :`,
       `--- début de la consigne ---`, (statement ?? "").slice(0, 3500), `--- fin de la consigne ---`];
  return [
    ...head,
    note ? `Il a buté ici : « ${note} ». Ta question doit faire travailler PRÉCISÉMENT cette difficulté.` : ``,
    `IMPÉRATIF : ta question teste EXACTEMENT le même concept / la même technique, mais sur un SETUP ENTIÈREMENT DIFFÉRENT`,
    `(autres nombres NON RONDS, autre instance/contexte/structure, autre figure si pertinent). INTERDICTION ABSOLUE`,
    `de recopier ${image ? "l'image" : "la consigne"} ou de simplement échanger les constantes : un étudiant ne doit PAS pouvoir`,
    `résoudre ta question en recopiant la solution d'origine. Produis du NEUF, au niveau d'un vrai final.`,
  ].filter((l) => l != null).join("\n");
}

function contextBlock(ctx: Awaited<ReturnType<typeof gatherTargetedContext>>): string {
  const block = (title: string, items: { src: string; text: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.text}`)].join("\n") : "";
  return [
    block(`═══ PAST-EXAMS DU MÊME TYPE (le format/difficulté de la prof — PRIORITÉ) ═══`, ctx.pastexams),
    block(`═══ SÉRIES + CORRIGÉS ═══`, ctx.exercises),
    block(`═══ COURS ═══`, ctx.course),
  ].filter((l) => l != null).join("\n");
}

/** P0+P1 — étudier la vraie page la plus dure + concevoir le piège (avant de rédiger).
 *  moteur-v2 (P3) — persona du cours + MOULE imposé (ADN) : le piège se conçoit DANS le moule. */
async function designTrap(a: Archetype, target: string, refImage: string | null, step: StepCb, image?: string | null, note?: string | null, statement?: string | null, mold?: MoldKind | null): Promise<DesignBrief> {
  const r = rubricFor(a.id);
  const imgBlock = derivedSourceBlock({ image, note, statement });
  const calBlock = await calibrationBlock(a.id); // async — awaité AVANT le template (sinon "[object Promise]" dans le prompt)
  const prompt = [
    `${persona()} Tu CONÇOIS une question d'examen DURE, dans le style des annales du cours.`,
    refImage ? `ÉTUDIE D'ABORD la vraie page d'examen la plus dure de ce type : ${refImage} (outil Read) — observe sa densité, son piège, sa charge.` : ``,
    imgBlock || null,
    ``,
    `Type : ${a.concept} (archétype « ${a.id} », catégorie ${a.category}). Sujet ciblé : « ${target} ».`,
    mold ? `MOULE IMPOSÉ : ${mold} — ${MOLD_DEFS[mold]}. Conçois le piège DANS ce moule (le format de la question doit être celui du moule).` : ``,
    ``,
    trapMenuBlock(a.id),
    ``,
    r ? `BARRE : ≥ ${r.subparts} sous-questions, la dure ≥ ${r.steps} étapes, bookkeeping = ${r.bookkeeping}, ${r.mustChain ? "au moins une sous-question enchaînée, " : ""}cas-limite obligatoire.` : ``,
    ...styleFor(a.category),
    calBlock || null,
    ``,
    `NE RÉDIGE PAS encore la question. CONÇOIS-LA : choisis UN piège précis, le cas-limite qui le déclenche, la chaîne de raisonnement de l'étudiant fort, les NOMBRES NON RONDS, la grille de réponse, et la réponse erronée du pattern-matcher (ce qui discrimine). Plan des sous-questions en escalier.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier.`,
    JSON.stringify(DESIGN_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("P1 — conception du piège (étude de la vraie page + design)…", 22);
  const text = await completeText({ prompt, model: "opus", timeoutMs: 300_000 });
  return extractJson<DesignBrief>(text);
}

/** P2 — rédiger l'énoncé multi-étapes au format du cours, piège intégré, style des annales.
 *  moteur-v2 (P3) — MOULE imposé + few-shot RÉELS du moule (imitation resserrée) + cadrage
 *  appliqué ; (P1) une figure data/plot peut être émise (figure_spec) si l'ADN du cours en a. */
async function writeFromDesign(a: Archetype, target: string, pts: number, design: DesignBrief, ctx: Awaited<ReturnType<typeof gatherTargetedContext>>, refImage: string | null, step: StepCb, image?: string | null, note?: string | null, statement?: string | null, mold?: MoldKind | null, withFigures?: boolean): Promise<ExamQuestion & { figure_spec?: FigureSpec }> {
  const p = profile();
  const corpus = contextBlock(ctx);
  const imgBlock = derivedSourceBlock({ image, note, statement });
  // few-shot RÉELS du moule (annales de CE cours) — imite le style/l'ancrage, jamais copier.
  const shots = mold ? await fewShotForMold(mold, 2) : [];
  const schema = withFigures
    ? { ...ONE_EX_SCHEMA, properties: { ...ONE_EX_SCHEMA.properties, figure_spec: { type: "object", description: "UNIQUEMENT si la question exige une figure data/plot : le FIGURE SPEC décrit dans le prompt (l'énoncé place %%FIGURE%% où va la figure)." } } }
    : ONE_EX_SCHEMA;
  const prompt = [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...p.exerciseLead(target || a.concept, a, pts, refImage),
    ``,
    imgBlock || null,
    imgBlock ? `` : null,
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
    mold ? `MOULE IMPOSÉ : ${mold} — ${MOLD_DEFS[mold]}. ${mold === "statement_truefalse" ? "" : "ANCRE la question dans un scénario concret / un mini-calcul de l'idiome du cours — jamais une affirmation abstraite hors-sol."}` : ``,
    shots.length ? `VRAIES questions de ce moule dans CE cours (imite le STYLE, ne copie JAMAIS) :\n${shots.map((s) => `  · ${s}`).join("\n")}` : ``,
    mold === "figure_reading" && withFigures ? `${figureSpecPromptBlock()}\nPlace le marqueur %%FIGURE%% dans statement_tex à l'endroit de la figure.` : ``,
    ``,
    rubricBlockInline(a.id),
    ``,
    p.latexContract(),
    ``,
    `Rédige l'énoncé COMPLET (statement_tex) avec ses sous-questions \\subq{N.M}{...}{pts} et ses grilles de réponse, et le corrigé COMPLET (solution_tex) résolu étape par étape (le piège y est explicité). Le piège doit être RÉELLEMENT testé : un étudiant qui pattern-matche se trompe.`,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points${withFigures ? ", figure_spec?" : ""}}. Aucun outil au-delà de Read, aucun fichier.`,
    JSON.stringify(schema, null, 2),
  ].filter((l) => l != null).join("\n");
  step("P2 — rédaction de l'énoncé multi-étapes (format du cours + piège)…", 38);
  const text = await completeText({ prompt, model: "opus", timeoutMs: 480_000 });
  const q = extractJson<ExamQuestion & { figure_spec?: FigureSpec }>(text);
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
  const calBlock = await calibrationBlock(a.id); // async — awaité AVANT le template (sinon "[object Promise]" dans le prompt)
  const prompt = [
    `${persona()} Tu es un RELECTEUR d'examen IMPITOYABLE sur la DIFFICULTÉ. Tu joues DEUX étudiants sur la question ci-dessous.`,
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
    calBlock || null,
    `Si le pattern-matcher réussit OU le piège est absent → verdict « too_easy » + hardening CHIRURGICAL (quoi ajouter/salir/agrandir/enchaîner, sans tout réécrire). Si le fort cale → « broken » + comment simplifier au bon endroit. Sinon « good ».`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier.`,
    JSON.stringify(AUDIT_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  const text = await completeText({ prompt, model: "opus", timeoutMs: 340_000 });
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
    `RÉVISE (ne réécris pas de zéro) la question d'examen ci-dessous en gardant son squelette et son format, pour corriger ce diagnostic :`,
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
  const text = await completeText({ prompt, model: "opus", timeoutMs: 480_000 });
  const r = extractJson<ExamQuestion>(text);
  return { ...r, category: a.category, points: q.points };
}

export type ArchitectAudit = Audit;
export type ArchitectResult = { id: number; url: string; texError?: string; auditLog: Audit[] };

/**
 * CŒUR réutilisable (PERFECT B1) : P0 étudier → P1 concevoir le piège → P2 rédiger →
 * P3 critique adversariale + révision (boucle bornée). SANS la vérif de justesse ni la
 * persistance — l'appelant choisit (exo ciblé : verify+persistExercise ; examen complet :
 * verify par lots existante + persistExam). Renvoie la question + le journal d'audit.
 */
export async function architectQuestion(
  a: Archetype,
  target: string,
  pts: number,
  opts: { onStep?: StepCb; maxRounds?: number; image?: string | null; note?: string | null; statement?: string | null; mold?: MoldKind | null } = {}
): Promise<{ q: ExamQuestion; auditLog: Audit[] }> {
  const step = opts.onStep ?? (() => {});
  const maxRounds = opts.maxRounds ?? 2;
  const { image, note, statement, mold } = opts;
  const p = profile();
  const refImage = p.refImageFor(a.category, target || a.concept);
  const ctx = await gatherTargetedContext(target || a.concept);
  // figures : DATA-DRIVEN — activées seulement si l'ADN détecté du cours en contient.
  const dna = await getExamDna().catch(() => null);
  const withFigures = (dna?.figures.kinds.length ?? 0) > 0;

  step(`P0 — étude : archétype « ${a.id} » (${a.category}), vraie page ${refImage ?? "—"}${mold ? ` · moule ${mold}` : ""}`, 12);
  // P1 — concevoir le piège (en s'appuyant sur l'image / la consigne si fournie)
  const design = await designTrap(a, target, refImage, step, image, note, statement, mold);
  // P2 — rédiger (avec le contexte corpus pour ancrer le contenu)
  let q = await writeFromDesign(a, target, pts, design, ctx, refImage, step, image, note, statement, mold, withFigures);

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

  // moteur-v2 (P1) — figure émise ? Rendu SANDBOX + injection \includegraphics dans l'énoncé.
  // Échec de rendu → figure retirée (l'énoncé garde le marqueur nettoyé) — jamais un PDF cassé.
  const spec = (q as ExamQuestion & { figure_spec?: FigureSpec }).figure_spec;
  if (spec && typeof spec === "object") {
    try {
      const rf = await renderFigure({ ...spec, kind: "plot" });
      if (rf.ok && rf.pngB64) {
        const file = `fig-${crypto.randomUUID().slice(0, 8)}.png`;
        fs.mkdirSync(examsDir(), { recursive: true });
        fs.writeFileSync(path.join(examsDir(), file), Buffer.from(rf.pngB64, "base64"));
        q = { ...q, statement_tex: injectFigureTex(q.statement_tex, file), figureFile: file, figureTruth: rf.truth ?? null };
        step(`Figure rendue (sandbox) → ${file}`, 72);
      } else {
        q = { ...q, statement_tex: q.statement_tex.split("%%FIGURE%%").join("") };
        step(`Figure NON rendue (${rf.reason ?? "échec"}) — question sans figure`, 72);
      }
    } catch (e) {
      q = { ...q, statement_tex: q.statement_tex.split("%%FIGURE%%").join("") };
      step(`Figure NON rendue (${(e as Error).message.slice(0, 50)}) — question sans figure`, 72);
    }
    delete (q as ExamQuestion & { figure_spec?: FigureSpec }).figure_spec;
  }
  return { q, auditLog };
}

/**
 * Pipeline complet pour UN exercice ciblé (cs-202). Renvoie l'exo persité + le journal d'audit.
 * Boucle adversariale bornée (maxRounds), puis vérif de justesse (verifyAndHarden, maxAttempts=1).
 */
export async function architectExercise(
  target: string,
  opts: { onStep?: StepCb; maxRounds?: number; image?: string | null; note?: string | null; statement?: string | null } = {}
): Promise<ArchitectResult> {
  const t0 = Date.now();
  const step = opts.onStep ?? (() => {});
  const { image, note, statement } = opts;
  // Image → exo : la VISION identifie d'abord l'archétype + la technique à retester ;
  // sinon on choisit l'archétype d'après le sujet/la technique texte.
  let a: Archetype;
  let seed = target;
  if (image) {
    try {
      const id = await identifyFromImage(image, note ?? undefined, step);
      a = (id.archetype_id && profile().archetypes.find((x) => x.id === id.archetype_id)) || pickArchetype(`${id.technique} ${id.concept}`);
      seed = [id.technique || id.concept, target].filter(Boolean).join(" — ");
      step(`Concept identifié : « ${id.concept} » → archétype ${a.id}`, 12);
    } catch (e) {
      a = pickArchetype(target);
      step(`Identification image interrompue (${(e as Error).message}) — archétype par défaut ${a.id}`, 12);
    }
  } else {
    a = pickArchetype(statement ? `${target} ${statement}` : target);
  }
  const pts = await pointsFor(a);
  const { q: built, auditLog } = await architectQuestion(a, seed, pts, { ...opts, image, note, statement });
  let q = built;

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
  const out = await persistExercise(q, report, `architect:${a.id}`);
  if (out.texError) step(`⚠ LaTeX → repli HTML (${out.texError.slice(0, 140)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s · ${auditLog.length} passe(s) adversariale(s))`, 100);
  return { ...out, auditLog };
}
