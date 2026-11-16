/**
 * PREUVES DU COURS POUR LE CORRECTEUR QCM — banc HUM-285 du 02/11/2026 : 22 à 27 questions
 * justes rejetées « hors cours » par examen. Le correcteur ne voyait que deux extraits de 700
 * caractères par sujet, découpés autour du premier mot du sujet : « Svenson (1981) n'apparaît
 * dans aucun extrait », « la phrase s'arrête à “Thaler et Sunstei” ». Ici :
 *  - `verifierPassages` : les passages où se trouve le fait que teste chaque question (son
 *    `source_fact`), puis son énoncé et sa clé, puis son sujet, en fenêtres larges ;
 *  - `secondLookOffCourse` : avant de rejeter une question que le correcteur juge hors cours,
 *    les notions qu'il dit absentes sont cherchées dans TOUT le cours, et un second regard
 *    tranche sur ces passages. En cas d'échec, le rejet tient : jamais de hors-cours laissé
 *    passer faute d'avoir pu vérifier.
 * Le contrôle déterministe des notions de la clé (absentCourseTerms) reste en amont, inchangé.
 */
import { corpusWindows, evidencePassages } from "@/lib/course-grounding";
import { completeJson } from "@/lib/llm";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";

type Question = { topic?: string | null; stem: string; options: string[]; correct: number[]; sourceFact?: string | null };

/** Caractères d'extraits du correcteur : 6 000 par question, entre 24 000 (un lot de 4) et 60 000. */
const PASSAGES_PER_ITEM = 6_000;
const PASSAGES_MIN = 24_000;
const PASSAGES_MAX = 60_000;

/**
 * Extraits que voit le correcteur pour un lot : le fait de chaque question d'abord, ses mots
 * ensuite (énoncé et TOUTES les options : centrer sur la clé orienterait une résolution qui se
 * veut à l'aveugle), son sujet en dernier.
 */
export async function verifierPassages(items: Question[]): Promise<{ src: string; text: string }[]> {
  const facts = items.map((it) => it.sourceFact ?? "");
  const stems = items.map((it) => `${it.stem} ${it.options.join(" ")}`);
  const topics = [...new Set(items.map((it) => it.topic ?? "").filter(Boolean))];
  // Le budget suit la taille du paquet : une vérification groupée de 8 questions garde, par
  // question, les extraits d'un lot de 4 (moins d'extraits = plus de faux rejets « hors cours »).
  const budget = Math.min(PASSAGES_MAX, Math.max(PASSAGES_MIN, PASSAGES_PER_ITEM * items.length));
  return evidencePassages([...facts, ...stems, ...topics], { perQuery: 2, cap: 1800, budget });
}

/** Une question que le correcteur juge hors cours : `reason`, ce qu'il en dit ; `terms`, ce qu'il dit absent. */
export type OffCourseFlag = Question & { explanation?: string | null; reason: string; terms: string[] };

const SECOND_LOOK_SCHEMA = {
  type: "object",
  properties: {
    second_look: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          off_course: { type: "string", description: "La notion ou le fait absent du cours dont la bonne réponse ou l'explication DÉPEND, et ce que dit le cours. Vide si les passages permettent de résoudre la question, même avec un synonyme usuel." },
          scope: { type: "string", enum: ["question", "explication"], description: "« explication » si SEULE l'explication ajoute ce qui est hors cours (énoncé, bonne réponse et options fondés sur le cours) ; « question » sinon." },
        },
        required: ["index", "off_course", "scope"],
        additionalProperties: false,
      },
    },
  },
  required: ["second_look"],
  additionalProperties: false,
} as const;

