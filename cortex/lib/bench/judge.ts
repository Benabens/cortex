import { q } from "@/db/q";
import { completeJson } from "@/lib/llm";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";
import { verifyCode } from "@/lib/sandbox-exec";
import { DUPLICATE_RULES, ITEM_RULES, REJECTION_RULES, RUBRIC_VERSION, SOLVER_RULES, rubricFingerprint } from "./rubric";
import type { BenchItem, BenchRun, ItemVerdict, Verdicts } from "./types";

/**
 * JUGE DU BANC — à l'aveugle (il ne sait ni quel code ni quel run a produit l'examen),
 * rubrique figée (lib/bench/rubric). Dans le contexte du cours (runWithCourse) : il lit les
 * extraits du cours par la recherche de l'app, comme le moteur.
 *
 *  1. un SOLVEUR répond à chaque QCM sans voir la clé ;
 *  2. un ARBITRE tranche chaque question (clé, explication, définition, hors cours,
 *     distracteurs, chapitre, notion), avec la réponse du solveur sous les yeux ;
 *  3. le CODE dont dépend une clé est exécuté (lib/sandbox-exec) : sa sortie fait foi ;
 *  4. doublons dans l'examen et vs examens précédents ; faux rejets « hors cours ».
 *
 * Modèle : `opus` du provider par défaut (le banc exige codex-cli). Le processus du juge
 * ne pose pas LLM_MODEL_OPUS : c'est bien Opus, pas le modèle du moteur.
 */

const BATCH = 5;

/**
 * Un appel du juge, réessayé une fois si le fournisseur dépasse son délai ou décroche (banc du
 * 04/11 : un délai dépassé sous la charge de quatre runs faisait perdre tout le jugement).
 */
async function ask<T>(...args: Parameters<typeof completeJson<T>>): Promise<T> {
  try {
    return await completeJson<T>(...args);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== undefined && !["TIMEOUT", "UNAVAILABLE", "UPSTREAM", "NETWORK", "OVERLOADED"].includes(code)) throw e;
    return completeJson<T>(...args);
  }
}
const JUDGE_MODEL = "opus";
const L = "ABCDEFGH";

export function majorityValue<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return values.reduce((best, value) => (counts.get(value)! > counts.get(best)! ? value : best), values[0]);
}

