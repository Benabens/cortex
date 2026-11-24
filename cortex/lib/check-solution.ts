import { currentCourse } from "@/db/client";
import { completeJson, extractJson } from "@/lib/llm";
import { getCourse } from "@/lib/courses";
import { coursePassages } from "@/lib/course-grounding";
import { courseLanguage, type Language } from "@/lib/exam-format";
import { languageName } from "@/lib/profiles/generic-directives";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";
import { FORMULA_RULE } from "@/lib/tex-rich";
import { assistReviewEnabled, blindSolve, slipLines } from "@/lib/assist-review";
import { benchTrace } from "@/lib/bench/trace";

export type CheckResult = {
  verdict: "correct" | "partial" | "wrong";
  feedback: string;
  correct_solution: string;
  criteria: CheckCriterion[];
  score: { earned: number; total: number };
};

export type CheckCriterion = {
  label: string;
  points: number;
  achieved: boolean;
  essential: boolean;
  justification: string;
};

type LegacyCheckResult = Omit<CheckResult, "criteria" | "score">;

function isLegacyResult(value: unknown): value is LegacyCheckResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return ["correct", "partial", "wrong"].includes(String(result.verdict))
    && typeof result.feedback === "string"
    && typeof result.correct_solution === "string";
}

/** Barème de compatibilité, dans la langue de l'examen (repli : anglais). */
const FALLBACK_WORDS: Record<Language, { approach: string; approachYes: string; approachNo: string; answer: string; answerYes: string; answerNo: string }> = {
  fr: {
    approach: "La démarche répond au problème posé", approachYes: "La démarche utile est présente dans la réponse.", approachNo: "La démarche essentielle manque ou ne permet pas de conclure.",
    answer: "La réponse est juste et complète", answerYes: "Le résultat et sa justification sont complets.", answerNo: "Le résultat ou sa justification reste incomplet ou incorrect.",
  },
  en: {
    approach: "The approach addresses the problem", approachYes: "The answer contains the relevant approach.", approachNo: "The essential approach is missing or does not lead to a conclusion.",
    answer: "The answer is correct and complete", answerYes: "The result and its justification are complete.", answerNo: "The result or its justification is incomplete or incorrect.",
  },
  de: {
    approach: "Der Lösungsweg geht auf die Aufgabe ein", approachYes: "Die Antwort enthält den passenden Lösungsweg.", approachNo: "Der wesentliche Lösungsweg fehlt oder führt zu keinem Ergebnis.",
    answer: "Die Antwort ist richtig und vollständig", answerYes: "Ergebnis und Begründung sind vollständig.", answerNo: "Ergebnis oder Begründung sind unvollständig oder falsch.",
  },
  it: {
    approach: "Il procedimento risponde al problema posto", approachYes: "La risposta contiene il procedimento utile.", approachNo: "Il procedimento essenziale manca o non permette di concludere.",
    answer: "La risposta è corretta e completa", answerYes: "Il risultato e la sua giustificazione sono completi.", answerNo: "Il risultato o la sua giustificazione sono incompleti o errati.",
  },
  es: {
    approach: "El planteamiento responde al problema", approachYes: "La respuesta contiene el planteamiento adecuado.", approachNo: "Falta el planteamiento esencial o no permite concluir.",
    answer: "La respuesta es correcta y completa", answerYes: "El resultado y su justificación están completos.", answerNo: "El resultado o su justificación están incompletos o son incorrectos.",
  },
  pt: {
    approach: "A resolução responde ao problema", approachYes: "A resposta contém a resolução adequada.", approachNo: "Falta a resolução essencial ou não permite concluir.",
    answer: "A resposta está correta e completa", answerYes: "O resultado e a sua justificação estão completos.", answerNo: "O resultado ou a sua justificação estão incompletos ou incorretos.",
  },
  nl: {
    approach: "De aanpak beantwoordt het gestelde probleem", approachYes: "Het antwoord bevat de juiste aanpak.", approachNo: "De essentiële aanpak ontbreekt of leidt niet tot een conclusie.",
    answer: "Het antwoord is juist en volledig", answerYes: "Het resultaat en de motivering zijn volledig.", answerNo: "Het resultaat of de motivering is onvolledig of onjuist.",
  },
  ko: {
    approach: "풀이 과정이 문제에 답하고 있다", approachYes: "답안에 적절한 풀이 과정이 포함되어 있습니다.", approachNo: "핵심적인 풀이 과정이 없거나 결론에 이르지 못합니다.",
    answer: "답이 정확하고 완전하다", answerYes: "결과와 그 근거가 완전합니다.", answerNo: "결과 또는 그 근거가 불완전하거나 틀립니다.",
  },
  he: {
    approach: "דרך הפתרון עונה על השאלה", approachYes: "התשובה מכילה את דרך הפתרון הנכונה.", approachNo: "דרך הפתרון החיונית חסרה או שאינה מובילה למסקנה.",
    answer: "התשובה נכונה ומלאה", answerYes: "התוצאה וההנמקה שלה מלאות.", answerNo: "התוצאה או ההנמקה שלה חסרות או שגויות.",
  },
  ar: {
    approach: "تستجيب طريقة الحل للمشكلة المطروحة", approachYes: "تحتوي الإجابة على طريقة الحل المناسبة.", approachNo: "طريقة الحل الأساسية غائبة أو لا تؤدي إلى نتيجة.",
    answer: "الإجابة صحيحة وكاملة", answerYes: "النتيجة وتبريرها كاملان.", answerNo: "النتيجة أو تبريرها غير كامل أو غير صحيح.",
  },
};

