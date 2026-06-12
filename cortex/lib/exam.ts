import { currentCourse, sqlite } from "@/db/client";
import { DEFAULT_COURSE, getCourse } from "@/lib/courses";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import type { Archetype } from "@/lib/archetypes";
import { profile, type Slot } from "@/lib/course-profile";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { search } from "@/lib/search";
import { buildExamArtifact, buildExerciseArtifact } from "@/lib/exam-latex";
import { dueConcepts, markTested } from "@/lib/schedule";
import { examsDir } from "@/lib/paths";
import { referencePaths } from "@/lib/sources";
import { verifyAndHarden, type VerifyReport } from "@/lib/verify";
import fs from "node:fs";
import path from "node:path";

const EXAM_DIR = () => examsDir();

/** Suffixe `?course=` pour les liens fichiers servis (vide pour cs-202 → URLs identiques à avant). */
function courseQ(): string {
  const c = currentCourse();
  return c === DEFAULT_COURSE ? "" : `?course=${c}`;
}

export type ExamQuestion = {
  concept: string;
  category?: string; // 'Networking' | 'OS' | 'C' | 'Project'
  statement_tex: string;
  solution_tex: string;
  source_inspiration?: string;
  difficulty?: number;
  points?: number;
};
export type ExamSpec = { title: string; questions: ExamQuestion[]; duration_min?: number };

// ---------- Contexte de génération ----------
function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + " […]" : s;
}