export function majorityOptions(votes: number[][]): number[] {
  const counts = new Map<number, number>();
  for (const vote of votes) for (const option of new Set(vote)) counts.set(option, (counts.get(option) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= 2).map(([option]) => option).sort((a, b) => a - b);
}

/** Signaux de forme vérifiables sans connaissance du cours ; volontairement conservateur. */
export function deterministicTrivialOptions(item: Pick<BenchItem, "options" | "correct">): number[] {
  const absolute = /\b(?:toujours|jamais|aucun(?:e)?|tous?|toutes?|impossible|nécessairement|exclusivement|always|never|none|all|impossible|necessarily|exclusively)\b/i;
  return (item.options ?? []).flatMap((option, idx) => (!(item.correct ?? []).includes(idx) && absolute.test(option) ? [idx] : []));
}

type Passage = { src: string; text: string };

async function passagesFor(text: string, max = 3): Promise<Passage[]> {
  const { search } = await import("@/lib/search");
  const groups = await search(text.replace(/\\[a-z]+\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ").slice(0, 300), 8, "or").catch(() => []);
  const out: Passage[] = [];
  for (const h of groups.flatMap((g) => g.hits).slice(0, max)) {
    const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId).catch(() => undefined);
    if (row?.text) out.push({ src: h.sourceTitle, text: row.text.replace(/\s+/g, " ").slice(0, 900) });
  }
  return out;
}

/** Extraits d'une question : ceux de son scénario, puis ceux de chaque sous-question (une question
 *  composée couvre plusieurs notions ; le seul scénario ne ramène pas celles des sous-questions),
 *  en fenêtres centrées sur leurs mots, comme les preuves du moteur : un support de cours fait
 *  plusieurs milliers de caractères et ses 900 premiers ne portent pas la notion cherchée. */
async function itemPassages(it: BenchItem): Promise<Passage[]> {
  const { evidencePassages } = await import("@/lib/course-grounding");
  const clean = (x: string) => x.replace(/\\[a-z]+\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ");
  const queries = [`${it.stem} ${(it.options ?? []).join(" ")}`, ...(it.parts ?? []).map((p) => `${p.prompt} ${(p.options ?? []).join(" ")}`)].map(clean);
  const found = await evidencePassages(queries, { perQuery: 1, cap: 1200, budget: 7200 }).catch(() => []);
  return found.map((p) => ({ src: p.src, text: p.text.replace(/\s+/g, " ") }));
}

function renderItem(it: BenchItem, withKey: boolean): string {
  const head = `Q${it.idx} [${it.kind}] ${sanitizeCorpus(it.stem)}`;
  if (it.options) {
    const opts = it.options.map((o, k) => `   (${k}) ${sanitizeCorpus(o)}`).join("\n");
    return withKey ? `${head}\n${opts}\n   CLÉ : ${(it.correct ?? []).join(", ")}\n   EXPLICATION : ${sanitizeCorpus(it.explanation ?? "")}` : `${head}\n${opts}`;
  }
  if (it.parts) {
    const parts = it.parts.map((p, k) => {
      const opts = p.options ? `\n${p.options.map((o, j) => `      (${j}) ${sanitizeCorpus(o)}`).join("\n")}` : "";
      const key = withKey ? `\n      CLÉ : ${p.options ? String(p.correct ?? "?") : sanitizeCorpus(p.answer ?? "")}${p.explanation ? ` — ${sanitizeCorpus(p.explanation)}` : ""}` : "";
      return `   ${L[k] ?? k}. ${sanitizeCorpus(p.prompt)}${p.code ? `\n${p.code}` : ""}${opts}${key}`;
    }).join("\n");
    return `${head}\n${parts}`;
  }
  // Corrigé entier jusqu'à 12 000 caractères : un exercice de CS-202 à six sous-questions en fait
  // 3 500 à 6 600 ; coupé à 2 500, l'arbitre jugeait « tronqué » un corrigé complet (banc du 15/11).
  return withKey ? `${head}\n   CORRIGÉ : ${sanitizeCorpus(it.solution ?? "").slice(0, 12_000)}` : head;
}

const SOLVER_SCHEMA = { type: "object", properties: { answers: { type: "array", items: { type: "object", properties: { q: { type: "integer" }, chosen: { type: "array", items: { type: "integer" } } }, required: ["q", "chosen"] } } }, required: ["answers"] } as const;

async function solve(batch: BenchItem[], passages: Passage[]): Promise<Map<number, number[]>> {
  const qcm = batch.filter((it) => it.options);
  if (!qcm.length) return new Map();
  const out = await ask<{ answers: { q: number; chosen: number[] }[] }>({
    model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: SOLVER_SCHEMA },
    prompt: [SOLVER_RULES, DATA_RULE, dataBlock("EXTRAITS DU COURS", passages), "", "═══ QUESTIONS ═══", qcm.map((it) => renderItem(it, false)).join("\n\n"), "", `Réponds UNIQUEMENT avec l'objet JSON { "answers": [ { "q": <numéro>, "chosen": [indices] } ] }.`].join("\n"),
  });
  return new Map((out.answers ?? []).map((a) => [a.q, a.chosen ?? []]));
}

type RawVerdict = {
  q: number; key: ItemVerdict["key"]; explanation: ItemVerdict["explanation"]; definition: ItemVerdict["definition"];
  off_course: boolean; distractors: number; trivial: number[]; chapter: number | null; notion: string;
  code: null | { language: string; source: string; stdin?: string; expected: string };
  evidence: NonNullable<ItemVerdict["evidence"]>;
};

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "integer" }, key: { type: "string", enum: ["right", "wrong", "unsure", "na"] }, explanation: { type: "string", enum: ["consistent", "inconsistent", "na"] },
          definition: { type: "string", enum: ["conform", "mismatch", "na"] }, off_course: { type: "boolean" }, distractors: { type: "integer" },
          trivial: { type: "array", items: { type: "integer" } }, chapter: { type: ["integer", "null"] }, notion: { type: "string" },
          code: { type: ["object", "null"], properties: { language: { type: "string" }, source: { type: "string" }, stdin: { type: "string" }, expected: { type: "string" } } },
          evidence: { type: "array", items: { type: "object", properties: { criterion: { type: "string" }, option: { type: ["integer", "null"] }, source: { type: "string" }, passage: { type: "string" } }, required: ["criterion", "option", "source", "passage"] } },
        },
        required: ["q", "key", "explanation", "definition", "off_course", "distractors", "trivial", "chapter", "notion", "code", "evidence"],
      },
    },
  },
  required: ["items"],
} as const;

