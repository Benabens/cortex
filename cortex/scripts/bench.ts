/**
 * BANC DU MOTEUR (lot Q) — un cas = un cours restauré + une demande ; un run = la génération
 * réelle (le vrai worker), ses relevés, le juge à l'aveugle, les métriques et les seuils.
 * Mode d'emploi : docs/bench.md.
 *
 *   CORTEX_BENCH_HOME=… CORTEX_BENCH_PG_URL=postgres://…@127.0.0.1:…/postgres \
 *     npm run bench -- run --case rs-qcm15 --provider codex-cli # run complet (bandes enregistrées)
 *   npm run bench -- run --case synth-3p --replay tests/fixtures/bench/synth-3p \
 *     --baseline tests/fixtures/bench/synth-3p/metrics.json --strict                 # CI : rejeu, sans modèle
 *   npm run bench -- mark-ref --run <dossier du run>   # ce run devient la référence de son cas
 *   npm run bench -- report [--out rapport.md]        # référence → actuel, tous les cas
 *   npm run bench -- list
 *
 * Jamais l'API payante ni la prod (lib/bench/guard) : provider codex-cli exigé, aucune clé
 * API chargée, base Postgres locale créée pour le run, données dans CORTEX_BENCH_HOME.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { allCases, findCase, type BenchCase } from "../lib/bench/cases";
import { assertBenchEnv } from "../lib/bench/guard";
import type { BenchRun, TapeCall, Verdicts } from "../lib/bench/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Pose ${name} (voir docs/bench.md).`);
  return v;
}

const PG_RESTORE = process.env.CORTEX_PG_RESTORE ?? (fs.existsSync("/opt/homebrew/opt/libpq/bin/pg_restore") ? "/opt/homebrew/opt/libpq/bin/pg_restore" : "pg_restore");
const PG_DUMP = process.env.CORTEX_PG_DUMP ?? "pg_dump";
const POLL_MS = 2000;
const JOB_TIMEOUT_MS = Number(process.env.CORTEX_BENCH_TIMEOUT_MIN ?? 90) * 60_000;
/** Parité prod : l'API résout « opus » vers Sonnet sans LLM_ALLOW_OPUS (lib/llm/config) ; le moteur du banc aussi. */
const ENGINE_MODEL = process.env.CORTEX_BENCH_ENGINE_MODEL ?? "sonnet";

function commitLabel(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { encoding: "utf8" }).trim() ? "-modifie" : "";
    return sha + dirty;
  } catch { return "inconnu"; }
}

function dbUrl(admin: string, db: string): string {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  return u.toString();
}

async function adminSql<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(need("CORTEX_BENCH_PG_URL"), { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

/** Environnement du run, posé AVANT tout import du moteur (les modules lisent l'env au chargement). */
function runEnv(dataDir: string, url: string): void {
  Object.assign(process.env, {
    CORTEX_DATA_DIR: dataDir, DB_DRIVER: "postgres", DATABASE_URL: url,
    BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "100000", DAILY_GEN_QUOTA: "unlimited", DAILY_ASSIST_QUOTA: "unlimited",
    RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited", MAX_COURSES_PER_USER: "unlimited", MAX_COURSES_CREATED_PER_HOUR: "unlimited",
    CORTEX_TRACK_USAGE: "1",
  });
  delete process.env.CORTEX_USER;
  delete process.env.CACHE_ENABLED;
}

// ───────────────────────────── cours ─────────────────────────────

const CATEGORY_DIR: Record<string, string> = { sample_questions: "exam-samples", exam_info: "exam-info", lecture: "lectures", notes: "notes" };

function copyTree(from: string, to: string, exclude: string[] = []): number {
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (exclude.includes(e.name) || e.name.startsWith(".")) continue;
    const src = path.join(from, e.name);
    // Un .txt à côté du .pdf de même nom en est l'extraction : le copier doublerait le corpus.
    if (/\.txt$/i.test(e.name) && fs.existsSync(src.replace(/\.txt$/i, ".pdf"))) continue;
    if (e.isDirectory()) n += copyTree(src, path.join(to, e.name), exclude);
    else { fs.copyFileSync(src, path.join(to, e.name)); n++; }
  }
  return n;
}

function dumpSchemaName(file: string): string {
  const list = execFileSync(PG_RESTORE, ["-l", file], { encoding: "utf8" });
  const m = /;\s*\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)/.exec(list);
  if (!m) throw new Error(`Aucun schéma dans le dump ${file}`);
  return m[1];
}

