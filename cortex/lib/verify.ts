import { currentCourse } from "@/db/client";
import { EXAM_OUTPUT_MAX_TOKENS, completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { getCourse } from "@/lib/courses";
import { LATEX_FORMULA_RULE } from "@/lib/tex-rich";
import { verifyDeterministic } from "@/lib/verify-deterministic";
import { arithmeticSlips, missingSubquestions, namesLabel, subquestionLabels } from "@/lib/verify-arith";
import { repairConfirmEnabled, verifyV2Enabled } from "@/lib/verif-switches";
import { examsDir } from "@/lib/paths";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";
import path from "node:path";

export type VerifyResult = {
  verdict: "ok" | "wrong" | "ambiguous";
  my_solution?: string;
  issue?: string;
  corrected_solution_tex?: string;
  /** Énoncé réparé (hypothèse manquante écrite), avec un verdict « ambiguous ». */
  corrected_statement_tex?: string;
  violates_exclusion?: boolean;
  too_easy?: boolean;
  /** V — méthode de vérif (additif) : « deterministic » si la réponse a été PROUVÉE (calcul/symbolique). */
  method?: "deterministic" | "llm";
};
export type ResultRow = { index: number; verdict: string; issue?: string; verified: 1 | 0 | null; method?: string };

/** Dernière égalité « = X » d'une solution (heuristique de réponse finale, pour la vérif déterministe). */
function lastExpr(s: string): string {
  const eqs = [...(s || "").matchAll(/=\s*([^=\n;]{1,64}?)\s*(?:[.;]|\\\\|$)/g)];
  return eqs.length ? eqs[eqs.length - 1][1].trim() : "";
}
export type VerifyReport = {
  results: ResultRow[];
  ok: number;
  fixed: number;
  regenerated: number;
  removed: number;
  unverified: number;
  // alias historique (compat persistExam)
  flagged: number;
};

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "ok | wrong | ambiguous" },
    issue: { type: "string", description: "Court : la sous-question en cause et ce qui ne va pas (calcul, tableau ↔ conclusion, hypothèse manquante). Vide si ok." },
    corrected_solution_tex: { type: "string", description: "Si verdict=wrong ou ambiguous : le corrigé LaTeX COMPLET et correct, toutes les sous-questions réécrites en entier (les justes recopiées), jamais « inchangé » ni renvoi au corrigé proposé." },
    corrected_statement_tex: { type: "string", description: "UNIQUEMENT si verdict=ambiguous : l'énoncé LaTeX COMPLET, identique au proposé sauf l'hypothèse manquante écrite explicitement (ou la sous-question resserrée), mêmes \\subq, mêmes points." },
    violates_exclusion: { type: "boolean", description: "true si l'énoncé porte sur un sujet EXCLU." },
    too_easy: { type: "boolean", description: "true si, comparé à la vraie page de référence : pas de piège / nombres ronds / faible charge / pas de cas-limite / snippet déconnecté." },
  },
  required: ["verdict"],
  additionalProperties: false,
} as const;

/**
 * Surcharges optionnelles de la vérif : les exos LABS (8%) ont leurs propres directives
 * (écrire/débugger du C AUTORISÉ) et leur propre étape 1 (moule Q6 2025 + fichiers du lab).
 * `opts` absent = comportement historique.
 */
export type VerifyOpts = {
  directives?: string;
  step1?: string;
  /**
   * Examen en lots (et son comblement) : un exercice encore faux ou ambigu sans réparation
   * utilisable au bout des tentatives est RETIRÉ (son slot est recomblé, ou remboursé) au lieu
   * d'être livré « gardé (faible) ». Absent : les voies à un seul exercice gardent l'original.
   */
  dropUnfixed?: boolean;
  /** Interne : contrôle d'un exercice qui vient d'être réparé (CORTEX_VERIFY_CONFIRM=1), « ok » plus strict. */
  confirmRepair?: boolean;
};

/**
 * ÉTAPE 1 — RE-RÉSOLUTION INDÉPENDANTE : l'exercice est résolu de zéro, dans un appel qui ne voit
 * PAS le corrigé proposé. Banc du 23/11/2026 : résolu et comparé dans le même appel, le vérificateur
 * lisait le corrigé avant de répondre et validait « ok » 5 corrigés faux sur 6 (Sonnet 5, CS-202).
 * Il liste aussi les hypothèses qu'il a dû poser : la moitié des clés fausses venaient d'un énoncé
 * qui ne donnait pas une hypothèse dont le corrigé dépendait (cache ARP, MSS, égalité de métriques).
 */