/** Échantillon diversifié d'items du corpus pour un ou plusieurs types de source. */
function sampleByType(types: string[], perItem: number, maxItems: number): { src: string; text: string }[] {
  const ph = types.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT s.title src, i.text text
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.type IN (${ph}) AND length(i.text) > 120
       ORDER BY s.recency_weight DESC, RANDOM() LIMIT ?`
    )
    .all(...types, maxItems * 4) as { src: string; text: string }[];
  const out: { src: string; text: string }[] = [];
  const perSrc = new Map<string, number>();
  for (const r of rows) {
    const n = perSrc.get(r.src) ?? 0;
    if (n >= 2) continue;
    perSrc.set(r.src, n + 1);
    out.push({ src: r.src, text: trunc(r.text, perItem) });
    if (out.length >= maxItems) break;
  }
  return out;
}

function gatherContext() {
  const weaknesses = (
    sqlite
      .prepare(`SELECT topic, description FROM weaknesses ORDER BY severity DESC, datetime(logged_at) DESC LIMIT 6`)
      .all() as { topic: string; description: string | null }[]
  ).map((w) => ({ topic: w.topic, note: trunc(w.description ?? "", 400) }));

  const due = dueConcepts(8);

  // FORMAT = les vrais finals cochés en référence (priorité absolue). Sinon repli récents.
  const refs = referencePaths();
  let styleRows: { src: string; text: string }[];
  if (refs.length) {
    const ph = refs.map(() => "?").join(",");
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.path IN (${ph}) AND length(i.text) > 120
         ORDER BY s.year DESC, RANDOM() LIMIT 18`
      )
      .all(...refs) as { src: string; text: string }[];
  } else {
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.type IN ('final','midterm') ORDER BY s.year DESC, RANDOM() LIMIT 12`
      )
      .all() as { src: string; text: string }[];
  }
  const style = styleRows.slice(0, 12).map((r) => ({ src: r.src, excerpt: trunc(r.text, 1600) }));

  // CONTENU = tout le corpus, en priorité les séries d'exos + le reste (trimé pour la vitesse).
  // 'site' (sites HTML de révision des cours additionnels) est sans effet pour cs-202 (aucun item de ce type).
  const exercises = sampleByType(["exercise", "serie", "site"], 550, 8);
  const reviews = sampleByType(["review"], 320, 6);
  const cheats = sampleByType(["cheatsheet"], 400, 3);
  const course = sampleByType(["course_pdf"], 320, 4);

  return { weaknesses, due, style, exercises, reviews, cheats, course };
}

const EXAM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "ex. « CS-202 Computer Systems — Final Exam »" },
    duration_min: { type: "integer", description: "180 (3 heures)" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", description: "« Networking » | « OS » | « C » | « Project »" },
          concept: { type: "string", description: "Titre court de l'exercice (ex. « Subnets and packets »)" },
          statement_tex: { type: "string", description: "Énoncé COMPLET en LaTeX (corps seulement, voir contrat). Sous-questions \\subq, énumérateurs \\cn, code lstlisting, figures tikz." },
          solution_tex: { type: "string", description: "Corrigé détaillé en LaTeX, par sous-question." },
          source_inspiration: { type: "string", description: "D'où vient l'inspiration (final/série/lecture)" },
          points: { type: "integer", description: "Barème total de l'exercice (ex. 50, 30, 25, 15, 10)" },
        },
        required: ["category", "concept", "statement_tex", "solution_tex", "points"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
} as const;

export function buildPrompt(ctx: ReturnType<typeof gatherContext>): string {
  const p = profile();
  const block = (title: string, items: { src: string; excerpt?: string; text?: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.excerpt ?? c.text}`)] : [];
  return [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...p.promptIntroFull(),
    ``,
    `═══ LES VRAIS FINALS À IMITER (forme, types, ton, niveau, MISE EN PAGE) ═══`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ``,
    `═══ SCOPE OFFICIEL (Study Guide + hints staff — ne génère QUE sur ces sujets) ═══`,
    p.staffNotesText(5000),
    ...block(`═══ SÉRIES D'EXERCICES & EXOS (matière d'entraînement — inspire-toi des mécaniques) ═══`, ctx.exercises),
    ...block(`═══ REVIEWS DE LECTURES / CONCEPTS FLAGUÉS ═══`, ctx.reviews),
    ...block(`═══ CHEAT SHEETS ═══`, ctx.cheats),
    ...block(`═══ COURS (slides) ═══`, ctx.course),
    ``,
    `(léger, optionnel) Points faibles à éventuellement viser : ${ctx.weaknesses.length ? ctx.weaknesses.map((w) => w.topic).join(" · ") : "(aucun — couvre largement le programme)"}.`,
    `Concepts à ne pas oublier (révision espacée) : ${ctx.due.join(" · ") || "(aucun)"}.`,
    ``,
    p.latexContract(),
    ``,
    `Pour chaque exercice : category, concept (titre court), points, statement_tex, solution_tex (corrigé détaillé : valeurs, raisonnement, points par sous-question). Rédige en français ; le vocabulaire technique reste en anglais comme dans les vrais examens. Réponds uniquement avec l'objet JSON.`,
  ].join("\n");
}

async function callClaude(ctx: ReturnType<typeof gatherContext>): Promise<ExamSpec> {
  const stream = anthropic().messages.stream({
    model: GEN_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: EXAM_SCHEMA }, effort: "high" },
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  } as any);
  const msg: any = await stream.finalMessage();
  const text = msg.content.find((b: any) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text) as ExamSpec;
}