/** Restaure un dump de schéma de cours sous le schéma du cours du banc. */
async function restoreSchema(file: string, url: string, target: string, schema?: string): Promise<void> {
  const from = schema ?? dumpSchemaName(file);
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${target}" CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${from}" CASCADE`);
    // `pg_restore -n` restaure le contenu du schéma, pas le schéma lui-même.
    await sql.unsafe(`CREATE SCHEMA "${from}"`);
  } finally { await sql.end(); }
  const r = spawnSync(PG_RESTORE, ["--no-owner", "--no-privileges", "-n", from, "-d", url, file], { encoding: "utf8" });
  if (r.status !== 0 && !/errors ignored on restore: 0/.test(r.stderr)) {
    const errs = (r.stderr ?? "").split("\n").filter((l) => /error/i.test(l) && !/transaction_timeout|already exists/.test(l));
    if (errs.length) throw new Error(`pg_restore : ${errs.slice(0, 3).join(" | ")}`);
  }
  const sql2 = postgres(url, { max: 1, onnotice: () => {} });
  try { if (from !== target) await sql2.unsafe(`ALTER SCHEMA "${from}" RENAME TO "${target}"`); } finally { await sql2.end(); }
}

function snapshotKey(c: BenchCase): string {
  return crypto.createHash("sha256").update(JSON.stringify({ course: c.course, source: c.source })).digest("hex").slice(0, 12);
}

type Ctx = { c: BenchCase; runDir: string; url: string; courseId: string; replayDir?: string };

async function createCourse(c: BenchCase): Promise<string> {
  const { reloadCourses } = await import("../lib/courses");
  if (c.course.staticId) return c.course.staticId;
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: c.course.name, code: c.course.code, language: c.course.language, examFormat: c.course.examFormat }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

async function courseDirs(courseId: string): Promise<Record<string, string>> {
  const { coursePaths } = await import("../lib/courses");
  const p = coursePaths(courseId);
  return { content: p.contentRoot, refs: p.refsDir, uploads: p.uploadsDir };
}

/** Prépare le cours depuis ses supports (le vrai job prepare), puis en garde un instantané. */
async function prepareCourse(ctx: Ctx): Promise<void> {
  const { c, courseId } = ctx;
  const dirs = await courseDirs(courseId);
  const lectures = path.join(dirs.content, CATEGORY_DIR.lecture);
  if (c.source.kind === "synth") {
    const { synthCourse, writeCourseFiles } = await import("../lib/bench/synth");
    const course = synthCourse(c.source.spec);
    await writeCourseFiles(course, lectures, c.source.format);
    fs.writeFileSync(path.join(ctx.runDir, "synth-facts.json"), JSON.stringify(course.facts, null, 1));
  } else if (c.source.kind === "folder") {
    for (const d of c.source.dirs) copyTree(d.path, path.join(dirs.content, CATEGORY_DIR[d.category ?? "lecture"]), d.exclude);
  }
  process.env.LLM_TAPE = ctx.replayDir ? `replay:${path.join(ctx.replayDir, "prepare.tape.jsonl")}` : `record:${path.join(ctx.runDir, "prepare.tape.jsonl")}`;
  process.env.LLM_TAPE_LOG = path.join(ctx.runDir, "prepare.replay.jsonl");
  const { startPrepareJob } = await import("../lib/generation");
  const { runWithCourse } = await import("../db/client");
  const started = await runWithCourse(courseId, () => startPrepareJob());
  if (!started.ok) throw new Error(`Préparation refusée : ${started.error}`);
  const prep = await followJob(courseId, started.jobId, Date.now());
  fs.writeFileSync(path.join(ctx.runDir, "prepare.json"), JSON.stringify(prep, null, 1));
  if (prep.job?.status !== "done") throw new Error(`Préparation en échec : ${prep.job?.error ?? prep.job?.status}`);
}

async function snapshotSave(ctx: Ctx, dir: string): Promise<void> {
  const { tenantSchema } = await import("../db/context");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(PG_DUMP, ["-Fc", "-n", tenantSchema("owner", ctx.courseId), "-f", path.join(dir, "schema.dump"), ctx.url]);
  const dirs = await courseDirs(ctx.courseId);
  for (const [k, d] of Object.entries(dirs)) if (fs.existsSync(d)) copyTree(d, path.join(dir, "files", k));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ case: ctx.c.id, commit: commitLabel(), at: new Date().toISOString() }));
}

async function snapshotRestore(ctx: Ctx, dir: string): Promise<void> {
  const { tenantSchema } = await import("../db/context");
  await restoreSchema(path.join(dir, "schema.dump"), ctx.url, tenantSchema("owner", ctx.courseId));
  const dirs = await courseDirs(ctx.courseId);
  for (const [k, d] of Object.entries(dirs)) if (fs.existsSync(path.join(dir, "files", k))) copyTree(path.join(dir, "files", k), d);
}

async function setupCourse(ctx: Ctx): Promise<void> {
  const { c } = ctx;
  const { tenantSchema } = await import("../db/context");
  if (c.source.kind === "dump") {
    await restoreSchema(c.source.file, ctx.url, tenantSchema("owner", ctx.courseId), c.source.schema);
    if (c.source.refsDir) copyTree(c.source.refsDir, (await courseDirs(ctx.courseId)).refs);
    return;
  }
  // --prepare (ingestion ou préparation modifiée) : instantané à part, suffixé du commit ; celui de
  // la référence, restauré par les runs ordinaires, n'est jamais écrasé.
  const base = `${c.id}-${snapshotKey(c)}`;
  const snap = path.join(need("CORTEX_BENCH_HOME"), "snapshots", flag("prepare") ? `${base}-${commitLabel()}` : base);
  if (!ctx.replayDir && !flag("prepare") && fs.existsSync(path.join(snap, "schema.dump"))) {
    await snapshotRestore(ctx, snap);
    return;
  }
  await prepareCourse(ctx);
  if (!ctx.replayDir) await snapshotSave(ctx, snap);
}

// ───────────────────────────── job ─────────────────────────────

type Followed = Pick<BenchRun, "job" | "samples">;

/** Suit un job jusqu'à son terme : relevés d'avancement et de temps restant, journal complet (le job n'en garde que 60 lignes). */
async function followJob(courseId: string, jobId: number, t0: number): Promise<Followed> {
  const { runWithCourse } = await import("../db/client");
  const { getJob, jobEta, cancelJob } = await import("../lib/jobs");
  const samples: BenchRun["samples"] = [];
  const log = new Map<string, { t: string; msg: string }>();
  for (;;) {
    const snap = await runWithCourse(courseId, async () => {
      const job = await getJob(jobId);
      return job ? { job, eta: await jobEta(job).catch(() => null) } : null;
    });
    if (!snap) throw new Error(`Job ${jobId} introuvable`);
    const { job, eta } = snap;
    for (const l of job.log ?? []) log.set(`${l.t}|${l.msg}`, { t: l.t, msg: l.msg });
    samples.push({ t: Date.now() - t0, progress: job.progress, status: job.status, etaMs: eta?.remainingMs ?? null, late: !!eta?.late, step: (job.currentStep ?? "").slice(0, 160) });
    if (["done", "error", "canceled"].includes(job.status)) {
      const row = await runWithCourse(courseId, async () => {
        const { q } = await import("../db/q");
        return q.get<{ created_at: string; updated_at: string; result_id: number | null; credit_ref: string | null }>(`SELECT created_at, updated_at, result_id, credit_ref FROM jobs WHERE id = ?`, jobId);
      });
      return {
        job: { id: jobId, status: job.status, error: job.error ?? null, log: [...log.values()].sort((a, b) => a.t.localeCompare(b.t)), createdAt: row?.created_at ?? "", updatedAt: row?.updated_at ?? "", resultId: row?.result_id ?? job.resultId ?? null, creditRef: row?.credit_ref ?? null } as BenchRun["job"] & { creditRef: string | null },
        samples,
      };
    }
    if (Date.now() - t0 > JOB_TIMEOUT_MS) await runWithCourse(courseId, () => cancelJob(jobId));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function readJsonl<T>(file: string): T[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

async function rates(): Promise<BenchRun["rates"]> {
  const { rateFor } = await import("../lib/billing/usage");
  const { mapModel } = await import("../lib/llm/config");
  // Ce que l'API de prod facturerait pour chaque modèle logique (opus → Sonnet sans LLM_ALLOW_OPUS).
  const saved = process.env.LLM_MODEL_OPUS;
  delete process.env.LLM_MODEL_OPUS;
  try {
    return Object.fromEntries(["opus", "sonnet", "haiku"].map((m) => [m, rateFor(mapModel(m, "anthropic"))]));
  } finally { if (saved !== undefined) process.env.LLM_MODEL_OPUS = saved; }
}

/** Demande du cas, avec le focus résolu sur le plan du cours (focusChapter = rang du chapitre). */
function resolveTarget(c: BenchCase, plan: BenchRun["plan"]): Record<string, unknown> | undefined {
  if (!c.request.target) return undefined;
  const t = { ...c.request.target };
  if (typeof t.focusChapter === "number") {
    const ch = [...plan.chapters].sort((a, b) => a.seq - b.seq)[t.focusChapter - 1];
    if (ch) t.focus = ch.title;
    delete t.focusChapter;
  }
  return t;
}

// ───────────────────────────── run ─────────────────────────────

/** Base créée par ce run : supprimée en fin de run, ou si le run échoue (sauf --keep). */
let createdDb: string | null = null;

async function dropCreatedDb(): Promise<void> {
  if (!createdDb || flag("keep")) return;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres().catch(() => {});
  const db = createdDb;
  await adminSql((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`));
  createdDb = null;
}