async function verifySolve(q: ExamQuestion, opts: VerifyOpts | undefined, figPath: string | null): Promise<string | null> {
  const p = profile();
  const c = getCourse(currentCourse());
  const img = p.refImageFor(q.category, q.concept);
  const step1 = opts?.step1 ?? (img
    ? `Ouvre d'abord la vraie page de référence du MÊME TYPE : ${img} (outil Read). Puis RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, compte).`
    : `RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, prouve).`);
  const prompt = [
    `Tu es un assistant (TA) rigoureux de ${c.examCode} ${c.examName} (${c.university}). RÉSOLUTION INDÉPENDANTE d'un exercice d'examen blanc : tu n'as pas son corrigé, un autre assistant comparera ta solution au corrigé proposé.`,
    opts?.directives ?? p.directivesBlock(),
    ``,
    step1,
    figPath ? `L'exercice s'appuie sur une FIGURE GÉNÉRÉE : OUVRE ${figPath} (outil Read) et résous DEPUIS la figure. Si elle ne permet pas de répondre, écris-le dans HYPOTHÈSES.` : ``,
    ``,
    `ÉNONCÉ (LaTeX) :`,
    q.statement_tex,
    ``,
    `Écris ta solution sous-question par sous-question, chacune terminée par « RÉPONSE <étiquette> : <résultat final concis> » (valeur, ensemble, oui/non, ordre, contenu exact).`,
    `Termine par une section « HYPOTHÈSES : » : chaque hypothèse que tu as dû poser parce que l'énoncé ne la donne pas (convention, départage d'une égalité, ordre d'exécution, état initial, valeur par défaut, taille de segment…), et chaque sous-question qui admet PLUSIEURS réponses défendables selon l'énoncé tel qu'il est écrit, avec ces réponses. Écris « aucune » s'il n'y en a pas.`,
    `N'écris aucun fichier.`,
  ].join("\n");
  try {
    // 9 min : une re-résolution complète d'un exercice dense (6 sous-questions) prend 4 à 6 min.
    const text = await completeText({ prompt, model: "opus", timeoutMs: 540_000, maxTokens: EXAM_OUTPUT_MAX_TOKENS, ...(figPath ? { addDirs: [examsDir()] } : {}) });
    return text?.trim() || null;
  } catch {
    return null;
  }
}

/** Contrôles sans modèle du corrigé proposé, écrits pour la comparaison (vide s'il n'y a rien). */
function automaticChecks(q: ExamQuestion): string {
  const slips = arithmeticSlips(q.solution_tex).slice(0, 12);
  const missing = missingSubquestions(q.statement_tex, q.solution_tex);
  return [
    ...slips.map((x) => `- égalité fausse dans le corrigé : « ${x.expr} = ${x.claimed} » (le recalcul donne ${x.actual})`),
    ...(missing.length ? [`- sous-question(s) de l'énoncé sans réponse dans le corrigé : ${missing.join(", ")}`] : []),
  ].join("\n");
}

/**
 * ÉTAPE 2 — COMPARAISON au corrigé proposé, avec la résolution indépendante et les contrôles
 * automatiques sous les yeux : sous-question par sous-question, désaccord tranché par un recalcul,
 * conclusion confrontée aux tableaux et calculs du corrigé lui-même, hypothèses manquantes.
 * Une réparation (corrigé, ou énoncé + corrigé) plutôt qu'un simple verdict.
 */