/**
 * Un verdict par question du lot, et aucun autre. Banc rs-composite du 23/11 : deux arbitres sur
 * trois ont rendu un verdict par SOUS-question (q 0 à 24 pour cinq questions composées) ; la
 * sous-question (e) de Q1 portait le numéro de Q5, comptée « livrée hors cours » (offCourse.leaked).
 */
export function verdictsCoverBatch(items: unknown, ids: number[]): string | null {
  const qs = Array.isArray(items) ? items.map((x) => (x as { q?: unknown })?.q) : [];
  if (qs.length === ids.length && ids.every((id) => qs.includes(id)) && qs.every((q) => ids.includes(q as number))) return null;
  return `il faut un verdict pour chacune des ${ids.length} questions (q = ${ids.join(", ")}), un seul par question, jamais un par sous-question`;
}

async function adjudicate(batch: BenchItem[], passages: Passage[], solver: Map<number, number[]>, chapters: BenchRun["plan"]["chapters"]): Promise<RawVerdict[]> {
  const ids = batch.map((it) => it.idx);
  const plan = chapters.map((c) => `${c.id} : ${sanitizeCorpus(c.title)}`).join("\n") || "(aucun plan)";
  const body = batch.map((it) => `${renderItem(it, true)}${solver.has(it.idx) ? `\n   SOLVEUR INDÉPENDANT : ${solver.get(it.idx)!.join(", ") || "aucune"}` : ""}`).join("\n\n");
  const out = await ask<{ items: RawVerdict[] }>({
    model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: ITEM_SCHEMA },
    prompt: [ITEM_RULES, DATA_RULE, dataBlock("EXTRAITS DU COURS", passages), "", "═══ PLAN DU COURS (id : titre) ═══", plan, "", "═══ QUESTIONS À JUGER ═══", body, "",
      `Réponds UNIQUEMENT avec l'objet JSON { "items": [ un objet par question, avec q, key, explanation, definition, off_course, distractors, trivial, chapter, notion, code, evidence ] }.`,
      `Un objet par question Q, jamais par sous-question : q vaut le numéro de la question (${ids.join(", ")}), une question composée reçoit un seul verdict pour toutes ses sous-questions.`].join("\n"),
  }, { check: (v) => verdictsCoverBatch(v?.items, ids) });
  return out.items;
}

function votedVerdict(votes: RawVerdict[]): RawVerdict | undefined {
  if (!votes.length) return undefined;
  const key = majorityValue(votes.map((v) => v.key));
  const explanation = majorityValue(votes.map((v) => v.explanation));
  const definition = majorityValue(votes.map((v) => v.definition));
  const trivial = majorityOptions(votes.map((v) => v.trivial ?? []));
  const supporting = votes.find((v) => v.key === key && v.explanation === explanation) ?? votes[0];
  return {
    ...supporting, key, explanation, definition, trivial,
    off_course: majorityValue(votes.map((v) => v.off_course)),
    chapter: majorityValue(votes.map((v) => v.chapter)),
    notion: majorityValue(votes.map((v) => v.notion)),
    evidence: votes.flatMap((v) => v.evidence ?? []).filter((e, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(e)) === i),
  };
}

/**
 * Tirage pseudo-aléatoire sans graine fixée : une exécution montre UNE sortie, alors que la clé peut
 * énumérer toutes les sorties possibles (banc rs-mixte du 17/11, `random.randint(2, 4)`).
 */