function fallbackResult(result: LegacyCheckResult, language: string): CheckResult {
  const achieved = result.verdict === "correct" ? 2 : result.verdict === "partial" ? 1 : 0;
  const w = FALLBACK_WORDS[language as Language] ?? FALLBACK_WORDS.en;
  const criteria: CheckCriterion[] = [
    {
      label: w.approach,
      points: 1,
      achieved: achieved >= 1,
      essential: true,
      justification: achieved >= 1 ? w.approachYes : w.approachNo,
    },
    {
      label: w.answer,
      points: 1,
      achieved: achieved === 2,
      essential: false,
      justification: achieved === 2 ? w.answerYes : w.answerNo,
    },
  ];
  return { ...result, criteria, score: { earned: achieved, total: 2 } };
}

/** Contrat de sortie du correcteur (sortie structurée des fournisseurs API). */
const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
    feedback: { type: "string" },
    correct_solution: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          points: { type: "integer" },
          achieved: { type: "boolean" },
          essential: { type: "boolean" },
          justification: { type: "string" },
        },
        required: ["label", "points", "achieved", "essential", "justification"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "feedback", "correct_solution", "criteria"],
  additionalProperties: false,
} as const;

/**
 * Parse et valide la sortie du correcteur ; l'ancien contrat reçoit un barème de compatibilité,
 * dans la langue de l'examen (`language`, code ISO court).
 */
export function parseCheckResult(text: string, language = "fr"): CheckResult {
  return checkResultFrom(extractJson<unknown>(text), language);
}