async function verifyCompare(q: ExamQuestion, opts: VerifyOpts | undefined, blind: string): Promise<VerifyResult | null> {
  const p = profile();
  const c = getCourse(currentCourse());
  const checks = automaticChecks(q);
  const prompt = [
    `Tu es un assistant (TA) rigoureux de ${c.examCode} ${c.examName} (${c.university}). Tu contrôles UN SEUL exercice d'examen blanc avant qu'il parte à un étudiant.`,
    opts?.directives ?? p.directivesBlock(),
    ``,
    `ÉNONCÉ (LaTeX) :`,
    q.statement_tex,
    ``,
    `CORRIGÉ PROPOSÉ (LaTeX) :`,
    q.solution_tex,
    ``,
    `RÉSOLUTION INDÉPENDANTE (un autre assistant, sans voir le corrigé) :`,
    blind,
    ``,
    `CONTRÔLES AUTOMATIQUES DU CORRIGÉ (recalcul des égalités, sous-questions) :`,
    checks || "- aucune anomalie relevée",
    ``,
    `Procède sous-question par sous-question :`,
    `1. Compare la réponse du corrigé à celle de la résolution indépendante. Quand elles diffèrent, REFAIS le calcul toi-même pour trancher : ne suis ni l'un ni l'autre par défaut.`,
    `2. Vérifie que chaque conclusion du corrigé découle de SES PROPRES tableaux, traces et calculs (une ligne de tableau qui donne « non » et une conclusion « oui », un goulot qui n'est pas le minimum de son chemin, une valeur recopiée différente de l'énoncé : FAUX), et qu'aucune égalité relevée par les contrôles automatiques ne reste fausse.`,
    `3. Hypothèses : si le corrigé ou la résolution indépendante a besoin d'une hypothèse que l'énoncé ne donne pas, ou si une sous-question admet plusieurs réponses défendables, l'exercice est AMBIGU — même si le corrigé est juste sous son hypothèse.`,
    ...(opts?.confirmRepair ? [
      // Banc du 24/11/2026 (CS-202, Opus 5.5) : les 4 clés fausses livrées étaient des réparations
      // d'énoncé trop faibles (« recv rend au moins un octet ») que ce même contrôle avait acceptées.
      `4. CONFIRMATION D'UNE RÉPARATION : cet énoncé et ce corrigé viennent d'être réparés après un premier contrôle. "ok" seulement si la résolution indépendante donne, à CHAQUE sous-question, la même réponse que le corrigé, et si aucune de ses HYPOTHÈSES ne change un résultat. Sinon "wrong" ou "ambiguous" : la réparation n'est pas confirmée et l'exercice sera retiré.`,
    ] : []),
    ``,
    `Verdict :`,
    `- "ok" : énoncé bien posé (une seule réponse défendable par sous-question), corrigé correct et complet, ET difficulté/richesse/piège au niveau des vrais examens.`,
    `- "wrong" : énoncé bien posé mais corrigé FAUX ou incomplet → corrected_solution_tex : le BON corrigé COMPLET en LaTeX, toutes les sous-questions réécrites en entier (il remplace le corrigé proposé tel quel).`,
    `- "ambiguous" : énoncé sous-déterminé, mal posé ou incohérent avec son barème → corrected_statement_tex : l'énoncé COMPLET, identique sauf l'hypothèse manquante écrite explicitement (ou la sous-question resserrée pour n'avoir qu'une réponse), mêmes \\subq et mêmes points ; ET corrected_solution_tex : le corrigé COMPLET cohérent avec ce nouvel énoncé.`,
    `  ${LATEX_FORMULA_RULE}`,
    `too_easy=true si, COMPARÉ aux vrais examens : pas de vrai piège, nombres ronds, faible charge de calcul/bookkeeping, pas de cas-limite/frontière, ou simple snippet déconnecté au lieu d'un artefact creusé. Dans issue, dis QUOI ajouter.`,
    `violates_exclusion=true si l'énoncé porte sur un sujet EXCLU par les directives.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. N'écris aucun fichier.`,
    JSON.stringify(COMPARE_SCHEMA, null, 2),
  ].join("\n");
  try {
    // Sans limite propre, l'API coupait à 16 000 tokens la vérification qui trouve l'erreur et
    // réécrit le corrigé (banc du 17/11 : 65 % d'entre elles) → exercice livré « non vérifié ».
    const text = await completeText({ prompt, model: "opus", timeoutMs: 540_000, maxTokens: EXAM_OUTPUT_MAX_TOKENS });
    const r = extractJson<VerifyResult>(text);
    return r && r.verdict ? r : null;
  } catch {
    return null;
  }
}

/** Contrôle UN exercice : re-résolution sans le corrigé, PUIS comparaison au corrigé proposé.
 *  Une question à FIGURE est re-résolue DEPUIS la figure (PNG ouvert par le vérifieur). */