function unseededRandom(c: NonNullable<RawVerdict["code"]>): boolean {
  const src = c.source;
  if (c.language === "python") return /^\s*(?:import\s+random\b|from\s+random\s+import\b)|\b(?:np|numpy)\.random\b/m.test(src) && !/\bseed\s*\(\s*\d|default_rng\s*\(\s*\d/.test(src);
  return /\brand\s*\(/.test(src) && !/\bsrand\s*\(\s*\d+\s*\)/.test(src);
}

async function runCode(c: NonNullable<RawVerdict["code"]>): Promise<ItemVerdict["code"]> {
  if (c.language !== "python" && c.language !== "c") return { ran: false, ok: true, detail: `langage ${c.language} non exécuté` };
  if (unseededRandom(c)) return { ran: false, ok: true, detail: "tirage aléatoire sans graine : une exécution ne tranche pas" };
  const r = await verifyCode(c.language, c.source, [{ stdin: c.stdin ?? "", expect: c.expected }]);
  // Seule une exécution qui ABOUTIT tranche : un programme qui plante ici (module absent, extrait
  // incomplet) ne prouve rien contre la clé.
  const ranToEnd = r.verified === true || /sortie « [\s\S]* » ≠ attendu/.test(r.detail);
  return { ran: ranToEnd, ok: r.verified === true || !ranToEnd, detail: r.detail.slice(0, 300) };
}

const DUP_SCHEMA = { type: "object", properties: { intra: { type: "array", items: { type: "array", items: { type: "integer" } } }, previous: { type: "array", items: { type: "integer" } } }, required: ["intra", "previous"] } as const;

async function duplicates(items: BenchItem[], verdicts: ItemVerdict[], previous: BenchRun["previous"]): Promise<{ intra: [number, number][]; previous: number[] }> {
  if (items.length < 2 && !previous.length) return { intra: [], previous: [] };
  const notions = Number((await q.get<{ n: number }>(`SELECT count(*) n FROM topics`).catch(() => undefined))?.n ?? 0);
  const byIdx = new Map(verdicts.map((v) => [v.idx, v.notion]));
  const exam = items.map((it) => `Q${it.idx} [notion : ${sanitizeCorpus(byIdx.get(it.idx) ?? "?")}] ${sanitizeCorpus(it.stem).slice(0, 400)}`).join("\n");
  const prev = previous.slice(-150).map((p, i) => `P${i}. ${sanitizeCorpus(p.stem).slice(0, 220)}`).join("\n") || "(aucun examen précédent)";
  const prompt = [DUPLICATE_RULES, `Le programme du cours compte ${notions} notions ; l'examen a ${items.length} questions.`, DATA_RULE, "", "═══ EXAMEN ═══", exam, "", "═══ QUESTIONS DES EXAMENS PRÉCÉDENTS ═══", prev, "",
    `Réponds UNIQUEMENT avec l'objet JSON { "intra": [[a, b], …] (paires de numéros Q, la seconde est le doublon), "previous": [numéros Q qui reprennent un examen précédent] }.`].join("\n");
  const rounds = await Promise.all([0, 1, 2].map(() => ask<{ intra: number[][]; previous: number[] }>({ model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: DUP_SCHEMA }, prompt })));
  const pairCounts = new Map<string, number>();
  const previousCounts = new Map<number, number>();
  for (const out of rounds) {
    for (const pair of out.intra ?? []) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1]) continue;
      const key = `${pair[0]}:${pair[1]}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    for (const n of new Set(out.previous ?? [])) if (Number.isInteger(n)) previousCounts.set(n, (previousCounts.get(n) ?? 0) + 1);
  }
  return {
    intra: [...pairCounts].filter(([, count]) => count >= 2).map(([pair]) => pair.split(":").map(Number) as [number, number]),
    previous: [...previousCounts].filter(([, count]) => count >= 2).map(([n]) => n),
  };
}

const REJ_SCHEMA = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { q: { type: "integer" }, in_course: { type: "boolean" } }, required: ["q", "in_course"] } } }, required: ["items"] } as const;

async function rejections(rejected: BenchRun["rejected"]): Promise<Verdicts["rejected"]> {
  const out: Verdicts["rejected"] = rejected.map((r, idx) => ({ idx, offCourseReject: /hors cours/i.test(r.reason), falseRejection: false }));
  const off = out.filter((r) => r.offCourseReject);
  for (let i = 0; i < off.length; i += BATCH) {
    const slice = off.slice(i, i + BATCH);
    const passages: Passage[] = [];
    for (const r of slice) passages.push(...(await passagesFor(`${rejected[r.idx].stem} ${(rejected[r.idx].options ?? []).join(" ")}`, 4)));
    const body = slice.map((r) => {
      const it = rejected[r.idx];
      return `Q${r.idx}. ${sanitizeCorpus(it.stem)}\n${(it.options ?? []).map((o, k) => `   (${k}) ${sanitizeCorpus(o)}`).join("\n")}\n   CLÉ : ${(it.correct ?? []).join(", ")}\n   RAISON DU REJET : ${sanitizeCorpus(it.reason)}`;
    }).join("\n\n");
    const res = await ask<{ items: { q: number; in_course: boolean }[] }>({
      model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: REJ_SCHEMA },
      prompt: [REJECTION_RULES, DATA_RULE, dataBlock("EXTRAITS DU COURS", passages), "", "═══ QUESTIONS ÉCARTÉES ═══", body, "", `Réponds UNIQUEMENT avec l'objet JSON { "items": [ { "q": <numéro>, "in_course": true|false } ] }.`].join("\n"),
    });
    for (const v of res.items ?? []) {
      const r = out.find((x) => x.idx === v.q);
      if (r) r.falseRejection = !!v.in_course;
    }
  }
  return out;
}