async function runCase(c: BenchCase): Promise<string> {
  const home = need("CORTEX_BENCH_HOME");
  const replayDir = arg("replay") ? path.resolve(arg("replay")!) : undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const commit = commitLabel();
  const runDir = path.join(home, "runs", c.id, `${stamp}-${commit}`);
  fs.mkdirSync(runDir, { recursive: true });
  const db = `bench_${c.id.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`.toLowerCase();
  // UTF8 comme la prod, quel que soit le cluster local (initdb en locale C = SQL_ASCII : `substr`
  // y coupe en octets et le pilote rejette la ligne — banc HUM-285 du 13/11).
  await adminSql((sql) => sql.unsafe(`CREATE DATABASE "${db}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`));
  createdDb = db;
  const url = dbUrl(need("CORTEX_BENCH_PG_URL"), db);
  runEnv(path.join(runDir, "data"), url);
  // Rejeu (CI) : un appel à la fois, pour que l'ordre des appels — donc les prompts qui dépendent
  // des réponses précédentes — ne dépende ni du parallélisme ni de l'ordre de retour de la base.
  if (replayDir) Object.assign(process.env, { LLM_MAX_CONCURRENCY: "1", QCM_BATCH_CONCURRENCY: "1" });
  assertBenchEnv(process.env);
  // Le worker (enfant de ce processus) prend le modèle de prod ; le juge, lui, tourne à part (Opus).
  process.env.LLM_MODEL_OPUS = ENGINE_MODEL;
  process.env.CORTEX_BENCH_TRACE = path.join(runDir, "trace.jsonl");
  console.log(`▶ ${c.id} — ${c.title} → ${runDir}`);

  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const courseId = await createCourse(c);
  const ctx: Ctx = { c, runDir, url, courseId, replayDir };
  // Une préparation en échec (synth-scan : aucun texte lisible) est un résultat du cas : le run est
  // noté (livraison 0), pas abandonné.
  let prepareError: string | undefined;
  try {
    await setupCourse(ctx);
  } catch (e) {
    prepareError = (e as Error).message;
    console.error(`  préparation en échec : ${prepareError}`);
  }

  const { runWithCourse } = await import("../db/client");
  const { readPlan, readPrevious, readExam, readUsage, readBilling } = await import("../lib/bench/export");
  let plan = await runWithCourse(courseId, () => readPlan());
  if (c.source.kind === "synth") {
    // Cours synthétique : la couverture se mesure sur sa VRAIE table des matières, pas sur le plan
    // que le moteur en a tiré (un polycopié d'un seul fichier n'en donne aucun).
    const { synthCourse } = await import("../lib/bench/synth");
    plan = { basis: "synth", chapters: synthCourse(c.source.spec).chapters.map((ch) => ({ id: ch.seq, seq: ch.seq, title: ch.title })), topicChapter: {} };
  }
  const previous = await runWithCourse(courseId, () => readPrevious());
  const target = resolveTarget(c, plan);

  process.env.LLM_TAPE = replayDir ? `replay:${path.join(replayDir, "run.tape.jsonl")}` : `record:${path.join(runDir, "run.tape.jsonl")}`;
  process.env.LLM_TAPE_LOG = path.join(runDir, "run.replay.jsonl");
  const startedAt = new Date();
  const { startGenerationJob } = await import("../lib/generation");
  let followed: Followed & { job: (BenchRun["job"] & { creditRef?: string | null }) | null } = { job: null, samples: [] };
  let refusal: string | undefined = prepareError ? `préparation : ${prepareError}` : undefined;
  if (!prepareError) {
    const started = await runWithCourse(courseId, () => startGenerationJob(c.request.job, target ? JSON.stringify(target) : undefined));
    if (started.ok) followed = await followJob(courseId, started.jobId, startedAt.getTime());
    else refusal = `${started.status} ${started.error}`;
  }

  const exported = followed.job?.resultId ? await runWithCourse(courseId, () => readExam(followed.job!.resultId!)) : null;
  const run: BenchRun & { courseId: string; engineModel: string; db: string; replay: boolean } = {
    caseId: c.id, courseId, commit, provider: process.env.LLM_PROVIDER ?? "?", engineModel: ENGINE_MODEL, db, replay: !!replayDir,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    request: { job: c.request.job, target: target ?? {}, requested: c.request.requested, expectRefusal: c.request.expectRefusal },
    refusal,
    job: followed.job ? { id: followed.job.id, status: followed.job.status, error: followed.job.error, log: followed.job.log, createdAt: followed.job.createdAt, updatedAt: followed.job.updatedAt, resultId: followed.job.resultId } : null,
    samples: followed.samples,
    exam: exported?.exam ?? null,
    render: exported?.render ?? { statement: null, corrige: null, web: { ok: false, items: 0 } },
    plan, previous,
    usage: followed.job ? await readUsage(followed.job.id, courseId) : [],
    calls: readJsonl<Omit<TapeCall, "error"> & { error?: { code?: string; message: string } }>(path.join(runDir, "run.tape.jsonl"))
      .map((c) => ({ site: c.site, model: c.model, promptChars: c.promptChars, systemChars: c.systemChars, outputChars: c.outputChars, ms: c.ms, systemHash: c.systemHash, jsonRetry: c.jsonRetry, at: c.at, error: c.error ? `${c.error.code ?? "?"} : ${c.error.message.slice(0, 160)}` : undefined })),
    rates: await rates(),
    billing: await readBilling(followed.job?.creditRef ?? null),
    rejected: readJsonl<{ event: string; stem: string; options?: string[]; correct?: number[]; reason: string }>(path.join(runDir, "trace.jsonl"))
      .filter((e) => e.event === "qcm.rejected").map(({ stem, options, correct, reason }) => ({ stem, options, correct, reason })),
  };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 1));
  console.log(`  job ${run.job?.status ?? "refusé"} — ${run.exam?.items.length ?? 0}/${c.request.requested} question(s) en ${Math.round((Date.now() - startedAt.getTime()) / 6000) / 10} min`);
  return runDir;
}