async function verifyOne(q: ExamQuestion, opts?: VerifyOpts): Promise<VerifyResult | null> {
  const figPath = q.figureFile ? path.join(path.relative(process.cwd(), examsDir()), q.figureFile) : null;
  const blind = await verifySolve(q, opts, figPath);
  if (!blind) return null; // fallback honnête : non vérifié (jamais "ok" par défaut)
  const r = await verifyCompare(q, opts, blind);
  if (!r) return null;
  r.my_solution = blind;
  // ADDITIF — vérif DÉTERMINISTE de la réponse finale (re-résolution vs corrigé proposé) :
  // si la réponse est PROUVÉE équivalente (calcul/symbolique), on l'étiquette « deterministic ».
  r.method = "llm";
  try {
    // question à figure avec vérité déclarée UNIQUE : preuve contre la vérité
    // de la spec (calculée au rendu depuis les données mêmes de la figure).
    if (q.figureTruth && Object.keys(q.figureTruth).length === 1) {
      const d = await verifyDeterministic(lastExpr(blind), "", "figure", { figureTruth: q.figureTruth });
      if (d.verified === true) r.method = "deterministic";
      else if (d.verified === false && r.verdict === "ok") { r.verdict = "wrong"; r.issue = `réponse ≠ vérité de la figure (${d.detail})`; }
    }
    const a = lastExpr(blind), b = lastExpr(q.solution_tex ?? "");
    if (r.method === "llm" && a && b) { const d = await verifyDeterministic(a, b, "numeric"); if (d.verified === true) r.method = "deterministic"; }
  } catch { /* python/sympy absent → reste « llm » */ }
  return r;
}

/** Contrat de la vérification historique (un seul appel : résolution puis verdict). */
const LEGACY_ONE_SCHEMA = {
  type: "object",
  properties: {
    my_solution: { type: "string", description: "TA solution complète, résolue de zéro (avant de regarder le corrigé proposé)." },
    verdict: { type: "string", description: "ok | wrong | ambiguous" },
    issue: { type: "string", description: "Court : ce qui ne va pas / ce qui manque (piège, interaction, nombres). Vide si ok." },
    corrected_solution_tex: { type: "string", description: "UNIQUEMENT si verdict=wrong : le corrigé LaTeX COMPLET et correct, toutes les sous-questions réécrites en entier (les justes recopiées), jamais « inchangé » ni renvoi au corrigé proposé." },
    violates_exclusion: { type: "boolean", description: "true si l'énoncé porte sur un sujet EXCLU." },
    too_easy: { type: "boolean", description: "true si, comparé à la vraie page de référence : pas de piège / nombres ronds / faible charge / pas de cas-limite / snippet déconnecté." },
  },
  required: ["my_solution", "verdict"],
  additionalProperties: false,
} as const;

/** CHAÎNE HISTORIQUE (défaut, CORTEX_VERIFY_V2 absent) — contrôle UN exercice : résolution à l'aveugle (avec la vraie page de réf) PUIS verdict.
 *  Une question à FIGURE est re-résolue DEPUIS la figure : le PNG rendu est
 *  ouvert (vision) par le vérifieur ; s'il ne suffit pas à répondre, le verdict le dit. */