/**
 * Chapitre retenu pour une question : l'identifiant rendu par le juge s'il est au plan ; un rang
 * (seq) rendu à sa place est rattaché à son chapitre ; un plan d'un seul chapitre couvre tout.
 */
export function chapterOf(raw: number | string | null | undefined, chapters: BenchRun["plan"]["chapters"]): number | null {
  if (chapters.length === 1) return chapters[0].id;
  // Le juge rend parfois l'identifiant en chaîne (« "1000028" »).
  const n = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return null;
  return chapters.find((c) => c.id === n)?.id ?? chapters.find((c) => c.seq === n)?.id ?? null;
}

export async function judgeExam(run: BenchRun): Promise<Verdicts> {
  const items = run.exam?.items ?? [];
  const verdicts: ItemVerdict[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const passages: Passage[] = [];
    for (const it of batch) passages.push(...(await itemPassages(it)));
    const solver = await solve(batch, passages);
    const rounds = await Promise.all([0, 1, 2].map(() => adjudicate(batch, passages, solver, run.plan.chapters)));
    for (const it of batch) {
      const v = votedVerdict(rounds.map((raw) => raw.find((x) => x.q === it.idx)).filter((x): x is RawVerdict => !!x));
      const code = v?.code?.source ? await runCode(v.code) : undefined;
      const distractors = it.options ? Math.max(0, it.options.length - (it.correct ?? []).length) : 0;
      const deterministicTrivial = deterministicTrivialOptions(it);
      verdicts.push({
        idx: it.idx,
        chapter: chapterOf(v?.chapter, run.plan.chapters),
        notion: v?.notion ?? "",
        // Le code exécuté fait foi sur l'avis du modèle.
        key: code?.ran && !code.ok ? "wrong" : (v?.key ?? "unsure"),
        explanation: v?.explanation ?? "na",
        definition: v?.definition ?? "na",
        offCourse: !!v?.off_course,
        distractors,
        // Même règle que le correcteur du moteur (lib/qcm) : un indice d'option fausse, entier et dans les bornes.
        trivialDistractors: Math.min(distractors, deterministicTrivial.length),
        evidence: [...(v?.evidence ?? []), ...deterministicTrivial.map((option) => ({ criterion: "trivial", option, source: `Q${it.idx}`, passage: it.options?.[option] ?? "" }))],
        ...(code ? { code } : {}),
      });
    }
  }
  const dup = await duplicates(items, verdicts, run.previous);
  return {
    rubric: `${RUBRIC_VERSION}:${rubricFingerprint().slice(0, 12)}`, judgeModel: JUDGE_MODEL, items: verdicts,
    duplicatesIntra: dup.intra, duplicatesPrevious: dup.previous, rejected: await rejections(run.rejected),
  };
}