function checkResultFrom(parsed: unknown, language: string): CheckResult {
  const fallback = (r: LegacyCheckResult) => fallbackResult(r, language);
  if (!isLegacyResult(parsed)) throw new Error("Réponse de correction invalide.");
  const candidate = parsed as LegacyCheckResult & { criteria?: unknown };
  if (!Array.isArray(candidate.criteria) || candidate.criteria.length < 2 || candidate.criteria.length > 5) return fallback(parsed);
  const criteria: CheckCriterion[] = [];
  for (const raw of candidate.criteria) {
    if (!raw || typeof raw !== "object") return fallback(parsed);
    const criterion = raw as Record<string, unknown>;
    if (typeof criterion.label !== "string" || !criterion.label.trim()
      || !Number.isInteger(criterion.points) || Number(criterion.points) <= 0
      || typeof criterion.achieved !== "boolean"
      || typeof criterion.essential !== "boolean"
      || typeof criterion.justification !== "string" || !criterion.justification.trim()) return fallback(parsed);
    criteria.push({
      label: criterion.label.trim(),
      points: Number(criterion.points),
      achieved: criterion.achieved,
      essential: criterion.essential,
      justification: criterion.justification.trim(),
    });
  }
  const total = criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  const earned = criteria.reduce((sum, criterion) => sum + (criterion.achieved ? criterion.points : 0), 0);
  const coherent = parsed.verdict === "correct"
    ? earned === total
    : parsed.verdict === "partial"
      ? earned > 0 && earned < total && criteria.filter((criterion) => criterion.essential).every((criterion) => criterion.achieved)
      : earned === 0 || criteria.some((criterion) => criterion.essential && !criterion.achieved);
  return coherent ? { ...parsed, criteria, score: { earned, total } } : fallback(parsed);
}

/**
 * Barème IMPOSÉ (réponse courte d'une question composée, lib/blocks) : les critères et leurs
 * points sont ceux de la génération, le correcteur ne décide que de leur atteinte. Le verdict
 * se déduit des points (tous : correct ; aucun : faux ; sinon partiel).
 */
function withRubric(parsed: unknown, rubric: { label: string; points: number }[]): CheckResult {
  const r = parsed as LegacyCheckResult & { criteria?: { achieved?: unknown; essential?: unknown; justification?: unknown }[] };
  const criteria: CheckCriterion[] = rubric.map((c, i) => {
    const got = r.criteria?.[i];
    return {
      label: c.label, points: c.points, achieved: got?.achieved === true, essential: got?.essential === true,
      justification: typeof got?.justification === "string" && got.justification.trim() ? got.justification.trim() : "—",
    };
  });
  const total = criteria.reduce((s, c) => s + c.points, 0);
  const earned = criteria.reduce((s, c) => s + (c.achieved ? c.points : 0), 0);
  return { verdict: earned === total ? "correct" : earned === 0 ? "wrong" : "partial", feedback: r.feedback, correct_solution: r.correct_solution, criteria, score: { earned, total } };
}

/**
 * Vérificateur perso : re-résout la question indépendamment puis compare à la réponse de l'étudiant.
 * Via le fournisseur LLM configuré. `imageRel` = chemin relatif au cwd d'une photo de la réponse.
 * `rubric` (+ `reference`, la réponse modèle) : barème imposé, corrigé critère par critère.
 */
/**
 * Taille de la réponse, réflexion comprise : sans elle, la correction prenait le défaut des aides
 * (6 000 tokens) à l'effort par défaut, et une trace d'algorithme corrigée sortait coupée ; la
 * relance renvoyait la même demande au même budget, trois fois (même défaut que le drill, #176).
 * Coupée : UNE relance qui demande moins (corrigé et explications abrégés, effort bas).
 * Opus 5.5 à l'effort haut depuis le 23/11 (étape 1, comme le drill) : au banc, la correction
 * à l'effort moyen coûtait 0,08 $ au plus ; le haut n'est pas encore mesuré, la borne de 12 000
 * tokens et le plafond de la réservation tiennent la dépense sous le prix de l'aide.
 */
const CHECK_LIMITS = { maxTokens: 12_000, effort: "high" } as const;
const CHECK_SHORT_LIMITS = { maxTokens: 8_000, effort: "low" } as const;
const CHECK_SHORT_RULE = `RÉPONSE PRÉCÉDENTE TROP LONGUE, coupée avant la fin : garde le même verdict et le même barème, mais feedback en 3 phrases au plus et correct_solution ABRÉGÉE (les étapes clés et le résultat, 200 mots au plus, une trace en un seul petit tableau).`;