// Examen factice pour tester le pipeline LaTeX sans IA.
function stubExam(_ctx: ReturnType<typeof gatherContext>): ExamSpec {
  return {
    title: "CS-202 Computer Systems — Final Exam (dry-run)",
    duration_min: 180,
    questions: [
      {
        category: "Networking",
        concept: "Subnets and packets",
        points: 50,
        statement_tex: String.raw`Consider an Autonomous System (AS1) connected to the Internet.
\begin{center}\begin{tikzpicture}[node distance=1.3cm]
\node[host](A){$A_1$};\node[rtr,right=of A](R1){$R_1$};\node[rtr,right=of R1](R2){$R_2$};\node[srv,right=of R2](D){$D_1$};
\node[cloudnode,right=1.2cm of D]{Rest of the\\Internet};
\draw[netlink](A)--(R1) node[midway,above]{\cost{5}};\draw[netlink](R1)--(R2) node[midway,above]{\rate{1G}};\draw[netlink](R2)--(D);
\end{tikzpicture}\end{center}\figcaption{Figure 1: topology.}
\subq{1.1}{Packets seen by $R_1$}{30} List all packets seen at interface $e$ when $A_1$ loads \texttt{http://d1.epfl.ch}.\packetgrid{12}`,
        solution_tex: String.raw`ARP (resolve gateway), DNS query/response, TCP SYN/SYNACK/ACK, HTTP GET/response.`,
      },
      {
        category: "OS",
        concept: "Disk access and inodes",
        points: 25,
        statement_tex: String.raw`\subq{3.1}{Block accesses}{12} A process runs \texttt{open}, then \texttt{lseek} to offset 9000, then \texttt{read} 4\,KB. List the disk block accesses (4\,KB blocks, 12 direct pointers).\diskgrid{8}`,
        solution_tex: String.raw`Path resolution + inode + (single-indirect since offset 9000 with small blocks) index block + data block; justify each.`,
      },
    ],
  };
}

// ---------- Persistance ----------
export function listExams() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
    format_template TEXT, targeted_weakness_ids TEXT, html_path TEXT, status TEXT DEFAULT 'draft');`);
  let verifyCol = "NULL";
  try {
    if ((sqlite.prepare(`PRAGMA table_info(exams)`).all() as { name: string }[]).some((c) => c.name === "verify_summary"))
      verifyCol = "e.verify_summary";
  } catch {}
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.created_at, e.status, e.html_path, ${verifyCol} verify_summary,
              (SELECT count(*) FROM exam_questions q WHERE q.exam_id = e.id) nq
       FROM exams e WHERE e.format_template IS NULL OR e.format_template != 'exercise'
       ORDER BY datetime(e.created_at) DESC, e.id DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    questionCount: r.nq,
    verifySummary: r.verify_summary ?? null,
    url: r.html_path ? `/exam/${path.basename(r.html_path)}${courseQ()}` : null,
    solutionsUrl:
      r.html_path && r.html_path.endsWith(".pdf") && fs.existsSync(path.join(EXAM_DIR(), path.basename(r.html_path, ".pdf") + "-corrige.pdf"))
        ? `/exam/${path.basename(r.html_path, ".pdf")}-corrige.pdf${courseQ()}`
        : null,
  }));
}

export function deleteExam(id: number) {
  const row = sqlite.prepare(`SELECT html_path FROM exams WHERE id = ?`).get(id) as
    | { html_path: string | null }
    | undefined;
  sqlite.prepare(`DELETE FROM exam_questions WHERE exam_id = ?`).run(id);
  sqlite.prepare(`DELETE FROM exams WHERE id = ?`).run(id);
  if (row?.html_path) {
    const baseNoExt = path.basename(row.html_path).replace(/\.[^.]+$/, "");
    for (const b of [baseNoExt, `${baseNoExt}-corrige`]) {
      for (const ext of ["pdf", "html", "tex", "log", "aux"]) {
        const p = path.join(EXAM_DIR(), `${b}.${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  }
}

