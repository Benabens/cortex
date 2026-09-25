import { currentCourse } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { getCourse } from "@/lib/courses";
import { verifyDeterministic } from "@/lib/verify-deterministic";
import { examsDir } from "@/lib/paths";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";
import path from "node:path";

export type VerifyResult = {
  verdict: "ok" | "wrong" | "ambiguous";
  my_solution?: string;
  issue?: string;
  corrected_solution_tex?: string;
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
 * Surcharges optionnelles de la vérif : les exos LABS (8%) ont leurs propres directives
 * (écrire/débugger du C AUTORISÉ) et leur propre étape 1 (moule Q6 2025 + fichiers du lab).
 * `opts` absent = comportement historique byte-identique.
 */
export type VerifyOpts = { directives?: string; step1?: string };

/** Contrôle UN exercice : résolution à l'aveugle (avec la vraie page de réf) PUIS verdict.
 *  Une question à FIGURE est re-résolue DEPUIS la figure : le PNG rendu est
 *  ouvert (vision) par le vérifieur ; s'il ne suffit pas à répondre, le verdict le dit. */
async function verifyOne(q: ExamQuestion, opts?: VerifyOpts): Promise<VerifyResult | null> {
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
    `- "wrong" : corrigé proposé FAUX ou incomplet → fournis corrected_solution_tex (le BON corrigé en LaTeX).`,
    `- "ambiguous" : énoncé mal posé / non résoluble / ambigu / incohérent avec son barème.`,
    `too_easy=true si, COMPARÉ à la vraie page : pas de vrai piège, nombres ronds, faible charge de calcul/bookkeeping, pas de cas-limite/frontière, ou simple snippet déconnecté au lieu d'un artefact creusé. Dans issue, dis QUOI ajouter.`,
    `violates_exclusion=true si l'énoncé porte sur un sujet EXCLU par les directives.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. N'écris aucun fichier.`,
    JSON.stringify(ONE_SCHEMA, null, 2),
  ].join("\n");
  try {
    // 9 min : la re-résolution à l'aveugle d'un exo DENSE de l'architecte (6 sous-questions +
    // comparaison au corrigé) frôlait les 340 s → timeout → « non vérifié » systématique. Mesuré :
    // une re-résolution complète prend ~4–6 min ; on laisse de la marge.
    const text = await completeText({ prompt, model: "opus", timeoutMs: 540_000, ...(figPath ? { addDirs: [examsDir()] } : {}) });
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
