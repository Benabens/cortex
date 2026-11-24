/**
 * RELECTURE COURTE DES AIDES (drill, check_answer) — banc du 23/11/2026 : un drill sur treize sortait
 * avec un corrigé faux (Opus 5.5 à l'effort moyen), et ni le drill ni la correction n'avaient de
 * contrôle : le même appel inventait l'exercice et sa solution. La relecture tient en deux temps :
 *
 *  1. blindSolve : l'exercice est résolu de zéro par un appel qui ne voit ni le corrigé ni la
 *     réponse de l'étudiant ;
 *  2. la comparaison (propre à chaque aide) confronte les deux, avec les égalités recalculées
 *     (lib/verify-arith), et réécrit UNE fois en cas de désaccord.
 *
 * Fallback : une relecture qui n'aboutit pas laisse l'aide telle quelle (jamais de blocage), et la
 * réécriture n'est appliquée que si elle est complète.
 */
import { completeJson, completeText } from "@/lib/llm";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";
import { arithmeticSlips } from "@/lib/verify-arith";
import { benchTrace } from "@/lib/bench/trace";
import type { Drill } from "@/lib/drill";

/**
 * Taille des appels de relecture : une re-résolution d'exercice d'entraînement (petite instance) tient
 * en 8 000 tokens réflexion comprise ; la comparaison n'écrit beaucoup que lorsqu'elle réécrit.
 */
const SOLVE_LIMITS = { maxTokens: 8_000, effort: "medium" } as const;
const COMPARE_LIMITS = { maxTokens: 10_000, effort: "medium" } as const;

/** Relecture des aides active (défaut) ; CORTEX_ASSIST_REVIEW=0 la coupe (surcoût, panne du modèle). */
export function assistReviewEnabled(): boolean {
  return process.env.CORTEX_ASSIST_REVIEW !== "0";
}

/** Marque du prompt de re-résolution (les tests et le banc la reconnaissent). */
export const BLIND_SOLVE_MARK = "RÉSOLUTION INDÉPENDANTE d'un exercice d'entraînement";

/** Résout `statement` de zéro, sans corrigé ; null si l'appel n'aboutit pas. */
export async function blindSolve(statement: string, ctx: { matiere: string; passages?: { src: string; text: string }[] }): Promise<string | null> {
  const prompt = [
    `Tu es un assistant rigoureux de ${ctx.matiere}. ${BLIND_SOLVE_MARK} : tu n'as pas son corrigé, un autre assistant comparera ta solution au corrigé proposé.`,
    `Résous l'exercice ci-dessous de zéro (calcule, trace, justifie), en étapes courtes. Termine par « RÉPONSE FINALE : … » (chaque résultat demandé), puis « HYPOTHÈSES : … » (ce que l'énoncé ne donne pas et que tu as dû supposer, ou « aucune »).`,
    ...(ctx.passages?.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, ctx.passages)] : []),
    ``,
    `EXERCICE :`,
    statement,
    ``,
    `Aucun outil, aucun fichier.`,
  ].join("\n");
  try {
    const text = await completeText({ prompt, model: "opus", timeoutMs: 180_000, ...SOLVE_LIMITS });
    return text?.trim() || null;
  } catch {
    return null;
  }
}

/** Égalités fausses d'un corrigé, en lignes pour la comparaison. */
export function slipLines(text: string): string {
  return arithmeticSlips(text).slice(0, 8).map((x) => `- égalité fausse : « ${x.expr} = ${x.claimed} » (le recalcul donne ${x.actual})`).join("\n");
}

const DRILL_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["agree", "fix"] },
    issue: { type: "string" },
    statement_html: { type: "string", description: "Seulement si l'énoncé doit changer (hypothèse manquante) : l'énoncé COMPLET réécrit." },
    hints: { type: "array", items: { type: "string" }, description: "Seulement avec verdict=fix : les 5 indices réécrits, cohérents avec le corrigé juste." },
    solution_html: { type: "string", description: "Seulement avec verdict=fix : le corrigé COMPLET et juste." },
  },
  required: ["verdict", "issue"],
  additionalProperties: false,
} as const;