/** Brief de génération destiné à Claude Code (moi) : tout le contexte + le format JSON attendu. */
export function buildBrief(): string {
  const ctx = gatherContext();
  return [
    buildPrompt(ctx),
    ``,
    `--- FORMAT DE SORTIE ATTENDU ---`,
    `Écris un JSON valide conforme exactement à ce schéma (clés en anglais, statement_tex/solution_tex en LaTeX) :`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

function ensureExamCols() {
  const has = (t: string, c: string) =>
    (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((r) => r.name === c);
  try { if (!has("exam_questions", "verified")) sqlite.exec(`ALTER TABLE exam_questions ADD COLUMN verified INTEGER`); } catch {}
  try { if (!has("exam_questions", "verify_issue")) sqlite.exec(`ALTER TABLE exam_questions ADD COLUMN verify_issue TEXT`); } catch {}
  try { if (!has("exams", "verify_summary")) sqlite.exec(`ALTER TABLE exams ADD COLUMN verify_summary TEXT`); } catch {}
}

/** Enregistre un examen rédigé : DB + artefact (PDF LaTeX, sinon HTML lisible) + répétition espacée. */
export async function persistExam(spec: ExamSpec, report?: VerifyReport): Promise<{ id: number; url: string; texError?: string }> {
  if (!spec?.questions?.length) throw new Error("ExamSpec vide ou invalide (aucune question).");
  ensureExamCols();

  const weaknessIds = (sqlite.prepare(`SELECT id FROM weaknesses`).all() as { id: number }[]).map((r) => r.id);
  const id = sqlite
    .prepare(`INSERT INTO exams (format_template, targeted_weakness_ids, status) VALUES (?,?,?)`)
    .run("final", JSON.stringify(weaknessIds), "ready").lastInsertRowid as number;

  const insQ = sqlite.prepare(
    `INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration, verified, verify_issue)
     VALUES (?,?,?,?,?,?,?)`
  );
  spec.questions.forEach((q, i) => {
    const r = report?.results?.find((x) => x.index === i);
    const verified = r ? r.verified : null;
    insQ.run(id, q.concept, q.statement_tex, q.solution_tex, q.source_inspiration ?? null, verified, r?.issue ?? null);
  });

  const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
  const { file, texError } = await buildExamArtifact(spec, id, dateLabel);
  sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(file, id);
  if (report) {
    sqlite.prepare(`UPDATE exams SET verify_summary = ? WHERE id = ?`)
      .run(`ok=${report.ok} corrigés=${report.fixed} durcis=${report.regenerated} retirés=${report.removed} non-vérifiés=${report.unverified}`, id);
  }

  markTested([...spec.questions.map((q) => q.concept), ...dueConcepts(6)]);
  return { id, url: `/exam/${file}${courseQ()}`, texError };
}

// ---------------- EXERCICE CIBLÉ (Phase 3) : 1 exo qualité examen, sans garde ----------------

export function pickArchetype(target: string): Archetype {
  const t = target.toLowerCase();
  const archetypes = profile().archetypes;
  let best = archetypes[0];
  let score = -1;
  for (const a of archetypes) {
    const s = a.topics.filter((k) => t.includes(k)).length + (t.includes(a.category.toLowerCase()) ? 1 : 0);
    if (s > score) { score = s; best = a; }
  }
  return best;
}

/** Ratisse le corpus pour un sujet ciblé — priorité ABSOLUE aux past-exams (Final/Midterm). */
export function gatherTargetedContext(target: string) {
  const groups = search(target, 40, "or");
  const byType: Record<string, { src: string; text: string }[]> = {};
  for (const g of groups)
    for (const h of g.hits) {
      const row = sqlite.prepare("SELECT text FROM items WHERE id = ?").get(h.itemId) as { text: string } | undefined;
      if (!row) continue;
      (byType[g.sourceType] ??= []).push({ src: h.sourceTitle, text: trunc(row.text, 500) });
    }
  const take = (types: string[], n: number) => types.flatMap((t) => byType[t] ?? []).slice(0, n);
  return {
    pastexams: take(["final", "midterm"], 6),
    exercises: take(["exercise", "serie"], 6),
    course: take(["course_pdf"], 4),
    reviews: take(["review"], 5),
    cheats: take(["cheatsheet"], 3),
    refImage: profile().refImageFor(undefined, target),
  };
}

export type ExerciseInput = { target?: string; imageRel?: string; note?: string };

export async function generateTargetedExercise(
  input: string | ExerciseInput,
  opts: { onStep?: StepCb } = {}
): Promise<{ id: number; url: string; texError?: string }> {
  const t0 = Date.now();
  const step = opts.onStep ?? (() => {});
  // entrée : texte simple, objet {target,imageRel,note}, ou JSON encodé (target du job).
  const norm: ExerciseInput = typeof input === "string" ? (input.trim().startsWith("{") ? JSON.parse(input) : { target: input }) : input;
  const target = (norm.target ?? "").trim();
  const imageRel = norm.imageRel?.trim() || undefined;
  if (!target && !imageRel) throw new Error("Donne un sujet OU une image d'exercice.");

  // V3 — cs-202 + sujet TEXTE (pas d'image) → pipeline ARCHITECTE multi-passes (difficulté + style
  // prof : conception du piège → rédaction → critique adversariale + révision → vérif justesse).
  // L'image→exo et les autres cours gardent la voie mono-passe ci-dessous (inchangée).
  if (currentCourse() === DEFAULT_COURSE && target && !imageRel) {
    const { architectExercise } = await import("@/lib/architect");
    const res = await architectExercise(target, { onStep: opts.onStep });
    return { id: res.id, url: res.url, texError: res.texError };
  }

  step("Contexte ciblé assemblé (cours + séries + past-exams + staff)", 12);
  // mots-clés d'ancrage : le texte si fourni, sinon le nom du concept de la note
  const seed = target || (norm.note ?? "");
  const ctx = gatherTargetedContext(seed);
  const a = pickArchetype(seed);
  const pts = a.id === "c-reading" ? 10 : a.id === "labs-reading" ? 15 : a.category === "Networking" ? 40 : 25;
  const block = (title: string, items: { src: string; text: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.text}`)] : [];
  const p = profile();
  // Phase 3 — image → exo : si une image est fournie, le modèle l'ouvre, comprend le concept/type
  // (et l'erreur de l'étudiant si une note est jointe), puis génère un NOUVEL exo du même type.
  const imageLead = imageRel
    ? [
        `═══ IMAGE D'EXERCICE FOURNIE — POINT DE DÉPART ═══`,
        `Ouvre et observe attentivement l'image : ${imageRel} (outil Read). C'est un exercice (d'examen, de série, ou un exo que l'étudiant a raté).`,
        norm.note ? `Note de l'étudiant (ce qu'il n'a pas compris / pourquoi il a buté) : « ${norm.note} »` : ``,
        `Identifie le CONCEPT et le TYPE de raisonnement testés${norm.note ? " ET l'erreur sous-jacente" : ""}. Puis génère un NOUVEL exercice qui teste LE MÊME concept / la même technique, sur un SETUP DIFFÉRENT (autres nombres, autre instance, nombres NON RONDS), dans le FORMAT des examens du cours. NE recopie PAS l'image — produis du neuf du même niveau.`,
        target ? `Sujet additionnel précisé par l'étudiant : « ${target} ».` : ``,
        ``,
      ].filter((x) => x !== ``).concat(``)
    : [];
  // Ancrage vision : cs-202 l'a déjà dans exerciseLead (refImage) → on n'ajoute le bloc QUE pour
  // les cours additionnels (Phase 2) ou quand une image est fournie → cs-202 sans image inchangé.
  const visionLead = currentCourse() !== DEFAULT_COURSE || imageRel ? [p.visionBlock(), ``] : [];
  const prompt = [
    p.directivesBlock(),
    ``,
    ...visionLead,
    ...imageLead,
    ...p.exerciseLead(target || a.concept, a, pts, imageRel ?? ctx.refImage),
    ...block(`═══ PAST-EXAMS DU MÊME TYPE (PRIORITÉ ABSOLUE — le format de la prof) ═══`, ctx.pastexams),
    ...block(`═══ SÉRIES D'EXERCICES + CORRIGÉS ═══`, ctx.exercises),
    ...block(`═══ COURS ═══`, ctx.course),
    ...block(`═══ REVIEWS / CHEAT SHEETS ═══`, [...ctx.reviews, ...ctx.cheats]),
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. Aucun outil au-delà de Read, aucun fichier.`,
    JSON.stringify(ONE_EX_SCHEMA, null, 2),
  ].join("\n");

  step(imageRel ? "Lecture de l'image + génération (Claude · Max)…" : "Génération de l'exercice (Claude · Max)…", 30);
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 480_000 });
  let q = extractJson<ExamQuestion>(text);
  step("Vérification à l'aveugle + durcissement…", 70);
  let report: VerifyReport | undefined;
  try {
    const v = await verifyAndHarden({ title: q.concept, questions: [q] }, regenerateExercise, 2, (m) => step(m, 78));
    q = v.spec.questions[0] ?? q;
    report = v.report;
  } catch (e) {
    step(`Vérif interrompue : ${(e as Error).message}`, 82);
  }
  step("Compilation du PDF (sans garde)…", 92);
  const out = await persistExercise(q, report);
  if (out.texError) step(`⚠ Compilation LaTeX échouée → repli HTML lisible (${out.texError.slice(0, 180)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 100);
  return out;
}

export async function persistExercise(q: ExamQuestion, report?: VerifyReport, sourceTag?: string): Promise<{ id: number; url: string; texError?: string }> {
  ensureExamCols();
  const id = sqlite.prepare(`INSERT INTO exams (format_template, status) VALUES ('exercise','ready')`).run().lastInsertRowid as number;
  const r = report?.results?.[0];
  sqlite
    .prepare(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration, verified, verify_issue) VALUES (?,?,?,?,?,?,?)`)
    .run(id, q.concept, q.statement_tex, q.solution_tex, sourceTag ?? null, r?.verified ?? null, r?.issue ?? null);
  const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
  const { file, texError } = await buildExerciseArtifact(q, id, dateLabel);
  sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(file, id);
  if (report) sqlite.prepare(`UPDATE exams SET verify_summary = ? WHERE id = ?`).run(`ok=${report.ok} corrigés=${report.fixed} durcis=${report.regenerated}`, id);
  markTested([q.concept]);
  return { id, url: `/exam/${file}${courseQ()}`, texError };
}

/** Voie API directe (optionnelle, payante). */
export async function generateExam(opts: { dry?: boolean } = {}): Promise<{ id: number; url: string }> {
  const spec = opts.dry ? stubExam(gatherContext()) : await callClaude(gatherContext());
  return persistExam(spec);
}

// ---------------- Génération en LOTS (fiable, parallèle, résumable) ----------------

const ONE_EX_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string" },
    concept: { type: "string" },
    statement_tex: { type: "string" },
    solution_tex: { type: "string" },
    points: { type: "integer" },
  },
  required: ["category", "concept", "statement_tex", "solution_tex", "points"],
  additionalProperties: false,
} as const;

/** Régénère UN exercice ciblé (même catégorie/barème) en corrigeant le diagnostic — boucle de durcissement. */
export async function regenerateExercise(q: ExamQuestion, diagnostic: string): Promise<ExamQuestion> {
  const p = profile();
  const prompt = [
    p.directivesBlock(),
    ``,
    ...p.regenLead(q.category, q.concept, q.points, diagnostic, p.refImageFor(q.category, q.concept)),
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. statement_tex/solution_tex en LaTeX. Aucun fichier.`,
    JSON.stringify(ONE_EX_SCHEMA, null, 2),
  ].join("\n");
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 420_000 });
  const r = extractJson<ExamQuestion>(text);
  return { ...r, category: q.category, points: q.points };
}

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    questions: { type: "array", items: ONE_EX_SCHEMA },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

export function buildBatchPrompt(ctx: ReturnType<typeof gatherContext>, slots: { category: string; points: number; brief: string }[]): string {
  const p = profile();
  return [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...p.promptIntroBatch(slots.length),
    ``,
    `═══ LES ${slots.length} EXERCICES À PRODUIRE (slots IMPOSÉS — respecte catégorie, barème, thème) ═══`,
    ...slots.map((s, i) => `${i + 1}. [${s.category}, ${s.points} pts] ${s.brief}`),
    ``,
    `═══ MATIÈRE (extraits du corpus, pour ancrer le contenu) ═══`,
    ...ctx.style.slice(0, 6).map((s) => `### ${s.src}\n${s.excerpt}`),
    ...ctx.exercises.slice(0, 5).map((c) => `• (${c.src}) ${c.text}`),
    ``,
    `Concepts à couvrir si naturel : ${ctx.due.slice(0, 5).join(" · ")}${ctx.weaknesses.length ? " · faiblesses: " + ctx.weaknesses.map((w) => w.topic).join(" · ") : ""}`,
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {"questions":[{category,concept,statement_tex,solution_tex,points}, …]} — ${slots.length} exercices, dans l'ordre des slots. Aucun outil, aucun fichier, aucune prose.`,
    JSON.stringify(BATCH_SCHEMA, null, 2),
  ].join("\n");
}

const CKPT = () => path.join(examsDir(), ".gen-checkpoint.json");

async function generateBatch(ctx: ReturnType<typeof gatherContext>, slots: Slot[]): Promise<ExamQuestion[]> {
  const text = await runClaudeCode({
    prompt: buildBatchPrompt(ctx, slots as any),
    model: "opus",
    timeoutMs: 600_000, // un lot de 3 << un appel de 6
  });
  const r = extractJson<{ questions: ExamQuestion[] }>(text);
  const qs = Array.isArray(r.questions) ? r.questions : [];
  // réaligne catégorie/points sur les slots imposés
  return qs.slice(0, slots.length).map((q, i) => ({ ...q, category: slots[i].category, points: slots[i].points }));
}

/**
 * Voie gratuite (Max) — GÉNÉRATION EN LOTS : 2 lots de 3 exos en parallèle (timeouts courts),
 * checkpoint disque par lot (résumable : un lot déjà réussi n'est pas rebrûlé),
 * puis vérif à l'aveugle + durcissement (garde-6), puis compilation PDF.
 */
export type StepCb = (step: string, progress: number) => void;

export async function generateExamViaClaudeCode(opts: { verify?: boolean; onStep?: StepCb } = {}): Promise<{ id: number; url: string; texError?: string }> {
  const t0 = Date.now();
  // progression MONOTONE : les lots/vérifs parallèles rapportent dans le désordre → max courant.
  const raw = opts.onStep ?? (() => {});
  let prog = 0;
  const step: StepCb = (s, pr) => { prog = Math.max(prog, pr); raw(s, prog); };
  step("Contexte assemblé (corpus + directives + blueprint)", 5);
  const ctx = gatherContext(); // construit UNE fois par job (cache de contexte)
  // Blueprint : slots pilotés par les archétypes du cours × poids × faiblesses (repli : slots du profil).
  const p = profile();
  let slots: Slot[];
  try {
    slots = p.buildBlueprint();
  } catch {
    slots = p.examSlots();
  }
  const batches = [slots.slice(0, 3), slots.slice(3, 6)];
  const doVerify = opts.verify !== false;

  // checkpoint : lots déjà générés lors d'un run précédent interrompu
  let saved: (ExamQuestion[] | null)[] = [null, null];
  try {
    const j = JSON.parse(fs.readFileSync(CKPT(), "utf8"));
    if (Array.isArray(j?.batches) && Date.now() - (j.at ?? 0) < 2 * 3600_000) saved = j.batches;
  } catch {}

  /**
   * PIPELINE (Phase 4 V2) : chaque lot est vérifié+durci DÈS qu'il est généré, sans attendre
   * l'autre lot (avant : gen des 2 lots PUIS vérif des 6) → les chaînes de vérif des 2 lots
   * tournent en parallèle (3+3), le mur d'attente séquentiel gen→verify disparaît.
   * maxAttempts de durcissement 3→2 (validé NS15 : cap du pire cas sans perte mesurée).
   */
  const settled = await Promise.all(
    batches.map(async (bslots, i) => {
      let qs: ExamQuestion[];
      if (saved[i]?.length === bslots.length) {
        step(`Lot ${i + 1}/2 repris du checkpoint`, 20);
        qs = saved[i]!;
      } else {
        step(`Lot ${i + 1}/2 — génération de 3 exercices…`, 8 + i * 2);
        let got: ExamQuestion[] | null = null;
        for (let attempt = 1; attempt <= 2 && !got; attempt++) {
          try {
            const g = await generateBatch(ctx, bslots as any);
            if (g.length < bslots.length) throw new Error(`incomplet (${g.length}/${bslots.length})`);
            got = g;
          } catch (e) {
            if (attempt === 2) throw new Error(`Lot ${i + 1} échoué : ${(e as Error).message}`);
            step(`Lot ${i + 1}/2 — réessai (${(e as Error).message})`, 8 + i * 2);
          }
        }
        qs = got!;
        saved[i] = qs;
        try { fs.mkdirSync(path.dirname(CKPT()), { recursive: true }); fs.writeFileSync(CKPT(), JSON.stringify({ at: Date.now(), batches: saved })); } catch {}
        step(`Lot ${i + 1}/2 généré ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 30);
      }
      if (!doVerify) return { questions: qs, report: null as VerifyReport | null };
      step(`Lot ${i + 1}/2 — vérification à l'aveugle + durcissement…`, 45);
      try {
        const v = await verifyAndHarden({ title: "", questions: qs }, regenerateExercise, 2, (m) => step(`Lot ${i + 1} · ${m}`, 0));
        step(`Lot ${i + 1}/2 vérifié ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 70);
        return { questions: v.spec.questions, report: v.report as VerifyReport | null };
      } catch (e) {
        step(`Lot ${i + 1} — vérif interrompue : ${(e as Error).message}`, 70);
        return { questions: qs, report: null as VerifyReport | null };
      }
    })
  );

  const c = getCourse(currentCourse());
  const spec: ExamSpec = {
    title: `${c.examCode} ${c.examName} — ${c.examKind}`,
    duration_min: c.durationMin,
    questions: settled.flatMap((s) => s.questions),
  };
  // fusion des rapports par lot (résultats ré-indexés sur l'ordre fusionné)
  let report: VerifyReport | undefined;
  if (doVerify) {
    const results: VerifyReport["results"] = [];
    let base = 0;
    let ok = 0, fixed = 0, regenerated = 0, removed = 0, unverified = 0;
    for (const s of settled) {
      if (s.report) {
        for (const r of s.report.results) results.push({ ...r, index: base + r.index });
        ok += s.report.ok; fixed += s.report.fixed; regenerated += s.report.regenerated;
        removed += s.report.removed; unverified += s.report.unverified;
      } else {
        for (let k = 0; k < s.questions.length; k++) results.push({ index: base + k, verdict: "unverified", verified: null });
        unverified += s.questions.length;
      }
      base += s.questions.length;
    }
    report = { results, ok, fixed, regenerated, removed, unverified, flagged: removed + unverified };
    step(`Vérification terminée (${ok} ok, ${fixed} corrigés, ${regenerated} durcis, ${unverified} non-vérifiés)`, 88);
  }
  step("Compilation du PDF (LaTeX)…", 92);
  const out = await persistExam(spec, report);
  try { fs.unlinkSync(CKPT()); } catch {} // run complet → checkpoint consommé
  if (out.texError) step(`⚠ Compilation LaTeX échouée → repli HTML lisible (${out.texError.slice(0, 180)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 100);
  return out;
}

/** Prompt pour Claude Code (headless) : le brief complet + sortie JSON stricte. */
function buildClaudeCodePrompt(ctx: ReturnType<typeof gatherContext>): string {
  return [
    buildPrompt(ctx),
    ``,
    `--- SORTIE ATTENDUE ---`,
    `Réponds UNIQUEMENT avec un objet JSON valide conforme EXACTEMENT à ce schéma (statement_tex/solution_tex = LaTeX compilable).`,
    `N'écris aucun fichier, n'utilise aucun outil, n'ajoute aucune prose ni balise markdown autour : juste l'objet JSON.`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