/** Les notions entre guillemets d'un signalement, à défaut de termes donnés par le correcteur. */
function quoted(flag: string): string[] {
  return [...flag.matchAll(/[«“"]\s*([^»”"]{3,80}?)\s*[»”"]/g)].map((m) => m[1]);
}

/**
 * Second regard sur les questions jugées hors cours, avec les passages trouvés dans tout le
 * cours pour ce que le correcteur dit absent. Rend, par question (même ordre), la raison
 * confirmée (non vide = hors cours) ou "" (fondée sur le cours). Une question dont la notion
 * n'a AUCUN passage dans le cours reste hors cours sans appel au modèle ; si le second regard
 * échoue, toutes gardent le rejet du correcteur.
 */
export type SecondLookVerdict = {
  /** Raison confirmée (non vide = hors cours), ou "" (fondée sur le cours). */
  reason: string;
  /** Seule l'explication est hors cours : l'énoncé, la clé et les options sont fondés sur le cours. */
  explanationOnly: boolean;
  /** Les passages du cours vus pour cette question (pour réécrire son explication). */
  passages: { src: string; text: string }[];
};

export async function secondLookOffCourse(flags: OffCourseFlag[]): Promise<SecondLookVerdict[]> {
  // Les notions nommées par le correcteur, celles qu'il cite entre guillemets (une définition
  // contestée, PR #55), puis sa phrase elle-même : chaque signalement a ses propres passages.
  // Puis, hors de la recherche plein texte, les mêmes notions cherchées par leurs racines dans TOUT
  // le corpus (accents, pluriels, flexions), et la bonne réponse pour contexte : banc HUM-285 du
  // 13/11, 29 rejets « pas présenté dans ces passages » sur des faits que le cours détaille ailleurs.
  // Rien sur la NOTION signalée, ni par l'une ni par l'autre : le rejet tient sans appel.
  const overlaps = (a: string, b: string) => a.includes(b.slice(0, 200)) || b.includes(a.slice(0, 200));
  const merge = (a: { src: string; text: string }[], b: { src: string; text: string }[]) => [...a, ...b.filter((p) => !a.some((x) => overlaps(x.text, p.text)))];
  const evidence = await Promise.all(flags.map(async (f) => {
    const named = [...new Set([...f.terms, ...quoted(f.reason)])];
    const [fts, scan] = await Promise.all([
      evidencePassages([...new Set([...named, f.reason])], { perQuery: 3, cap: 2000, budget: 10_000 }).catch(() => []),
      corpusWindows(named, { perQuery: 2, cap: 1800, budget: 6_000 }).catch(() => []),
    ]);
    const notion = merge(fts, scan);
    if (!notion.length) return notion;
    const key = (f.correct ?? []).map((k) => f.options[k] ?? "").filter(Boolean);
    return merge(notion, await corpusWindows([...key, `${f.stem} ${key.join(" ")}`], { perQuery: 2, cap: 1800, budget: 4_000 }).catch(() => []));
  }));
  const verdicts: SecondLookVerdict[] = flags.map((f, i) => ({ reason: f.reason, explanationOnly: false, passages: evidence[i] }));
  const open = flags.map((f, i) => ({ f, i })).filter((x) => evidence[x.i].length);
  if (!open.length) return verdicts;
  const seen = new Set<string>();
  const passages = open.flatMap((x) => evidence[x.i]).filter((p) => !seen.has(p.text) && !!seen.add(p.text));
  const block = open.map(({ f }, i) => [
    `Q${i}. ${sanitizeCorpus(f.stem)}`,
    ...f.options.map((o, k) => `   (${k}) ${sanitizeCorpus(o)}`),
    `   [clé : ${(f.correct ?? []).join(", ")}]`,
    f.explanation ? `   [explication : ${sanitizeCorpus(f.explanation).slice(0, 600)}]` : "",
    `   [jugée hors cours : ${sanitizeCorpus(f.reason).slice(0, 300)}]`,
  ].filter(Boolean).join("\n")).join("\n\n");
  const prompt = [
    `Un premier correcteur, qui ne voyait que de courts extraits du cours, a jugé les questions ci-dessous hors cours. Voici des passages trouvés pour ces notions dans TOUT le cours (par leurs racines : accents, pluriels et flexions compris).`,
    `Pour chaque question, off_course : la notion ou le fait absent du cours dont la bonne réponse ou l'explication DÉPEND, ou que le cours définit autrement, avec ce que dit le cours. Laisse-le VIDE si les passages permettent de résoudre la question, même si elle emploie un synonyme usuel de la matière.`,
    `Juge sur le FOND, pas sur les mots : une notion que le cours présente sous un autre nom (synonyme, traduction, singulier ou pluriel), une reformulation fidèle, ou la conséquence directe d'une définition ou d'un exemple du cours n'est PAS hors cours, même si la phrase exacte n'y figure pas. Hors cours : un fait, un chiffre, un cadre ou une notion que le cours ne présente nulle part dans ces passages, ou une définition qu'il contredit.`,
    `Une option qui n'est qu'une affirmation fausse (résultat inversé, condition changée, chiffre ou auteur déplacé) n'est pas hors cours : c'est le rôle d'un distracteur.`,
    `scope : « explication » si SEULE l'explication ajoute ce qui est hors cours (l'énoncé, la bonne réponse et les options restent fondés sur les passages) : elle sera réécrite et la question gardée. « question » sinon.`,
    ``,
    DATA_RULE,
    dataBlock(`PASSAGES DU COURS`, passages),
    ``,
    `═══ QUESTIONS JUGÉES HORS COURS ═══`,
    block,
    ``,
    // Pas de schéma recopié ici : le format tient en une ligne (le fournisseur CLI ignore le schéma).
    `Réponds UNIQUEMENT avec l'objet JSON {"second_look": [{"index": i, "off_course": "…", "scope": "question" | "explication"}]}, une entrée par question.`,
  ].join("\n");
  try {
    const r = await completeJson<{ second_look: { index: number; off_course?: string; scope?: string }[] }>(
      { prompt, model: "opus", timeoutMs: 300_000, json: { schema: SECOND_LOOK_SCHEMA } },
      { check: (v) => (Array.isArray(v?.second_look) ? null : "le champ « second_look » (tableau) manque") },
    );
    const byIndex = new Map(r.second_look.filter((x) => Number.isInteger(x?.index)).map((x) => [x.index, x]));
    // Une question sans réponse du second regard garde le signalement du correcteur.
    open.forEach(({ i }, k) => {
      const v = byIndex.get(k);
      if (typeof v?.off_course !== "string") return;
      const reason = v.off_course.trim();
      verdicts[i] = { ...verdicts[i], reason, explanationOnly: !!reason && v.scope === "explication" };
    });
  } catch {
    // Second regard illisible ou en échec : le rejet du correcteur tient.
  }
  return verdicts;
}

const REWRITE_SCHEMA = {
  type: "object",
  properties: {
    explanations: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, explanation: { type: "string" } },
        required: ["index", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["explanations"],
  additionalProperties: false,
} as const;

/**
 * EXPLICATION HORS COURS RÉÉCRITE, QUESTION GARDÉE — banc HUM-285 du 13/11 : une partie des rejets
 * « hors cours » ne visaient que l'explication (« l'explication ajoute que SynthID est limité aux
 * modèles Google », « l'explication nomme le coût fixe moyen »), alors que l'énoncé, la clé et les
 * options venaient du cours ; la question entière était jetée et l'examen n'atteignait pas son
 * nombre. Ici l'explication est réécrite sur les SEULS passages du cours. Rend, par question, la
 * nouvelle explication ou null (échec : le rejet tient).
 */
export async function rewriteExplanations(items: { stem: string; options: string[]; correct: number[]; explanation?: string | null; reason: string; passages: { src: string; text: string }[] }[], language: string): Promise<(string | null)[]> {
  if (!items.length) return [];
  const seen = new Set<string>();
  const passages = items.flatMap((it) => it.passages).filter((p) => !seen.has(p.text) && !!seen.add(p.text));
  const block = rewriteBlock(items, 600, (it) => ["hors cours dans l'ancienne explication", it.reason]);
  const prompt = [
    `Les explications de ces QCM ajoutent des faits que le cours ne présente pas. Réécris l'explication de chacun, sans toucher à l'énoncé, à la bonne réponse ni aux options.`,
    `RÈGLES : l'explication dit pourquoi la bonne réponse est juste et pourquoi chaque autre option est fausse, avec les SEULS faits des passages du cours ci-dessous ; rien de ce qui est signalé hors cours, aucun chiffre, auteur, exemple ou cadre absent des passages. Désigne les options par leur CONTENU, jamais par leur lettre ni leur rang. Trois à cinq phrases, en ${language}.`,
    ``,
    DATA_RULE,
    dataBlock(`PASSAGES DU COURS`, passages),
    ``,
    `═══ QCM ═══`,
    block,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {"explanations": [{"index": i, "explanation": "…"}]}, une entrée par question.`,
  ].join("\n");
  return requestRewrites(prompt, items.length);
}

type RewriteQuestion = { stem: string; options: string[]; correct: number[]; explanation?: string | null };

/** Bloc QCM d'une réécriture d'explication : énoncé, options (bonne réponse marquée), ancienne explication, défaut relevé. */
function rewriteBlock<T extends RewriteQuestion>(questions: T[], oldMax: number, note: (it: T) => [label: string, text: string]): string {
  return questions.map((it, i) => {
    const [label, text] = note(it);
    return [
      `Q${i}. ${sanitizeCorpus(it.stem)}`,
      ...it.options.map((o, k) => `   (${k}) ${sanitizeCorpus(o)}${(it.correct ?? []).includes(k) ? "  (bonne réponse)" : ""}`),
      it.explanation ? `   [ancienne explication : ${sanitizeCorpus(it.explanation).slice(0, oldMax)}]` : "",
      `   [${label} : ${sanitizeCorpus(text).slice(0, 300)}]`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

/** Appel commun des réécritures : par question, la nouvelle explication, ou null (échec de l'appel ou entrée manquante). */
async function requestRewrites(prompt: string, n: number): Promise<(string | null)[]> {
  try {
    const r = await completeJson<{ explanations: { index: number; explanation?: string }[] }>(
      { prompt, model: "opus", timeoutMs: 300_000, json: { schema: REWRITE_SCHEMA } },
      { check: (v) => (Array.isArray(v?.explanations) ? null : "le champ « explanations » (tableau) manque") },
    );
    const byIndex = new Map(r.explanations.filter((x) => Number.isInteger(x?.index)).map((x) => [x.index, typeof x.explanation === "string" ? x.explanation.trim() : ""]));
    return Array.from({ length: n }, (_, i) => byIndex.get(i) || null);
  } catch {
    return Array.from({ length: n }, () => null);
  }
}

/**
 * EXPLICATION RÉÉCRITE SUR LES OPTIONS RÉELLES — job 23 (14/11/2026, examen QCM #9) : neuf
 * explications sur vingt réfutaient des distracteurs absents de la question (« les distracteurs
 * confondent ce mécanisme avec le biais de négativité… » alors qu'aucune option ne le nommait ;
 * cinq options réfutées pour trois proposées), restes d'une version antérieure des options. Le
 * contrôle déterministe (lib/qcm-checks) les repère ; ici chaque explication est réécrite sur les
 * options telles qu'elles sont, sans toucher à l'énoncé, à la clé ni aux options. Rend, par
 * question, la nouvelle explication ou null (échec : l'appelant se replie sur la justification
 * de la clé seule).
 */
export async function rewriteExplanationsOnOptions(questions: { stem: string; options: string[]; correct: number[]; explanation?: string | null; issue: string }[], language: string, passages: { src: string; text: string }[] = []): Promise<(string | null)[]> {
  if (!questions.length) return [];
  const block = rewriteBlock(questions, 800, (it) => ["défaut", it.issue]);
  const prompt = [
    `Les explications de ces QCM réfutent des options qui ne figurent pas dans la question (restes d'une version précédente des options). Réécris l'explication de chacun, sans toucher à l'énoncé, à la bonne réponse ni aux options.`,
    `RÈGLES : l'explication dit pourquoi la bonne réponse est juste, puis pourquoi CHACUNE des options fausses listées est fausse — exactement celles-là, une par une, et aucune autre notion ni affirmation. Reprends les faits de l'ancienne explication quand ils sont justes${passages.length ? " et ceux des passages du cours" : ""}, sans en ajouter. Désigne les options par leur CONTENU, jamais par leur lettre ni leur rang. Trois à cinq phrases, en ${language}.`,
    ...(passages.length ? [``, DATA_RULE, dataBlock(`PASSAGES DU COURS`, passages)] : []),
    ``,
    `═══ QCM ═══`,
    block,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {"explanations": [{"index": i, "explanation": "…"}]}, une entrée par question.`,
  ].join("\n");
  return requestRewrites(prompt, questions.length);
}

const JUSTIFICATIONS_SCHEMA = {
  type: "object",
  properties: {
    justifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          key: { type: "string" },
          distractors: {
            type: "array",
            items: {
              type: "object",
              properties: { option_index: { type: "integer" }, why_wrong: { type: "string" } },
              required: ["option_index", "why_wrong"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "key", "distractors"],
        additionalProperties: false,
      },
    },
  },
  required: ["justifications"],
  additionalProperties: false,
} as const;

/** Une question dont la justification structurée a des cases à écrire (`want`), avec celles déjà justes. */
export type JustificationTarget = {
  stem: string; options: string[]; correct: number[]; sourceFact?: string | null;
  key: string; wrong: string[]; want: { key: boolean; options: number[] }; reason?: string;
};
export type JustificationReply = { key?: string; distractors?: { option_index: number; why_wrong: string }[] } | null;

/**
 * CASES DE JUSTIFICATION ÉCRITES SEULES (lib/qcm-rationale) : une option remplacée sans raison
 * rendue, une raison effacée par le filet, ou une justification hors cours à refaire sur les
 * passages du cours. Un seul appel groupé, et seules les cases marquées « À JUSTIFIER » sont
 * demandées : les autres raisons et la question ne bougent pas. Rend, par question, la réponse
 * brute (fusionnée par l'appelant, case par case) ou null (échec : les cases restent vides).
 */
export async function writeJustifications(targets: JustificationTarget[], language: string, passages: { src: string; text: string }[] = []): Promise<JustificationReply[]> {
  if (!targets.length) return [];
  const block = targets.map((t, i) => [
    `Q${i}. ${sanitizeCorpus(t.stem)}`,
    ...t.options.map((o, k) => {
      const mark = t.correct.includes(k)
        ? `  (bonne réponse)${t.want.key ? "  ← À JUSTIFIER (key)" : t.key ? ` [justification : ${sanitizeCorpus(t.key).slice(0, 300)}]` : ""}`
        : t.want.options.includes(k) ? "  ← À JUSTIFIER (pourquoi elle est fausse)" : t.wrong[k] ? `  [fausse : ${sanitizeCorpus(t.wrong[k]).slice(0, 200)}]` : "";
      return `   (${k}) ${sanitizeCorpus(o)}${mark}`;
    }),
    t.sourceFact ? `   Fait du cours testé : ${sanitizeCorpus(t.sourceFact).slice(0, 400)}` : "",
    t.reason ? `   [défaut à corriger : ${sanitizeCorpus(t.reason).slice(0, 300)}]` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  const prompt = [
    `Pour chacun de ces QCM, écris UNIQUEMENT les justifications marquées « À JUSTIFIER », sans toucher à l'énoncé, à la bonne réponse ni aux options.`,
    `RÈGLES : "key" (seulement si la bonne réponse est marquée) dit pourquoi elle est juste, avec le fait du cours, sans parler des autres options ; sinon "key" vide. "distractors" : une entrée par option marquée, et elles seules — "option_index" son numéro, "why_wrong" pourquoi CETTE option est fausse selon le cours (le détail qu'elle contredit). Dans chaque raison, aucune autre option, aucune lettre, aucun numéro ni rang${passages.length ? ", et seulement les faits des passages du cours ci-dessous" : ""}. Une à deux phrases par raison, en ${language}.`,
    ...(passages.length ? [``, DATA_RULE, dataBlock(`PASSAGES DU COURS`, passages)] : []),
    ``,
    `═══ QCM ═══`,
    block,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {"justifications": [{"index": i, "key": "…", "distractors": [{"option_index": k, "why_wrong": "…"}]}]}, une entrée par question.`,
  ].join("\n");
  try {
    const r = await completeJson<{ justifications: { index: number; key?: string; distractors?: { option_index: number; why_wrong: string }[] }[] }>(
      { prompt, model: "opus", timeoutMs: 300_000, json: { schema: JUSTIFICATIONS_SCHEMA } },
      { check: (v) => (Array.isArray(v?.justifications) ? null : "le champ « justifications » (tableau) manque") },
    );
    const byIndex = new Map(r.justifications.filter((x) => Number.isInteger(x?.index)).map((x) => [x.index, x]));
    return targets.map((_, i) => byIndex.get(i) ?? null);
  } catch {
    return targets.map(() => null);
  }
}