async function verifyOneLegacy(q: ExamQuestion, opts?: VerifyOpts): Promise<VerifyResult | null> {
  const p = profile();
  const c = getCourse(currentCourse());
  const img = p.refImageFor(q.category, q.concept);
  const figPath = q.figureFile ? path.join(path.relative(process.cwd(), examsDir()), q.figureFile) : null;
  const step1 = opts?.step1 ?? (img
    ? `ÉTAPE 1 — Ouvre la vraie page de référence du MÊME TYPE : ${img} (outil Read). Puis RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, compte). Écris ta solution complète dans "my_solution". Ne te laisse PAS influencer par le corrigé proposé (tu le verras à l'étape 2).`
    : `ÉTAPE 1 — RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, prouve). Écris ta solution complète dans "my_solution". Ne te laisse PAS influencer par le corrigé proposé (tu le verras à l'étape 2).`);
  const prompt = [
    `Tu es un assistant (TA) rigoureux de ${c.examCode} ${c.examName} (${c.university}). Tu contrôles UN SEUL exercice d'examen blanc.`,
    opts?.directives ?? p.directivesBlock(),
    ``,
    step1,
    figPath ? `L'exercice s'appuie sur une FIGURE GÉNÉRÉE : OUVRE ${figPath} (outil Read) et résous DEPUIS la figure. Si la figure ne permet PAS de répondre (illisible, quantités absentes), verdict "ambiguous" avec issue="figure insuffisante".` : ``,
    ``,
    `ÉNONCÉ (LaTeX) :`,
    q.statement_tex,
    ``,
    `ÉTAPE 2 — Compare maintenant ta solution au CORRIGÉ PROPOSÉ ci-dessous, et donne un verdict honnête :`,
    `CORRIGÉ PROPOSÉ (LaTeX) :`,
    q.solution_tex,
    ``,
    `- "ok" : énoncé bien posé, corrigé proposé correct et complet, ET difficulté/richesse/piège au niveau de la vraie page de référence.`,
    `- "wrong" : corrigé proposé FAUX ou incomplet → fournis corrected_solution_tex : le BON corrigé COMPLET en LaTeX, toutes les sous-questions réécrites en entier (il remplace le corrigé proposé tel quel).`,
    `  ${LATEX_FORMULA_RULE}`,
    `- "ambiguous" : énoncé mal posé / non résoluble / ambigu / incohérent avec son barème.`,
    `too_easy=true si, COMPARÉ à la vraie page : pas de vrai piège, nombres ronds, faible charge de calcul/bookkeeping, pas de cas-limite/frontière, ou simple snippet déconnecté au lieu d'un artefact creusé. Dans issue, dis QUOI ajouter.`,
    `violates_exclusion=true si l'énoncé porte sur un sujet EXCLU par les directives.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. N'écris aucun fichier.`,
    JSON.stringify(LEGACY_ONE_SCHEMA, null, 2),
  ].join("\n");
  try {
    // 9 min : la re-résolution à l'aveugle d'un exo DENSE de l'architecte (6 sous-questions +
    // comparaison au corrigé) frôlait les 340 s → timeout → « non vérifié » systématique. Mesuré :
    // une re-résolution complète prend ~4–6 min ; on laisse de la marge.
    // Sans limite propre, l'API coupait à 16 000 tokens la vérification qui trouve l'erreur et
    // réécrit le corrigé (banc du 17/11 : 65 % d'entre elles) → exercice livré « non vérifié ».
    const text = await completeText({ prompt, model: "opus", timeoutMs: 540_000, maxTokens: EXAM_OUTPUT_MAX_TOKENS, ...(figPath ? { addDirs: [examsDir()] } : {}) });
    const r = extractJson<VerifyResult>(text);
    if (!r || !r.verdict) return null;
    // ADDITIF — vérif DÉTERMINISTE de la réponse finale (re-solve à l'aveugle vs corrigé proposé) :
    // si la réponse est PROUVÉE équivalente (calcul/symbolique), on l'étiquette « deterministic »
    // (moat « prouvé »). Ne change NI le verdict NI le contenu (cs-202 byte-identique) — juste un label.
    r.method = "llm";
    try {
      // question à figure avec vérité déclarée UNIQUE : preuve contre la vérité
      // de la spec (calculée au rendu depuis les données mêmes de la figure).
      if (q.figureTruth && Object.keys(q.figureTruth).length === 1) {
        const d = await verifyDeterministic(lastExpr(r.my_solution ?? "") ?? "", "", "figure", { figureTruth: q.figureTruth });
        if (d.verified === true) r.method = "deterministic";
        else if (d.verified === false && r.verdict === "ok") { r.verdict = "wrong"; r.issue = `réponse ≠ vérité de la figure (${d.detail})`; }
      }
      const a = lastExpr(r.my_solution ?? ""), b = lastExpr(q.solution_tex ?? "");
      if (r.method === "llm" && a && b) { const d = await verifyDeterministic(a, b, "numeric"); if (d.verified === true) r.method = "deterministic"; }
    } catch { /* python/sympy absent → reste « llm » */ }
    return r;
  } catch {
    return null; // fallback honnête : non vérifié (jamais "ok" par défaut)
  }
}