// ───────────────────────────── juge, métriques, rapport ─────────────────────────────

/** Le juge tourne dans un processus à part : son modèle (Opus) n'hérite pas du modèle du moteur. */
function spawnJudge(runDir: string): Promise<void> {
  const replay = arg("replay");
  const env: NodeJS.ProcessEnv = { ...process.env, LLM_TAPE: replay ? `replay:${path.join(path.resolve(replay), "judge.tape.jsonl")}` : `record:${path.join(runDir, "judge.tape.jsonl")}`, LLM_TAPE_LOG: path.join(runDir, "judge.replay.jsonl") };
  delete env.LLM_MODEL_OPUS;
  delete env.CORTEX_BENCH_TRACE;
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/bench.ts", "judge", "--run", runDir], { cwd: process.cwd(), env, stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`juge : code ${code}`))));
  });
}

async function judgeRun(runDir: string): Promise<void> {
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as BenchRun & { courseId: string };
  assertBenchEnv(process.env);
  // Le juge n'a pas de job, donc pas de réservation (230f686, 13/11 : « Il te faut des crédits ») :
  // il juge comme le propriétaire du cours du banc (« owner », lib/bench), sur l'abonnement Codex.
  process.env.CORTEX_OWNER_USER_ID ||= "owner";
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const verdicts = await runWithCourse(run.courseId, () => judgeExam(run));
  fs.writeFileSync(path.join(runDir, "verdicts.json"), JSON.stringify(verdicts, null, 1));
}

