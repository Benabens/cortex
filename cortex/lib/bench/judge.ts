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
 * Modèle : `opus` du provider par défaut (le banc exige claude-code). Le processus du juge
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
  return withKey ? `${head}\n   CORRIGÉ : ${sanitizeCorpus(it.solution ?? "").slice(0, 2500)}` : head;
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
        },
        required: ["q", "key", "explanation", "definition", "off_course", "distractors", "trivial", "chapter", "notion", "code"],
      },
    },
  },
  required: ["items"],
} as const;

async function adjudicate(batch: BenchItem[], passages: Passage[], solver: Map<number, number[]>, chapters: BenchRun["plan"]["chapters"]): Promise<RawVerdict[]> {
  const plan = chapters.map((c) => `${c.id} : ${sanitizeCorpus(c.title)}`).join("\n") || "(aucun plan)";
  const body = batch.map((it) => `${renderItem(it, true)}${solver.has(it.idx) ? `\n   SOLVEUR INDÉPENDANT : ${solver.get(it.idx)!.join(", ") || "aucune"}` : ""}`).join("\n\n");
  const out = await ask<{ items: RawVerdict[] }>({
    model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: ITEM_SCHEMA },
    prompt: [ITEM_RULES, DATA_RULE, dataBlock("EXTRAITS DU COURS", passages), "", "═══ PLAN DU COURS (id : titre) ═══", plan, "", "═══ QUESTIONS À JUGER ═══", body, "",
      `Réponds UNIQUEMENT avec l'objet JSON { "items": [ un objet par question, avec q, key, explanation, definition, off_course, distractors, trivial, chapter, notion, code ] }.`].join("\n"),
  }, { check: (v) => (Array.isArray(v?.items) && v.items.length >= batch.length ? null : `il faut un verdict pour chacune des ${batch.length} questions`) });
  return out.items;
}

async function runCode(c: NonNullable<RawVerdict["code"]>): Promise<ItemVerdict["code"]> {
  if (c.language !== "python" && c.language !== "c") return { ran: false, ok: true, detail: `langage ${c.language} non exécuté` };
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
  const out = await ask<{ intra: number[][]; previous: number[] }>({
    model: JUDGE_MODEL, timeoutMs: 600_000, json: { schema: DUP_SCHEMA },
    prompt: [DUPLICATE_RULES, `Le programme du cours compte ${notions} notions ; l'examen a ${items.length} questions.`, DATA_RULE, "", "═══ EXAMEN ═══", exam, "", "═══ QUESTIONS DES EXAMENS PRÉCÉDENTS ═══", prev, "",
      `Réponds UNIQUEMENT avec l'objet JSON { "intra": [[a, b], …] (paires de numéros Q, la seconde est le doublon), "previous": [numéros Q qui reprennent un examen précédent] }.`].join("\n"),
  });
  return {
    intra: (out.intra ?? []).filter((p) => Array.isArray(p) && p.length === 2 && p[0] !== p[1]).map(([a, b]) => [a, b] as [number, number]),
    previous: (out.previous ?? []).filter((n) => Number.isInteger(n)),
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
    for (const it of batch) passages.push(...(await passagesFor(`${it.stem} ${(it.options ?? []).join(" ")}`)));
    const solver = await solve(batch, passages);
    const raw = await adjudicate(batch, passages, solver, run.plan.chapters);
    for (const it of batch) {
      const v = raw.find((x) => x.q === it.idx);
      const code = v?.code?.source ? await runCode(v.code) : undefined;
      const distractors = it.options ? Math.max(0, it.options.length - (it.correct ?? []).length) : 0;
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
        trivialDistractors: Math.min(distractors, new Set((v?.trivial ?? []).filter((k) => !(it.correct ?? []).includes(k))).size),
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