/**
 * EVALS (additif, lecture seule) — SOLVEUR À L'AVEUGLE réutilisé : résout une question DE ZÉRO,
 * sans corrigé, avec exactement la même posture que l'étape 1 de `verifyOne` (le composant qui
 * garantit que les corrigés générés sont corrects). Ne change RIEN au comportement de génération.
 * Retourne le texte de la solution (+ dernière ligne « RÉPONSE : … »), ou null si l'appel échoue.
 */
export async function solveFromScratch(questionText: string, opts?: VerifyOpts): Promise<string | null> {
  const p = profile();
  const c = getCourse(currentCourse());
  const prompt = [
    `Tu es un assistant (TA) rigoureux de ${c.examCode} ${c.examName}. RÉSOUS l'exercice d'examen ci-dessous DE ZÉRO, toi-même, rigoureusement (calcule, trace, compte, prouve, justifie). Ne devine pas : si un calcul est nécessaire, fais-le.`,
    opts?.directives ?? p.directivesBlock(),
    ``,
    `ÉNONCÉ :`,
    questionText,
    ``,
    `Écris ta solution complète. Puis, sur la TOUTE DERNIÈRE ligne, donne « RÉPONSE : <ta réponse finale, concise> » (le résultat numérique / le choix / la conclusion). N'écris aucun fichier.`,
  ].join("\n");
  try {
    const text = await completeText({ prompt, model: "opus", timeoutMs: 540_000 });
    return text?.trim() || null;
  } catch {
    return null; // fallback honnête : non résolu (jamais une fausse réponse)
  }
}

async function mapPool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const isInvalid = (r: VerifyResult | null) =>
  !!r && (r.verdict === "wrong" || r.verdict === "ambiguous" || !!r.violates_exclusion || !!r.too_easy);

/**
 * Une correction du vérificateur ne remplace le corrigé que si elle est COMPLÈTE : chaque
 * sous-question de l'énoncé y figure et rien ne renvoie à des parties « inchangées » du corrigé
 * proposé. Banc du 16/11 (ex9) : correction partielle substituée → corrigé livré réduit à 3.4.
 */
function isCompleteCorrection(corrected: string, statement: string): boolean {
  if (/inchang|unchanged|sans changement|identiques? (?:au|à|to)|cf\.? (?:le )?corrigé/i.test(corrected)) return false;
  return subquestionLabels(statement).every((l) => namesLabel(corrected, l));
}

/**
 * La réparation proposée par la comparaison, si elle est utilisable telle quelle : corrigé complet
 * (verdict « wrong »), ou énoncé réécrit + corrigé complet (verdict « ambiguous »). L'énoncé réparé
 * garde les mêmes sous-questions : une réparation qui en perd ou en ajoute n'est pas une réparation.
 */
function repairOf(q: ExamQuestion, r: VerifyResult): ExamQuestion | null {
  const sol = r.corrected_solution_tex?.trim() ?? "";
  if (sol.length <= 10) return null;
  if (r.verdict === "wrong") return isCompleteCorrection(sol, q.statement_tex) ? { ...q, solution_tex: sol } : null;
  if (r.verdict !== "ambiguous") return null;
  const st = r.corrected_statement_tex?.trim() ?? "";
  if (st.length < q.statement_tex.length / 2) return null;
  if (subquestionLabels(st).join("|") !== subquestionLabels(q.statement_tex).join("|")) return null;
  return isCompleteCorrection(sol, st) ? { ...q, statement_tex: st, solution_tex: sol } : null;
}

/**
 * Vérifie CHAQUE exercice (re-résolution sans le corrigé, puis comparaison ; parallélisme borné),
 * puis DURCIT, à N=maxAttempts tours au plus :
 *  - corrigé faux ou énoncé ambigu AVEC une réparation complète → la réparation est appliquée et
 *    revérifiée (moins cher qu'une régénération, et l'erreur trouvée n'est pas perdue) ;
 *  - trop facile, hors programme, ou faux sans réparation utilisable → régénéré puis revérifié.
 * Au bout des tours : réparation du dernier tour appliquée si elle existe ; hors programme retiré ;
 * faux ou ambigu sans réparation retiré avec `dropUnfixed`, sinon gardé (faible). Une vérification
 * qui n'aboutit pas est relancée une fois. Fallback honnête : jamais de faux "ok".
 */
