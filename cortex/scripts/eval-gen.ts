/**
 * BANC D'ÉVALUATION DE LA GÉNÉRATION (avant / après) — local, jamais sur la prod.
 *
 * Trois étapes, sur un dossier de données jetable (CORTEX_DATA_DIR) et SQLite :
 *
 *   # 1. un cours depuis un dossier de supports locaux (aucun contenu de cours dans git)
 *   CORTEX_DATA_DIR=/tmp/banc npx tsx scripts/eval-gen.ts setup --name "Enjeux mondiaux de la société numérique" \
 *        --code HUM-285 --language fr --from ~/cours/hum-285
 *   # 2. un job réel (le vrai worker, scripts/run-job.ts), puis l'export de l'examen produit
 *   CORTEX_DATA_DIR=/tmp/banc npx tsx scripts/eval-gen.ts run --course <id> --job prepare
 *   CORTEX_DATA_DIR=/tmp/banc npx tsx scripts/eval-gen.ts run --course <id> --job exam \
 *        --target '{"focus":"…"}' --out /tmp/hum-apres.json
 *   # 3. le juge à l'aveugle (chaque examen noté seul, puis une comparaison en ordre tiré au sort)
 *   CORTEX_DATA_DIR=/tmp/banc npx tsx scripts/eval-gen.ts judge --course <id> --truth "QCM ~20 questions…" \
 *        --exams /tmp/hum-avant.json,/tmp/hum-apres.json --out /tmp/hum-juge.json
 *
 * `setup` et `run` n'utilisent que des fonctions présentes avant ce banc (jobs, worker,
 * base) : le même fichier se dépose dans une copie de l'ancien code pour produire
 * l'« avant ». Le juge passe par lib/llm (fournisseur par défaut : CLI, sans clé API).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { enterCourse, runWithCourse } from "../db/client";
import { q } from "../db/q";
import { coursePaths, ensureCoursesLoaded, reloadCourses } from "../lib/courses";
import { createJobExclusive, getJob } from "../lib/jobs";
import { completeText, extractJson } from "../lib/llm";
import { DATA_RULE, dataBlock } from "../lib/prompt-safety";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ───────────────────────────── setup ─────────────────────────────

async function setup(): Promise<void> {
  const from = arg("from");
  const name = arg("name");
  if (!from || !name) throw new Error("setup --name <nom> --from <dossier> [--code X] [--language fr]");
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name, code: arg("code"), language: arg("language") ?? "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const dest = path.join(coursePaths(row.id).contentRoot, "lectures");
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(pdf|txt|md)$/i.test(e.name)) { fs.copyFileSync(abs, path.join(dest, e.name.replace(/[^a-zA-Z0-9._-]/g, "_"))); n++; }
    }
  };
  walk(from);
  console.log(JSON.stringify({ course: row.id, files: n, content: dest }));
}

// ───────────────────────────── run ─────────────────────────────

type Exported = {
  course: string;
  job: { id: number; type: string; status: string; error: string | null; log: string[] };
  exam: null | { id: number; kind: "qcm" | "exercises"; items: { stem: string; options?: string[]; correct?: number[]; explanation?: string; solution?: string }[] };
};

async function exportExam(examId: number): Promise<Exported["exam"]> {
  const e = await q.get<{ format_template: string | null }>(`SELECT format_template FROM exams WHERE id = ?`, examId);
  if (!e) return null;
  if (e.format_template === "qcm") {
    const rows = await q.all<{ stem: string; options_json: string; correct_json: string; explanation: string }>(`SELECT stem, options_json, correct_json, explanation FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
    const open = await q.all<{ statement_html: string; solution_html: string }>(`SELECT statement_html, solution_html FROM exam_questions WHERE exam_id = ? ORDER BY id`, examId).catch(() => []);
    return {
      id: examId, kind: "qcm",
      items: [
        ...rows.map((r) => ({ stem: r.stem, options: JSON.parse(r.options_json), correct: JSON.parse(r.correct_json), explanation: r.explanation })),
        ...open.map((o) => ({ stem: o.statement_html, solution: o.solution_html })),
      ],
    };
  }
  const rows = await q.all<{ statement_html: string; solution_html: string }>(`SELECT statement_html, solution_html FROM exam_questions WHERE exam_id = ? ORDER BY id`, examId);
  return { id: examId, kind: "exercises", items: rows.map((r) => ({ stem: r.statement_html, solution: r.solution_html })) };
}

async function run(): Promise<void> {
  const course = arg("course");
  const type = arg("job");
  if (!course || !type) throw new Error("run --course <id> --job <prepare|exam|qcm> [--target JSON] [--out fichier.json]");
  const target = arg("target");
  const id = await runWithCourse(course, async () => (await createJobExclusive(type as Parameters<typeof createJobExclusive>[0], target)).id);
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const child = spawn(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/run-job.ts", String(id), course], {
      cwd: process.cwd(), env: { ...process.env, CORTEX_COURSE: course }, stdio: "inherit",
    });
    child.on("close", () => resolve());
  });
  const out = await runWithCourse(course, async (): Promise<Exported> => {
    const job = await getJob(id);
    const log = (job?.log ?? []).map((l) => l.msg);
    const exam = job?.status === "done" && job.resultId && type !== "prepare" ? await exportExam(job.resultId) : null;
    return { course, job: { id, type, status: job?.status ?? "?", error: job?.error ?? null, log }, exam };
  });
  console.log(JSON.stringify({ job: out.job.id, status: out.job.status, error: out.job.error, items: out.exam?.items.length ?? 0, minutes: Math.round((Date.now() - t0) / 6000) / 10 }));
  const file = arg("out");
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2));
}

// ───────────────────────────── judge ─────────────────────────────

const CRITERIA = ["discrimination", "distractors", "single_answer", "fidelity", "language", "format"] as const;
type Scores = Record<(typeof CRITERIA)[number], number>;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: Object.fromEntries(CRITERIA.map((c) => [c, { type: "integer", description: "1 à 5" }])),
      required: [...CRITERIA],
      additionalProperties: false,
    },
    name_only_items: { type: "integer", description: "Nombre de questions qu'un étudiant ne connaissant que les NOMS des notions réussirait." },
    ambiguous_items: { type: "integer", description: "Nombre de questions à 0 ou plusieurs réponses défendables (pour un QCM à réponse unique)." },
    unfaithful_items: { type: "integer", description: "Nombre de questions qui contredisent les extraits du cours ou en sortent." },
    verdict: { type: "string", description: "Trois phrases : forces, défauts, utilité pour réviser ce vrai examen." },
  },
  required: ["scores", "name_only_items", "ambiguous_items", "unfaithful_items", "verdict"],
  additionalProperties: false,
} as const;

function render(exam: NonNullable<Exported["exam"]>): string {
  const L = "ABCDEFGH";
  return exam.items.map((it, i) => {
    const body = it.options
      ? `${it.stem}\n${it.options.map((o, k) => `   ${L[k]}) ${o}`).join("\n")}\n   [clé : ${(it.correct ?? []).map((k) => L[k]).join(", ")}]`
      : `${it.stem}\n   [corrigé : ${(it.solution ?? "").slice(0, 1200)}]`;
    return `Q${i + 1}. ${body}`;
  }).join("\n\n");
}

async function passagesFor(exam: NonNullable<Exported["exam"]>, cap = 14_000): Promise<{ src: string; text: string }[]> {
  const { search } = await import("../lib/search");
  const out: { src: string; text: string }[] = [];
  const seen = new Set<number>();
  let used = 0;
  for (const it of exam.items) {
    const groups = await search(it.stem.replace(/\\[a-z]+\{[^}]*\}/g, " ").slice(0, 300), 6, "or").catch(() => []);
    for (const h of groups.flatMap((g) => g.hits).slice(0, 2)) {
      if (seen.has(h.itemId) || used > cap) continue;
      seen.add(h.itemId);
      const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId);
      const text = (row?.text ?? "").replace(/\s+/g, " ").slice(0, 700);
      out.push({ src: h.sourceTitle, text });
      used += text.length;
    }
  }
  return out;
}

async function judgeOne(exam: NonNullable<Exported["exam"]>, truth: string): Promise<{ scores: Scores; name_only_items: number; ambiguous_items: number; unfaithful_items: number; verdict: string }> {
  const prompt = [
    `Tu es un examinateur exigeant. On te montre UN examen blanc généré automatiquement pour un cours. Tu ne sais pas comment il a été produit. Évalue-le pour un étudiant qui prépare le VRAI examen décrit ci-dessous.`,
    `LE VRAI EXAMEN DE CE COURS : ${truth}`,
    ``,
    DATA_RULE,
    dataBlock(`EXTRAITS DU COURS (pour juger la fidélité)`, await passagesFor(exam)),
    ``,
    `═══ L'EXAMEN BLANC À ÉVALUER (${exam.items.length} question(s)) ═══`,
    render(exam),
    ``,
    `═══ NOTE CHAQUE CRITÈRE DE 1 (très mauvais) À 5 (excellent) ═══`,
    `- discrimination : un étudiant qui ne connaît que les NOMS des notions (ni leurs conditions, ni les résultats des études) échoue-t-il ? 5 = seul un étudiant qui maîtrise le détail réussit ; 1 = tout se devine.`,
    `- distractors : les mauvaises réponses sont-elles plausibles et construites (résultat inversé, mauvaise condition, mauvaise attribution, sur-généralisation) ? Pour un examen sans options, juge la qualité des pièges et des sous-questions.`,
    `- single_answer : chaque question a-t-elle exactement une réponse défendable, cohérente avec la clé ou le corrigé ?`,
    `- fidelity : les questions s'appuient-elles sur des faits précis des extraits du cours, sans erreur ni hors-sujet ?`,
    `- language : la langue est-elle celle du vrai examen, sans mélange ?`,
    `- format : la forme correspond-elle au vrai examen (type de questions, nombre, indépendance des questions) ?`,
    `Compte aussi name_only_items, ambiguous_items, unfaithful_items. Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(JUDGE_SCHEMA, null, 2),
  ].join("\n");
  return extractJson(await completeText({ prompt, model: "opus", timeoutMs: 900_000 }));
}

async function judgePair(a: NonNullable<Exported["exam"]>, b: NonNullable<Exported["exam"]>, truth: string): Promise<{ preferred: "X" | "Y"; why: string }> {
  const schema = { type: "object", properties: { preferred: { type: "string", description: "X ou Y" }, why: { type: "string" } }, required: ["preferred", "why"], additionalProperties: false };
  const prompt = [
    `Deux examens blancs, X et Y, générés pour le même cours. LE VRAI EXAMEN : ${truth}`,
    `Lequel un étudiant devrait-il utiliser pour se préparer à ce vrai examen ? Juge sur le pouvoir discriminant, la plausibilité des mauvaises réponses, la fidélité au cours, la langue et la forme. L'ordre de présentation ne veut rien dire.`,
    ``,
    `═══ EXAMEN X ═══`, render(a), ``, `═══ EXAMEN Y ═══`, render(b), ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`, JSON.stringify(schema),
  ].join("\n");
  return extractJson(await completeText({ prompt, model: "opus", timeoutMs: 900_000 }));
}

async function judge(): Promise<void> {
  const course = arg("course");
  const files = (arg("exams") ?? "").split(",").filter(Boolean);
  const truth = arg("truth");
  if (!course || files.length < 1 || !truth) throw new Error("judge --course <id> --truth <vrai examen> --exams a.json,b.json [--out f.json]");
  enterCourse(course);
  const exams = files.map((f) => ({ file: path.basename(f), data: JSON.parse(fs.readFileSync(f, "utf8")) as Exported }));
  const results: Record<string, unknown> = {};
  for (const e of exams) {
    if (!e.data.exam) { results[e.file] = { error: e.data.job.error ?? "aucun examen produit" }; continue; }
    const r = await judgeOne(e.data.exam, truth);
    const mean = Math.round((CRITERIA.reduce((s, c) => s + (r.scores[c] ?? 0), 0) / CRITERIA.length) * 100) / 100;
    results[e.file] = { items: e.data.exam.items.length, kind: e.data.exam.kind, ...r, mean };
    console.log(JSON.stringify({ exam: e.file, ...(results[e.file] as object) }));
  }
  if (exams.length === 2 && exams.every((e) => e.data.exam)) {
    // Ordre tiré au sort (graine affichée) : le juge ne sait pas lequel est « avant ».
    const seed = crypto.randomInt(0, 2);
    const [x, y] = seed ? [exams[1], exams[0]] : [exams[0], exams[1]];
    const p = await judgePair(x.data.exam!, y.data.exam!, truth);
    results.pairwise = { X: x.file, Y: y.file, preferred: p.preferred === "X" ? x.file : y.file, why: p.why };
    console.log(JSON.stringify(results.pairwise));
  }
  const out = arg("out");
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
}

const cmd = process.argv[2];
ensureCoursesLoaded()
  .then(() => (cmd === "setup" ? setup() : cmd === "run" ? run() : cmd === "judge" ? judge() : Promise.reject(new Error("usage : setup | run | judge"))))
  .then(() => process.exit(0))
  .catch((e) => { console.error("Échec du banc :", (e as Error).message); process.exit(1); });