type DrillReview = { verdict: "agree" | "fix"; issue?: string; statement_html?: string; hints?: string[]; solution_html?: string };

/**
 * Relit un drill : re-résolution sans le corrigé, puis comparaison et, en cas de désaccord, UNE
 * réécriture (corrigé, indices, et l'énoncé s'il lui manque une hypothèse). Rend le drill livré.
 */
export async function reviewDrill(d: Drill, ctx: { matiere: string; rules: string; passages?: { src: string; text: string }[] }): Promise<Drill> {
  const blind = await blindSolve(d.statement_html, ctx);
  if (!blind) { benchTrace("drill.review", { outcome: "unreviewed", draft: d }); return d; }
  const slips = slipLines(d.solution_html);
  const prompt = [
    `Tu es un assistant rigoureux de ${ctx.matiere}. Tu contrôles un exercice d'entraînement avant qu'il parte à un étudiant.`,
    ...(ctx.passages?.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, ctx.passages)] : []),
    ``,
    `ÉNONCÉ (HTML) :`, d.statement_html, ``,
    `INDICES :`, ...d.hints.map((h, i) => `${i + 1}. ${h}`), ``,
    `CORRIGÉ PROPOSÉ (HTML) :`, d.solution_html, ``,
    `RÉSOLUTION INDÉPENDANTE (sans le corrigé) :`, blind, ``,
    `CONTRÔLES AUTOMATIQUES DU CORRIGÉ :`, slips || "- aucune anomalie relevée", ``,
    `Compare résultat par résultat. Quand le corrigé et la résolution indépendante diffèrent, REFAIS le calcul pour trancher, sans suivre l'un ou l'autre par défaut. Vérifie aussi que chaque conclusion découle des propres tableaux et calculs du corrigé, et qu'aucun indice n'oriente vers une réponse fausse.`,
    `- verdict "agree" : corrigé juste et complet, énoncé bien posé (une seule réponse défendable), indices cohérents. Rien d'autre à écrire.`,
    `- verdict "fix" : sinon. issue dit ce qui ne va pas ; solution_html est le corrigé COMPLET et juste ; hints les 5 indices cohérents avec lui ; statement_html, seulement si l'énoncé ne permet pas de conclure sans une hypothèse, l'énoncé complet qui l'écrit.`,
    ctx.rules,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun outil, aucun fichier.`,
    JSON.stringify(DRILL_REVIEW_SCHEMA, null, 2),
  ].join("\n");
  const r = await completeJson<DrillReview>(
    { prompt, model: "opus", timeoutMs: 180_000, json: { schema: DRILL_REVIEW_SCHEMA }, ...COMPARE_LIMITS },
    { check: (v) => (v?.verdict === "agree" || v?.verdict === "fix" ? null : "verdict (agree | fix) est requis") },
  ).catch(() => null);
  const hints = Array.isArray(r?.hints) ? r.hints.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim()) : [];
  const solution = typeof r?.solution_html === "string" ? r.solution_html.trim() : "";
  if (!r || r.verdict !== "fix" || solution.length < 40) {
    benchTrace("drill.review", { outcome: r ? (r.verdict === "agree" ? "agree" : "fix-unusable") : "unreviewed", issue: r?.issue ?? "", draft: d });
    return d;
  }
  const statement = typeof r.statement_html === "string" && r.statement_html.trim().length >= d.statement_html.length / 2 ? r.statement_html.trim() : d.statement_html;
  const fixed: Drill = { ...d, statement_html: statement, solution_html: solution, hints: hints.length >= 5 ? hints.slice(0, 5) : d.hints };
  benchTrace("drill.review", { outcome: "fixed", issue: r.issue ?? "", draft: d, final: fixed });
  return fixed;
}
