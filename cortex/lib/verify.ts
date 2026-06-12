import { currentCourse } from "@/db/client";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { profile } from "@/lib/course-profile";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";

export type VerifyResult = {
  verdict: "ok" | "wrong" | "ambiguous";
  my_solution?: string;
  issue?: string;
  corrected_solution_tex?: string;
  violates_exclusion?: boolean;
  too_easy?: boolean;
};
export type ResultRow = { index: number; verdict: string; issue?: string; verified: 1 | 0 | null };
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

const ONE_SCHEMA = {
  type: "object",
  properties: {
    my_solution: { type: "string", description: "TA solution complète, résolue de zéro (avant de regarder le corrigé proposé)." },
    verdict: { type: "string", description: "ok | wrong | ambiguous" },
    issue: { type: "string", description: "Court : ce qui ne va pas / ce qui manque (piège, interaction, nombres). Vide si ok." },
    corrected_solution_tex: { type: "string", description: "Corrigé LaTeX correct, UNIQUEMENT si verdict=wrong." },
    violates_exclusion: { type: "boolean", description: "true si l'énoncé porte sur un sujet EXCLU." },
    too_easy: { type: "boolean", description: "true si, comparé à la vraie page de référence : pas de piège / nombres ronds / faible charge / pas de cas-limite / snippet déconnecté." },
  },
  required: ["my_solution", "verdict"],
  additionalProperties: false,
} as const;

/**
 * Surcharges optionnelles de la vérif (NS13) : les exos LABS (8%) ont leurs propres directives
 * (écrire/débugger du C AUTORISÉ) et leur propre étape 1 (moule Q6 2025 + fichiers du lab).
 * `opts` absent = comportement historique byte-identique.
 */
export type VerifyOpts = { directives?: string; step1?: string };

/** Contrôle UN exercice : résolution à l'aveugle (avec la vraie page de réf) PUIS verdict. */
async function verifyOne(q: ExamQuestion, opts?: VerifyOpts): Promise<VerifyResult | null> {
  const p = profile();
  const c = getCourse(currentCourse());
  const img = p.refImageFor(q.category, q.concept);
  const step1 = opts?.step1 ?? (img
    ? `ÉTAPE 1 — Ouvre la vraie page de référence du MÊME TYPE : ${img} (outil Read). Puis RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, compte). Écris ta solution complète dans "my_solution". Ne te laisse PAS influencer par le corrigé proposé (tu le verras à l'étape 2).`
    : `ÉTAPE 1 — RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement (calcule, trace, prouve). Écris ta solution complète dans "my_solution". Ne te laisse PAS influencer par le corrigé proposé (tu le verras à l'étape 2).`);
  const prompt = [
    `Tu es un assistant (TA) rigoureux de ${c.examCode} ${c.examName} (${c.university}). Tu contrôles UN SEUL exercice d'examen blanc.`,
    opts?.directives ?? p.directivesBlock(),
    ``,
    step1,
    ``,
    `ÉNONCÉ (LaTeX) :`,
    q.statement_tex,
    ``,
    `ÉTAPE 2 — Compare maintenant ta solution au CORRIGÉ PROPOSÉ ci-dessous, et donne un verdict honnête :`,
    `CORRIGÉ PROPOSÉ (LaTeX) :`,
    q.solution_tex,
    ``,
    `- "ok" : énoncé bien posé, corrigé proposé correct et complet, ET difficulté/richesse/piège au niveau de la vraie page de référence.`,
    `- "wrong" : corrigé proposé FAUX ou incomplet → fournis corrected_solution_tex (le BON corrigé en LaTeX).`,
    `- "ambiguous" : énoncé mal posé / non résoluble / ambigu / incohérent avec son barème.`,
    `too_easy=true si, COMPARÉ à la vraie page : pas de vrai piège, nombres ronds, faible charge de calcul/bookkeeping, pas de cas-limite/frontière, ou simple snippet déconnecté au lieu d'un artefact creusé. Dans issue, dis QUOI ajouter.`,
    `violates_exclusion=true si l'énoncé porte sur un sujet EXCLU par les directives.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. N'écris aucun fichier.`,
    JSON.stringify(ONE_SCHEMA, null, 2),
  ].join("\n");
  try {
    const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 340_000 });
    const r = extractJson<VerifyResult>(text);
    return r && r.verdict ? r : null;
  } catch {
    return null; // fallback honnête : non vérifié (jamais "ok" par défaut)
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
 * Vérifie CHAQUE exercice à l'aveugle (1 appel/exo, parallélisme borné), puis DURCIT :
 * un exo faux/ambigu/hors-scope/trop-facile est régénéré (via `regenerate`) + re-vérifié,
 * jusqu'à N=maxAttempts. S'il reste invalide → retiré. Fallback honnête : jamais de faux "ok".
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
  const processed = await mapPool(spec.questions, 3, async (q0) => {
    let q = q0;
    let attempts = 0;
    let res = await verifyOne(q, opts);
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
      res = await verifyOne(q, opts);
    }
    let verified: 1 | 0 | null;
    let dropped = false;
    let fixedSol = false;
    if (!res) verified = null;
    else if (res.verdict === "ok" && !res.violates_exclusion && !res.too_easy) verified = 1;
    else if (res.verdict === "wrong" && res.corrected_solution_tex && res.corrected_solution_tex.length > 10) {
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
  });

  const kept = processed.filter((p) => !p.dropped);
  const finalSpec: ExamSpec = { ...spec, questions: kept.map((p) => p.q) };
  const results: ResultRow[] = kept.map((p, i) => ({
    index: i,
    verdict: p.res?.verdict ?? "unverified",
    issue: p.res?.issue,
    verified: p.verified,
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