async function scoreRun(runDir: string, c: BenchCase): Promise<void> {
  const { measureRun } = await import("../lib/bench/metrics");
  const { checkThresholds } = await import("../lib/bench/thresholds");
  const { calibrationSample } = await import("../lib/bench/report");
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as BenchRun;
  const vfile = path.join(runDir, "verdicts.json");
  const verdicts = fs.existsSync(vfile) ? (JSON.parse(fs.readFileSync(vfile, "utf8")) as Verdicts) : undefined;
  const metrics = measureRun(run, verdicts);
  const ref = arg("ref") ? (JSON.parse(fs.readFileSync(path.join(path.resolve(arg("ref")!), "metrics.json"), "utf8")) as { metrics: typeof metrics }).metrics : undefined;
  const replay = !!(run as BenchRun & { replay?: boolean }).replay;
  const verdictsOut = checkThresholds(metrics, { maxMinutes: c.maxMinutes, expectRefusal: c.request.expectRefusal, focus: !!run.request.target.focus, replay }, ref);
  fs.writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify({ case: c.id, commit: run.commit, provider: run.provider, metrics, thresholds: verdictsOut }, null, 1));
  if (verdicts && run.exam) {
    const cal = calibrationSample(run, verdicts);
    fs.writeFileSync(path.join(runDir, "calibration.md"), cal.markdown);
    fs.writeFileSync(path.join(runDir, "calibration-juge.json"), JSON.stringify(cal.judged, null, 1));
  }
  const red = verdictsOut.filter((v) => v.pass === false);
  for (const v of verdictsOut) console.log(`  ${v.pass === null ? "·" : v.pass ? "✓" : "✗"} ${v.label} : ${v.value} (seuil ${v.limit})`);
  console.log(red.length ? `  ROUGE (${red.length}) : ${red.map((v) => v.id).join(", ")}` : "  VERT");
  // --strict (CI) : échoue sur un seuil rouge ; avec --baseline <metrics.json>, seulement sur une
  // RÉGRESSION face à la référence enregistrée (réponses du modèle figées : seul le code a changé).
  const baseline = arg("baseline");
  const blocking = baseline
    ? (await import("../lib/bench/thresholds")).regressions((JSON.parse(fs.readFileSync(path.resolve(baseline), "utf8")) as { thresholds: typeof verdictsOut }).thresholds, verdictsOut)
    : red;
  if (baseline) console.log(blocking.length ? `  RÉGRESSION (${blocking.length}) : ${blocking.map((v) => v.id).join(", ")}` : "  aucune régression face à la référence enregistrée");
  if (blocking.length && flag("strict")) process.exitCode = 2;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const provider = arg("provider");
  if (provider) process.env.LLM_PROVIDER = provider;
  if (cmd === "list") {
    for (const c of allCases()) console.log(`${c.id.padEnd(22)} ${c.title}${c.ci ? " (CI)" : ""}`);
    return;
  }
  if (cmd === "judge") {
    // Rejuger un run gardé : son environnement (base, données) se lit dans run.json.
    const runDir = path.resolve(arg("run") ?? ".");
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as { db: string };
    if (!process.env.DATABASE_URL && process.env.CORTEX_BENCH_PG_URL) runEnv(path.join(runDir, "data"), dbUrl(process.env.CORTEX_BENCH_PG_URL, run.db));
    if (!process.env.LLM_TAPE) process.env.LLM_TAPE = `record:${path.join(runDir, "judge.tape.jsonl")}`;
    return judgeRun(runDir);
  }
  if (cmd === "mark-ref") {
    fs.writeFileSync(path.join(path.resolve(arg("run") ?? "."), "REFERENCE"), "");
    return;
  }
  if (cmd === "score") {
    const runDir = path.resolve(arg("run")!);
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as BenchRun;
    return scoreRun(runDir, findCase(run.caseId));
  }
  if (cmd === "report") {
    const { writeReport } = await import("../lib/bench/report");
    console.log(writeReport(need("CORTEX_BENCH_HOME"), arg("out")));
    return;
  }
  if (cmd === "run") {
    const c = findCase(arg("case") ?? "");
    let keep = false;
    try {
      const runDir = await runCase(c);
      const exported = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as BenchRun;
      if (!flag("no-judge") && exported.exam?.items.length) {
        try {
          await spawnJudge(runDir);
        } catch (e) {
          // La base reste : le jugement se refait sans régénérer (synth-bilingue, 04/11 : délai dépassé).
          keep = true;
          console.error(`  juge en échec (${(e as Error).message}) — base gardée ; rejuger : npm run bench -- judge --run ${runDir} && npm run bench -- score --run ${runDir}`);
        }
      }
      await scoreRun(runDir, c);
    } finally {
      if (!keep) await dropCreatedDb();
    }
    return;
  }
  throw new Error("usage : bench run --case <id> --provider codex-cli [--replay <dossier>] [--ref <run>] [--prepare] [--keep] [--no-judge] | judge --run <dossier> | score --run <dossier> [--ref <run>] | mark-ref --run <dossier> | report [--out fichier.md] | list");
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(`Banc : ${(e as Error).message}`); process.exit(1); });
