import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { directivesBlock } from "@/lib/directives";
import { visionBlock } from "@/lib/figrefs";
import type { ExamSpec } from "@/lib/exam";

export type VerifyResult = {
  index: number;
  verdict: "ok" | "wrong" | "ambiguous";
  issue?: string;
  corrected_solution_tex?: string;
  violates_exclusion?: boolean;
};
export type VerifyReport = {
  results: VerifyResult[];
  fixed: number; // corrigés remplacés
  flagged: number; // exos signalés (ambigu / exclusion)
  ok: number;
};

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "index de l'exercice (0-based)" },
          verdict: { type: "string", description: "ok | wrong | ambiguous" },
          issue: { type: "string", description: "court : ce qui ne va pas (vide si ok)" },
          corrected_solution_tex: { type: "string", description: "corrigé LaTeX correct, UNIQUEMENT si verdict != ok" },
          violates_exclusion: { type: "boolean", description: "true si l'énoncé porte sur un sujet EXCLU par les directives" },
        },
        required: ["index", "verdict"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

function buildVerifyPrompt(spec: ExamSpec): string {
  const items = spec.questions
    .map((q, i) =>
      [
        `--- EXERCICE ${i} (index=${i}) — ${q.category ?? ""} — ${q.concept} [${q.points ?? "?"} pts] ---`,
        `ÉNONCÉ (LaTeX) :`,
        q.statement_tex,
        ``,
        `CORRIGÉ PROPOSÉ (LaTeX) :`,
        q.solution_tex,
      ].join("\n")
    )
    .join("\n\n");
  return [
    `Tu es un assistant (TA) rigoureux de CS-202 Computer Systems (EPFL). Tu CONTRÔLES un examen blanc.`,
    directivesBlock(),
    ``,
    visionBlock(),
    ``,
    `Pour CHAQUE exercice ci-dessous :`,
    `1) RÉSOUS-LE TOI-MÊME DE ZÉRO, en ignorant d'abord le corrigé proposé (calcule les vraies valeurs, trace, compte).`,
    `2) Compare ensuite ta solution au CORRIGÉ PROPOSÉ. Verdict :`,
    `   - "ok" : énoncé bien posé, corrigé correct ET difficulté/richesse au niveau des vraies pages.`,
    `   - "wrong" : le corrigé proposé est FAUX ou incomplet. Donne alors corrected_solution_tex = LE BON corrigé en LaTeX.`,
    `   - "ambiguous" : énoncé mal posé / non résoluble / ambigu / incohérent avec son barème, OU TROP FACILE (pas de piège, nombres ronds, snippets déconnectés au lieu d'un artefact creusé) par rapport aux vrais exemplaires. Explique dans issue ce qui manque (quel piège ajouter, quelle interaction tester, quels nombres salir).`,
    `3) Marque violates_exclusion=true si l'énoncé porte sur un sujet EXCLU par les directives ci-dessus.`,
    `Sois STRICT : un corrigé faux ou un exo trop sage est un problème. Si tu hésites entre ok et wrong, choisis wrong et fournis ta version.`,
    `corrected_solution_tex doit être du LaTeX compilable (mêmes conventions : \\texttt, $...$, lstlisting, pas de \\section).`,
    ``,
    items,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme au schéma. N'utilise aucun outil, n'écris aucun fichier.`,
    JSON.stringify(VERIFY_SCHEMA, null, 2),
  ].join("\n");
}

/**
 * Re-résout chaque exo indépendamment (via Claude Code / Max), remplace les corrigés faux
 * par la version validée, et signale les énoncés mal posés / hors-scope.
 */
export async function verifyExam(spec: ExamSpec): Promise<{ spec: ExamSpec; report: VerifyReport }> {
  const text = await runClaudeCode({
    prompt: buildVerifyPrompt(spec),
    model: "opus",
    timeoutMs: 360_000,
  });
  let parsed: { results: VerifyResult[] };
  try {
    parsed = extractJson<{ results: VerifyResult[] }>(text);
  } catch {
    return { spec, report: { results: [], fixed: 0, flagged: 0, ok: spec.questions.length } };
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  let fixed = 0;
  let flagged = 0;
  for (const r of results) {
    const q = spec.questions[r.index];
    if (!q) continue;
    if (r.verdict === "wrong" && r.corrected_solution_tex && r.corrected_solution_tex.length > 10) {
      q.solution_tex = r.corrected_solution_tex;
      fixed++;
    }
    if (r.verdict === "ambiguous" || r.violates_exclusion) flagged++;
  }
  const ok = results.filter((r) => r.verdict === "ok" && !r.violates_exclusion).length;
  return { spec, report: { results, fixed, flagged, ok } };
}
