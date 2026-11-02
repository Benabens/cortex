import { currentCourse } from "@/db/client";
import { completeJson, extractJson } from "@/lib/llm";
import { getCourse } from "@/lib/courses";
import { coursePassages } from "@/lib/course-grounding";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";

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

function fallbackResult(result: LegacyCheckResult): CheckResult {
  const achieved = result.verdict === "correct" ? 2 : result.verdict === "partial" ? 1 : 0;
  const criteria: CheckCriterion[] = [
    {
      label: "La démarche répond au problème posé",
      points: 1,
      achieved: achieved >= 1,
      essential: true,
      justification: achieved >= 1 ? "La démarche utile est présente dans la réponse." : "La démarche essentielle manque ou ne permet pas de conclure.",
    },
    {
      label: "La réponse est juste et complète",
      points: 1,
      achieved: achieved === 2,
      essential: false,
      justification: achieved === 2 ? "Le résultat et sa justification sont complets." : "Le résultat ou sa justification reste incomplet ou incorrect.",
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

/** Parse et valide la sortie du correcteur ; l'ancien contrat reçoit un barème de compatibilité. */
export function parseCheckResult(text: string): CheckResult {
  return checkResultFrom(extractJson<unknown>(text));
}

function checkResultFrom(parsed: unknown): CheckResult {
  if (!isLegacyResult(parsed)) throw new Error("Réponse de correction invalide.");
  const candidate = parsed as LegacyCheckResult & { criteria?: unknown };
  if (!Array.isArray(candidate.criteria) || candidate.criteria.length < 2 || candidate.criteria.length > 5) return fallbackResult(parsed);
  const criteria: CheckCriterion[] = [];
  for (const raw of candidate.criteria) {
    if (!raw || typeof raw !== "object") return fallbackResult(parsed);
    const criterion = raw as Record<string, unknown>;
    if (typeof criterion.label !== "string" || !criterion.label.trim()
      || !Number.isInteger(criterion.points) || Number(criterion.points) <= 0
      || typeof criterion.achieved !== "boolean"
      || typeof criterion.essential !== "boolean"
      || typeof criterion.justification !== "string" || !criterion.justification.trim()) return fallbackResult(parsed);
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
  return coherent ? { ...parsed, criteria, score: { earned, total } } : fallbackResult(parsed);
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
export async function checkSolution(input: { statement: string; answer?: string; imageRel?: string | null; rubric?: { label: string; points: number }[]; reference?: string }): Promise<CheckResult> {
  const c = getCourse(currentCourse());
  // Définitions DU COURS : la correction en dépend (une réponse conforme au cours est juste).
  const passages = await coursePassages([input.statement.slice(0, 300)], 3, 900).catch(() => []);
  const lines = [
    `Tu es un correcteur rigoureux de ${c.examCode} ${c.examName} (${c.university}).`,
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
    `4) feedback : explication CIBLÉE et actionnable de l'erreur (OÙ et POURQUOI ça coince, ce qu'il faut revoir), en français. Pas de blabla.`,
    `5) correct_solution : la bonne solution, concise mais complète.`,
    `Juge avec les DÉFINITIONS DU COURS${passages.length ? " (extraits ci-dessous)" : ""}, jamais avec celles d'une autre source : une réponse conforme au cours est juste, même si une autre source la formule autrement.`,
    ...(passages.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, passages)] : []),
    `Réponds UNIQUEMENT avec un objet JSON {"verdict","feedback","correct_solution","criteria":[{"label","points","achieved","essential","justification"}]}. Aucune prose autour, aucune balise markdown.`
  );
  const parsed = await completeJson<unknown>(
    { prompt: lines.join("\n"), model: "opus", timeoutMs: 200_000, json: { schema: CHECK_SCHEMA } },
    {
      check: (v) => !isLegacyResult(v)
        ? "verdict (correct | partial | wrong), feedback et correct_solution sont requis"
        : rubric && (v as { criteria?: unknown[] }).criteria?.length !== rubric.length
          ? `« criteria » doit reprendre les ${rubric.length} critères du barème imposé, dans l'ordre`
          : null,
    },
  );
  return rubric ? withRubric(parsed, rubric) : checkResultFrom(parsed);
}