export async function verifyAndHarden(
  spec: ExamSpec,
  regenerate: (q: ExamQuestion, diagnostic: string) => Promise<ExamQuestion>,
  maxAttempts = 3,
  onProgress?: (msg: string) => void,
  opts?: VerifyOpts
): Promise<{ spec: ExamSpec; report: VerifyReport }> {
  let done = 0;
  const total = spec.questions.length;
  // Chaîne historique (défaut) : vérification en un appel, régénération d'abord, faible gardé.
  const hardenLegacy = async (q0: ExamQuestion) => {
    let q = q0;
    let attempts = 0;
    let res = await verifyOneLegacy(q, opts);
    while (isInvalid(res) && attempts < maxAttempts) {
      const r = res!;
      const diag = [
        r.issue ?? "",
        r.too_easy ? "TROP FACILE vs la vraie page de référence : ajoute un VRAI piège (cas-limite / multi-saut / frontière direct-indirect / égalité longest-prefix), augmente la charge de calcul, et utilise des NOMBRES NON RONDS." : "",
        r.violates_exclusion ? "HORS-SCOPE : remplace par un sujet AUTORISÉ par les directives." : "",
        r.verdict === "ambiguous" ? "ÉNONCÉ MAL POSÉ : rends-le résoluble et non ambigu, cohérent avec son barème." : "",
      ].filter(Boolean).join(" ");
      let ng: ExamQuestion | null = null;
      try { ng = await regenerate(q, diag); } catch { ng = null; }
      if (!ng) break;
      q = ng;
      attempts++;
      res = await verifyOneLegacy(q, opts);
    }
    let verified: 1 | 0 | null;
    let dropped = false;
    let fixedSol = false;
    if (!res) verified = null;
    else if (res.verdict === "ok" && !res.violates_exclusion && !res.too_easy) verified = 1;
    else if (res.verdict === "wrong" && res.corrected_solution_tex && res.corrected_solution_tex.length > 10 && isCompleteCorrection(res.corrected_solution_tex, q.statement_tex)) {
      q.solution_tex = res.corrected_solution_tex;
      verified = 1;
      fixedSol = true;
    } else if (res.violates_exclusion) {
      // hors-scope = retiré (dernier recours documenté ; on préfère remplacer mais ici on ne tombe à <6 que pour ça)
      dropped = true;
      verified = 0;
    } else {
      // en scope mais faible/ambigu après N tentatives → GARDÉ (on garde 6 exos), marqué non-validé
      verified = 0;
    }
    done++;
    const tag = !res ? "non vérifié" : verified === 1 ? (fixedSol ? "corrigé" : "ok") : dropped ? "retiré" : "gardé (faible)";
    onProgress?.(`Vérif ${done}/${total} — « ${q.concept.slice(0, 48)} » : ${tag}${attempts ? ` (durci ×${attempts})` : ""}`);
    return { q, res, verified, dropped, regenerated: attempts > 0, fixedSol };
  };
  const v2 = verifyV2Enabled();
  const confirm = repairConfirmEnabled();
  const check = async (q: ExamQuestion, confirming = false) => {
    const o = confirming ? { ...opts, confirmRepair: true } : opts;
    return (await verifyOne(q, o)) ?? (await verifyOne(q, o));
  };
  // Réparation confirmée : la 2e résolution à l'aveugle de l'exercice réparé le trouve bien posé et juste.
  const confirmed = (r: VerifyResult | null) => !!r && r.verdict === "ok" && !r.violates_exclusion;
  const processed = await mapPool(spec.questions, 3, async (q0) => {
    if (!v2) return hardenLegacy(q0);
    let q = q0;
    let attempts = 0;
    let repairs = 0;
    let unconfirmed = false;
    let res = await check(q);
    while (isInvalid(res) && attempts + repairs < maxAttempts) {
      const r = res!;
      const fix = !r.too_easy && !r.violates_exclusion ? repairOf(q, r) : null;
      if (fix) {
        q = fix;
        repairs++;
        res = await check(q, confirm);
        // Avec confirmation : une réparation que la 2e résolution ne confirme pas n'est ni réparée à
        // nouveau ni régénérée — l'exercice est retiré (son slot est recomblé).
        if (confirm && !confirmed(res)) { unconfirmed = true; break; }
        continue;
      }
      const diag = [
        r.issue ?? "",
        r.too_easy ? "TROP FACILE vs la vraie page de référence : ajoute un VRAI piège (cas-limite / multi-saut / frontière direct-indirect / égalité longest-prefix), augmente la charge de calcul, et utilise des NOMBRES NON RONDS." : "",
        r.violates_exclusion ? "HORS-SCOPE : remplace par un sujet AUTORISÉ par les directives." : "",
        r.verdict === "ambiguous" ? "ÉNONCÉ MAL POSÉ : rends-le résoluble et non ambigu, cohérent avec son barème ; écris explicitement toute hypothèse dont la réponse dépend." : "",
      ].filter(Boolean).join(" ");
      let ng: ExamQuestion | null = null;
      try { ng = await regenerate(q, diag); } catch { ng = null; }
      if (!ng) break;
      q = ng;
      attempts++;
      res = await check(q);
    }
    let verified: 1 | 0 | null;
    let dropped = false;
    let lastFix = !unconfirmed && res && (res.verdict === "wrong" || res.verdict === "ambiguous") && !res.violates_exclusion ? repairOf(q, res) : null;
    if (confirm && lastFix) {
      // Réparation du dernier tour : contrôlée elle aussi au lieu d'être acceptée telle quelle.
      const c = await check(lastFix, true);
      repairs++;
      if (confirmed(c)) { q = lastFix; res = c; } else unconfirmed = true;
      lastFix = null;
    }
    let fixedSol = repairs > 0 && !unconfirmed && !!res && !isInvalid(res);
    if (unconfirmed) {
      // réparation non confirmée : jamais livrée comme vérifiée ; retirée dans un examen en lots
      dropped = !!opts?.dropUnfixed;
      verified = 0;
    } else if (!res) verified = null;
    else if (res.violates_exclusion) {
      // hors-scope = retiré (dernier recours documenté ; on préfère remplacer)
      dropped = true;
      verified = 0;
    } else if (res.verdict === "ok") verified = res.too_easy ? 0 : 1; // trop facile mais juste : gardé (faible)
    else if (lastFix) {
      q = lastFix;
      verified = 1;
      fixedSol = true;
    } else if (opts?.dropUnfixed) {
      // faux ou ambigu sans réparation : une clé fausse ne part pas → retiré, le slot est recomblé
      dropped = true;
      verified = 0;
    } else {
      // voie à un seul exercice : gardé, marqué non validé
      verified = 0;
    }
    done++;
    const tag = unconfirmed ? (dropped ? "retiré" : "gardé (faible)") : !res ? "non vérifié" : verified === 1 ? (fixedSol ? "corrigé" : "ok") : dropped ? "retiré" : "gardé (faible)";
    const how = [repairs ? `réparé ×${repairs}` : "", attempts ? `durci ×${attempts}` : "", unconfirmed ? "réparation non confirmée" : ""].filter(Boolean).join(", ");
    onProgress?.(`Vérif ${done}/${total} — « ${q.concept.slice(0, 48)} » : ${tag}${how ? ` (${how})` : ""}`);
    return { q, res, verified, dropped, regenerated: attempts > 0, fixedSol };
  });

  const kept = processed.filter((p) => !p.dropped);
  const finalSpec: ExamSpec = { ...spec, questions: kept.map((p) => p.q) };
  const results: ResultRow[] = kept.map((p, i) => ({
    index: i,
    verdict: p.res?.verdict ?? "unverified",
    issue: p.res?.issue,
    verified: p.verified,
    method: p.verified === null ? "unverified" : (p.res?.method ?? "llm"),
  }));
  const report: VerifyReport = {
    results,
    ok: processed.filter((p) => p.verified === 1 && !p.fixedSol && !p.regenerated).length,
    fixed: processed.filter((p) => p.fixedSol).length,
    regenerated: processed.filter((p) => p.regenerated && !p.dropped).length,
    removed: processed.filter((p) => p.dropped).length,
    unverified: processed.filter((p) => p.verified === null).length,
    flagged: processed.filter((p) => p.dropped || p.verified === null).length,
  };
  return { spec: finalSpec, report };
}