export async function checkSolution(input: { statement: string; answer?: string; imageRel?: string | null; rubric?: { label: string; points: number }[]; reference?: string }): Promise<CheckResult> {
  const c = getCourse(currentCourse());
  // Langue de l'examen : celle de la correction quand la réponse ne permet pas d'en juger.
  const language = await courseLanguage();
  // Définitions DU COURS : la correction en dépend (une réponse conforme au cours est juste).
  const passages = await coursePassages([input.statement.slice(0, 300)], 3, 900).catch(() => []);
  const matiere = [c.examCode, c.examName].filter(Boolean).join(" ") + (c.university.trim() ? ` (${c.university.trim()})` : "");
  const lines = [
    `Tu es un correcteur rigoureux de ${matiere}.`,
    `VOICI LA QUESTION D'EXAMEN :`,
    input.statement,
    ``,
  ];
  if (input.imageRel) lines.push(`La réponse de l'étudiant est dans l'image située à ${input.imageRel} — lis-la avec l'outil Read (elle peut être manuscrite).`);
  if (input.answer) lines.push(`RÉPONSE DE L'ÉTUDIANT (texte) : « ${input.answer} »`);
  const rubric = input.rubric?.length ? input.rubric : null;
  lines.push(
    ``,
    `Procède ainsi :`,
    `1) Résous la question toi-même, de zéro, rigoureusement.`,
    rubric
      ? [
          `2) BARÈME IMPOSÉ — garde exactement ces critères, dans cet ordre, avec leurs points ; décide seulement s'ils sont atteints dans la réponse de l'étudiant (achieved), et pourquoi (justification, une phrase fondée sur sa réponse) :`,
          ...rubric.map((c, i) => `   ${i + 1}) ${c.label} (${c.points} pt${c.points > 1 ? "s" : ""})`),
          input.reference ? `   Réponse modèle de l'équipe enseignante (une autre formulation juste vaut autant) : « ${input.reference} »` : "",
        ].filter(Boolean).join("\n")
      : `2) À partir de TA résolution, construis un barème de 2 à 5 critères atomiques et observables. Chaque critère contient : label (action et résultat attendus précis), points (entier strictement positif), achieved (booléen), essential (booléen : son absence invalide l'essentiel de la réponse), justification (une phrase fondée sur la réponse de l'étudiant).`,
    `3) Compare ta solution à la réponse de l'étudiant. Verdict cohérent avec le barème :`,
    `   - "correct" : juste et complet.`,
    `   - "partial" : une partie des points est obtenue et tous les critères essentiels sont atteints.`,
    `   - "wrong" : aucun point ou au moins un critère essentiel manque.`,
    `4) feedback : explication CIBLÉE et actionnable de l'erreur (OÙ et POURQUOI ça coince, ce qu'il faut revoir). Pas de blabla.`,
    `5) correct_solution : la bonne solution, concise mais complète.`,
    FORMULA_RULE,
    `LANGUE : feedback, correct_solution et le texte des critères (label, justification) sont écrits dans la langue de la réponse de l'étudiant, sinon en ${languageName(language)[1]} (la langue de l'examen) si la réponse ne permet pas d'en juger (formules seules, image illisible).`,
    `Juge avec les DÉFINITIONS DU COURS${passages.length ? " (extraits ci-dessous)" : ""}, jamais avec celles d'une autre source : une réponse conforme au cours est juste, même si une autre source la formule autrement.`,
    ...(passages.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, passages)] : []),
    `Réponds UNIQUEMENT avec un objet JSON {"verdict","feedback","correct_solution","criteria":[{"label","points","achieved","essential","justification"}]}. Aucune prose autour, aucune balise markdown.`
  );
  const prompt = lines.join("\n");
  // Relecture courte (lib/assist-review) : la question est re-résolue EN PARALLÈLE de la correction,
  // sans la réponse de l'étudiant — le correcteur, qui la lit, s'y ancrait.
  const blindP = assistReviewEnabled() ? blindSolve(input.statement, { matiere, passages }) : Promise.resolve(null);
  const parsed = await completeJson<unknown>(
    { prompt, model: "opus", timeoutMs: 200_000, json: { schema: CHECK_SCHEMA }, ...CHECK_LIMITS },
    {
      onTruncated: (req) => ({ ...req, prompt: `${prompt}\n\n${CHECK_SHORT_RULE}`, ...CHECK_SHORT_LIMITS }),
      check: (v) => !isLegacyResult(v)
        ? "verdict (correct | partial | wrong), feedback et correct_solution sont requis"
        : rubric && (v as { criteria?: unknown[] }).criteria?.length !== rubric.length
          ? `« criteria » doit reprendre les ${rubric.length} critères du barème imposé, dans l'ordre`
          : null,
    },
  );
  const first = rubric ? withRubric(parsed, rubric) : checkResultFrom(parsed, language);
  const blind = await blindP;
  if (!blind) { if (assistReviewEnabled()) benchTrace("check.review", { outcome: "unreviewed", draft: first }); return first; }
  const slips = slipLines(first.correct_solution);
  const review = await completeJson<{ agree?: boolean; issue?: string } & Record<string, unknown>>(
    {
      prompt: [
        prompt,
        ``,
        `CONTRÔLE D'UNE PREMIÈRE CORRECTION. Un premier correcteur a rendu :`,
        JSON.stringify({ verdict: first.verdict, feedback: first.feedback, correct_solution: first.correct_solution, criteria: first.criteria }),
        ``,
        `RÉSOLUTION INDÉPENDANTE de la question (un autre assistant, sans voir la réponse de l'étudiant) :`,
        blind,
        ``,
        `CONTRÔLES AUTOMATIQUES de sa correct_solution :`,
        slips || "- aucune anomalie relevée",
        ``,
        `Compare la correct_solution du premier correcteur à la résolution indépendante. Quand elles diffèrent, REFAIS le calcul pour trancher, sans suivre l'une ou l'autre par défaut. Puis vérifie que son verdict et ses critères jugent la réponse de l'étudiant contre la BONNE solution.`,
        `- Tout est juste : réponds {"agree": true, "issue": ""}.`,
        `- Sinon : {"agree": false, "issue": "ce qui était faux", "verdict", "feedback", "correct_solution", "criteria"} — la correction COMPLÈTE refaite contre la bonne solution, mêmes règles que ci-dessus${rubric ? " (barème imposé inchangé)" : ""}.`,
      ].join("\n"),
      model: "opus", timeoutMs: 200_000, json: { schema: CHECK_REVIEW_SCHEMA }, ...CHECK_LIMITS,
    },
    { check: (v) => (typeof v?.agree !== "boolean" ? "agree (booléen) est requis" : v.agree || isLegacyResult(v) ? null : "agree=false exige verdict, feedback et correct_solution") },
  ).catch(() => null);
  const issue = typeof review?.issue === "string" ? review.issue : "";
  if (!review || review.agree !== false || !isLegacyResult(review)) {
    benchTrace("check.review", { outcome: review ? (review.agree ? "agree" : "fix-unusable") : "unreviewed", draft: first });
    return first;
  }
  const regraded = rubric ? withRubric(review, rubric) : checkResultFrom(review, language);
  benchTrace("check.review", { outcome: "fixed", issue, draft: first, final: regraded });
  return regraded;
}

/** Contrat de la relecture : l'accord seul, ou la correction refaite entière. */
const CHECK_REVIEW_SCHEMA = {
  type: "object",
  properties: { agree: { type: "boolean" }, issue: { type: "string" }, ...CHECK_SCHEMA.properties },
  required: ["agree", "issue"],
  additionalProperties: false,
} as const;
