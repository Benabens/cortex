import { currentCourse } from "@/db/client";
import { nowStr, q } from "@/db/q";
import { DEFAULT_COURSE, getCourse } from "@/lib/courses";
import type { Archetype } from "@/lib/archetypes";
import { profile, type Slot } from "@/lib/course-profile";
import { completeText, completeVia, extractJson } from "@/lib/llm";
import { search } from "@/lib/search";
import { difficultyBlockForExam } from "@/lib/difficulty";
import { buildExamArtifact, buildExerciseArtifact } from "@/lib/exam-latex";
import { dueConcepts, markTested } from "@/lib/schedule";
import { loadJobCheckpoint, saveJobCheckpoint } from "@/lib/jobs";
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
  category?: string; // catégorie du profil du cours
  statement_tex: string;
  solution_tex: string;
  source_inspiration?: string;
  difficulty?: number;
  points?: number;
  // moteur-v2 — figure rendue (PNG dans examsDir, déjà injectée dans statement_tex) + valeurs
  // vérité déclarées par la spec (base de la vérification déterministe P4). Additifs.
  figureFile?: string | null;
  figureTruth?: Record<string, number> | null;
};
export type ExamSpec = { title: string; questions: ExamQuestion[]; duration_min?: number };

// ---------- Contexte de génération ----------
function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + " […]" : s;
}

/** Échantillon diversifié d'items du corpus pour un ou plusieurs types de source. */
async function sampleByType(types: string[], perItem: number, maxItems: number): Promise<{ src: string; text: string }[]> {
  const ph = types.map(() => "?").join(",");
  const rows = await q.all<{ src: string; text: string }>(
    `SELECT s.title src, i.text text
     FROM items i JOIN sources s ON s.id = i.source_id
     WHERE s.type IN (${ph}) AND length(i.text) > 120
     ORDER BY s.recency_weight DESC, RANDOM() LIMIT ?`,
    ...types,
    maxItems * 4
  );
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

async function gatherContext() {
  const weaknesses = (
    await q.all<{ topic: string; description: string | null }>(
      `SELECT topic, description FROM weaknesses ORDER BY severity DESC, logged_at DESC LIMIT 6`
    )
  ).map((w) => ({ topic: w.topic, note: trunc(w.description ?? "", 400) }));

  const due = await dueConcepts(8);

  // FORMAT = les vrais finals cochés en référence (priorité absolue). Sinon repli récents.
  const refs = await referencePaths();
  let styleRows: { src: string; text: string }[];
  if (refs.length) {
    const ph = refs.map(() => "?").join(",");
    styleRows = await q.all<{ src: string; text: string }>(
      `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.path IN (${ph}) AND length(i.text) > 120
       ORDER BY s.year DESC, RANDOM() LIMIT 18`,
      ...refs
    );
  } else {
    styleRows = await q.all<{ src: string; text: string }>(
      `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.type IN ('final','midterm') ORDER BY s.year DESC, RANDOM() LIMIT 12`
    );
  }
  const style = styleRows.slice(0, 12).map((r) => ({ src: r.src, excerpt: trunc(r.text, 1600) }));

  // CONTENU = tout le corpus, en priorité les séries d'exos + le reste (trimé pour la vitesse).
  // 'site' (sites HTML de révision des cours additionnels) est sans effet pour cs-202 (aucun item de ce type).
  const exercises = await sampleByType(["exercise", "serie", "site"], 550, 8);
  const reviews = await sampleByType(["review"], 320, 6);
  const cheats = await sampleByType(["cheatsheet"], 400, 3);
  const course = await sampleByType(["course_pdf"], 320, 4);

  return { weaknesses, due, style, exercises, reviews, cheats, course };
}

/** Contexte de génération (résolu) — utilisé par tous les prompt builders. */
type Ctx = Awaited<ReturnType<typeof gatherContext>>;

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

export async function buildPrompt(ctx: Ctx): Promise<string> {
  const p = profile();
  const block = (title: string, items: { src: string; excerpt?: string; text?: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.excerpt ?? c.text}`)] : [];
  // V3 — calibrage de difficulté (cs-202) : la prof punit une idée fausse précise par exo.
  const diff = currentCourse() === DEFAULT_COURSE ? difficultyBlockForExam() : "";
  return [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...(diff ? [diff, ``] : []),
    ...p.promptIntroFull(),
    ``,
    `═══ LES VRAIS FINALS À IMITER (forme, types, ton, niveau, MISE EN PAGE) ═══`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ``,
    `═══ SCOPE OFFICIEL (Study Guide + hints staff — ne génère QUE sur ces sujets) ═══`,
    await p.staffNotesText(5000),
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

async function callClaude(ctx: Ctx): Promise<ExamSpec> {
  // Voie « API payante » explicite (bouton in-app historique) → provider anthropic forcé.
  // 'opus' → claude-opus-4-8 (mapping du provider, ex-GEN_MODEL) ; streaming interne.
  const res = await completeVia("anthropic", {
    prompt: await buildPrompt(ctx),
    model: "opus",
    maxTokens: 16000,
    thinking: "adaptive",
    json: { schema: EXAM_SCHEMA as unknown as object, effort: "high" },
  });
  return JSON.parse(res.text || "{}") as ExamSpec;
}

// Examen factice pour tester le pipeline LaTeX sans IA.
function stubExam(_ctx: Ctx): ExamSpec {
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
export async function listExams() {
  await q.ensureTable("exams");
  let verifyCol = "NULL";
  try {
    if ((await q.columns("exams")).includes("verify_summary")) verifyCol = "e.verify_summary";
  } catch {}
  const rows = await q.all<any>(
    `SELECT e.id, e.created_at, e.status, e.html_path, ${verifyCol} verify_summary,
            (SELECT count(*) FROM exam_questions q WHERE q.exam_id = e.id) nq
     FROM exams e WHERE e.format_template IS NULL OR e.format_template != 'exercise'
     ORDER BY e.created_at DESC, e.id DESC`
  );
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

export async function deleteExam(id: number) {
  const row = await q.get<{ html_path: string | null }>(`SELECT html_path FROM exams WHERE id = ?`, id);
  await q.run(`DELETE FROM exam_questions WHERE exam_id = ?`, id);
  await q.run(`DELETE FROM exams WHERE id = ?`, id);
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
export async function buildBrief(): Promise<string> {
  const ctx = await gatherContext();
  return [
    await buildPrompt(ctx),
    ``,
    `--- FORMAT DE SORTIE ATTENDU ---`,
    `Écris un JSON valide conforme exactement à ce schéma (clés en anglais, statement_tex/solution_tex en LaTeX) :`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

async function ensureExamCols() {
  // V — méthode de vérif (additif) : « deterministic » (prouvé) | « llm » (relecture) | « unverified ».
  try { await q.ensureColumns("exam_questions", ["verified", "verify_issue", "verify_method"]); } catch {}
  try { await q.ensureColumns("exams", ["verify_summary"]); } catch {}
}

/** Enregistre un examen rédigé : DB + artefact (PDF LaTeX, sinon HTML lisible) + répétition espacée. */
export async function persistExam(spec: ExamSpec, report?: VerifyReport): Promise<{ id: number; url: string; texError?: string }> {
  if (!spec?.questions?.length) throw new Error("ExamSpec vide ou invalide (aucune question).");
  await ensureExamCols();

  const weaknessIds = (await q.all<{ id: number }>(`SELECT id FROM weaknesses`)).map((r) => r.id);
  const id = await q.insert(
    `INSERT INTO exams (format_template, targeted_weakness_ids, status) VALUES (?,?,?)`,
    "final",
    JSON.stringify(weaknessIds),
    "ready"
  );

  for (const [i, question] of spec.questions.entries()) {
    const r = report?.results?.find((x) => x.index === i);
    const verified = r ? r.verified : null;
    await q.run(
      `INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration, verified, verify_issue, verify_method)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, question.concept, question.statement_tex, question.solution_tex, question.source_inspiration ?? null, verified, r?.issue ?? null, r?.method ?? null
    );
  }

  const dateLabel = nowStr().slice(0, 10);
  const { file, texError } = await buildExamArtifact(spec, id, dateLabel);
  await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, file, id);
  if (report) {
    await q.run(
      `UPDATE exams SET verify_summary = ? WHERE id = ?`,
      `ok=${report.ok} corrigés=${report.fixed} durcis=${report.regenerated} retirés=${report.removed} non-vérifiés=${report.unverified}`,
      id
    );
  }

  await markTested([...spec.questions.map((question) => question.concept), ...(await dueConcepts(6))]);
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
export async function gatherTargetedContext(target: string) {
  const groups = await search(target, 40, "or");
  const byType: Record<string, { src: string; text: string }[]> = {};
  for (const g of groups)
    for (const h of g.hits) {
      const row = await q.get<{ text: string }>("SELECT text FROM items WHERE id = ?", h.itemId);
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

  // moteur-v2 (P3) — le pipeline ARCHITECTE multi-passes (conception du piège → rédaction →
  // critique adversariale + révision → vérif justesse) est désormais la voie de TOUT cours
  // (persona/archétypes/barème dérivés du profil ; moules/figures de l'ADN détecté) — plus de
  // routage par matière. Entrées : IMAGE, ou TEXTE riche classé (V5). La voie mono-passe
  // ci-dessous reste le REPLI si l'architecte échoue.
  if (target || imageRel) {
    try {
      const { architectExercise } = await import("@/lib/architect");
      const stepFn = opts.onStep ?? (() => {});
      if (imageRel) {
        const res = await architectExercise(target, { onStep: opts.onStep, image: imageRel, note: norm.note });
        return { id: res.id, url: res.url, texError: res.texError };
      }
      // Texte : détecter le type (V5). Court → sujet direct (pas d'appel). Riche → classification.
      const { classifyTargetText, isRichText } = await import("@/lib/intake");
      if (isRichText(target)) {
        stepFn("Analyse de l'entrée (sujet · consigne · log de faiblesses)…", 6);
        const cls = await classifyTargetText(target);
        if (cls.kind === "weakness_log" && cls.weaknesses.length) {
          const { createWeakness } = await import("@/lib/weaknesses");
          for (const w of cls.weaknesses) {
            try { await createWeakness({ topic: w.topic, description: w.description, severity: w.severity, source: "log", analyzed: true }); } catch {}
          }
          const top = [...cls.weaknesses].sort((a, b) => b.severity - a.severity)[0];
          stepFn(`${cls.weaknesses.length} faiblesse(s) extraite(s) — exo ciblé sur « ${top.topic} »`, 10);
          const res = await architectExercise(top.topic, { onStep: opts.onStep });
          return { id: res.id, url: res.url, texError: res.texError };
        }
        if (cls.kind === "statement") {
          stepFn(`Consigne détectée → exo NEUF du même type (« ${cls.focus} »)`, 10);
          const res = await architectExercise(cls.focus, { onStep: opts.onStep, statement: target });
          return { id: res.id, url: res.url, texError: res.texError };
        }
        // subject riche : on cible le focus
        const res = await architectExercise(cls.focus || target, { onStep: opts.onStep });
        return { id: res.id, url: res.url, texError: res.texError };
      }
      const res = await architectExercise(target, { onStep: opts.onStep });
      return { id: res.id, url: res.url, texError: res.texError };
    } catch (e) {
      // repli mono-passe ci-dessous (résilience historique) — jamais un job planté pour un
      // échec d'architecte ; le repli est plus simple mais aboutit toujours.
      step(`Architecte indisponible (${(e as Error).message.slice(0, 60)}) → repli mono-passe`, 10);
    }
  }

  step("Contexte ciblé assemblé (cours + séries + past-exams + staff)", 12);
  // mots-clés d'ancrage : le texte si fourni, sinon le nom du concept de la note
  const seed = target || (norm.note ?? "");
  const ctx = await gatherTargetedContext(seed);
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
  const text = await completeText({ prompt, model: "opus", timeoutMs: 480_000 });
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

export async function persistExercise(question: ExamQuestion, report?: VerifyReport, sourceTag?: string): Promise<{ id: number; url: string; texError?: string }> {
  await ensureExamCols();
  const id = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('exercise','ready')`);
  const r = report?.results?.[0];
  await q.run(
    `INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration, verified, verify_issue, verify_method) VALUES (?,?,?,?,?,?,?,?)`,
    id, question.concept, question.statement_tex, question.solution_tex, sourceTag ?? null, r?.verified ?? null, r?.issue ?? null, r?.method ?? null
  );
  const dateLabel = nowStr().slice(0, 10);
  const { file, texError } = await buildExerciseArtifact(question, id, dateLabel);
  await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, file, id);
  if (report) await q.run(`UPDATE exams SET verify_summary = ? WHERE id = ?`, `ok=${report.ok} corrigés=${report.fixed} durcis=${report.regenerated}`, id);
  await markTested([question.concept]);
  return { id, url: `/exam/${file}${courseQ()}`, texError };
}

/** Voie API directe (optionnelle, payante). */
export async function generateExam(opts: { dry?: boolean } = {}): Promise<{ id: number; url: string }> {
  const ctx = await gatherContext();
  const spec = opts.dry ? stubExam(ctx) : await callClaude(ctx);
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
  const text = await completeText({ prompt, model: "opus", timeoutMs: 420_000 });
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

export function buildBatchPrompt(ctx: Ctx, slots: { category: string; points: number; brief: string; mold?: string | null }[]): string {
  const p = profile();
  // V3 — calibrage de difficulté (cs-202) : menu de pièges réels + style prof + distribution.
  const diff = currentCourse() === DEFAULT_COURSE ? difficultyBlockForExam() : "";
  return [
    p.directivesBlock(),
    ``,
    p.visionBlock(),
    ``,
    ...(diff ? [diff, ``] : []),
    ...p.promptIntroBatch(slots.length),
    ``,
    `═══ LES ${slots.length} EXERCICES À PRODUIRE (slots IMPOSÉS — respecte catégorie, barème, thème) ═══`,
    // moteur-v2 (P2) — le MOULE du slot (ADN détecté) est imposé quand il existe ; un slot sans
    // moule (ex. les slots historiques du cours par défaut) produit EXACTEMENT la ligne d'avant (byte-identique).
    ...slots.map((s, i) => `${i + 1}. [${s.category}, ${s.points} pts]${s.mold ? ` [MOULE : ${s.mold}]` : ""} ${s.brief}`),
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

async function generateBatch(ctx: Ctx, slots: Slot[]): Promise<ExamQuestion[]> {
  // Crochet de TEST (inerte sauf si l'env est posé) : rend des questions déterministes sans appeler
  // Max → permet de prouver la RÉSILIENCE du pipeline (P3) de façon reproductible et gratuite.
  if (process.env.CORTEX_TEST_STUB_BATCH) {
    return slots.map((s, i) => ({
      category: s.category, concept: `Stub ${s.category} ${i + 1}`,
      statement_tex: String.raw`\subq{1.1}{Question de test}{${s.points}} Énoncé déterministe (test résilience).`,
      solution_tex: "Solution de test.", points: s.points,
    }));
  }
  const text = await completeText({
    prompt: buildBatchPrompt(ctx, slots as any),
    model: "opus",
    // un lot de 3 << un appel de 6 ; surchargeable (P3 : « augmente le timeout par lot »).
    timeoutMs: Number(process.env.CORTEX_BATCH_TIMEOUT_MS) || 600_000,
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

export async function generateExamViaClaudeCode(opts: { verify?: boolean; count?: number; focus?: string; onStep?: StepCb; jobId?: number } = {}): Promise<{ id: number; url: string; texError?: string }> {
  const t0 = Date.now();
  // progression MONOTONE : les lots/vérifs parallèles rapportent dans le désordre → max courant.
  const raw = opts.onStep ?? (() => {});
  let prog = 0;
  const step: StepCb = (s, pr) => { prog = Math.max(prog, pr); raw(s, prog); };
  step("Contexte assemblé (corpus + directives + blueprint)", 5);
  const ctx = await gatherContext(); // construit UNE fois par job (cache de contexte)
  // Blueprint : slots pilotés par les archétypes du cours × poids × faiblesses (repli : slots du profil).
  const p = profile();
  let slots: Slot[];
  try {
    slots = await p.buildBlueprint();
  } catch {
    slots = await p.examSlots();
  }
  // V9 composeur (CS-202 calcul/trace) : Ben peut choisir le NOMBRE d'exercices. Défaut (count absent)
  // = longueur du blueprint → comportement HISTORIQUE inchangé (régression byte-identique). count>0
  // tronque ou ré-instancie cycliquement les slots du blueprint pour atteindre la longueur demandée.
  const want = opts.count && opts.count > 0 ? Math.min(12, Math.floor(opts.count)) : 0;
  if (want && want !== slots.length) {
    if (want < slots.length) slots = slots.slice(0, want);
    else { const base = slots.slice(); while (slots.length < want) slots.push(base[slots.length % base.length]); }
  }
  // « Mets l'accent sur… » (focus GÉNÉRIQUE, allégée) — force 1-2 slots à porter sur le thème choisi
  // SANS monopoliser (le reste du blueprint est préservé). Catégorie/barème gardés ; on remplace par
  // un objet NEUF (les slots peuvent être partagés par référence) et on efface archetypeId pour que
  // pickArchetype rechoisisse selon le thème.
  const focus = (opts.focus ?? "").trim();
  if (focus && slots.length) {
    const nFocus = Math.min(2, slots.length);
    for (let i = 0; i < nFocus; i++) {
      const j = slots.length - 1 - i;
      slots[j] = { ...(slots[j] as any), brief: focus, archetypeId: undefined };
    }
    step(`Accent demandé : « ${focus} » — ${nFocus} exercice(s) ciblé(s)`, 5);
  }
  // (stub de test : vérifier des questions factices n'a aucun sens et appellerait le vrai Max)
  const doVerify = opts.verify !== false && !process.env.CORTEX_TEST_STUB_BATCH;
  // PERFECT B1 — cs-202 : CHAQUE question de l'examen complet passe par l'ARCHITECTE
  // (concevoir le piège → rédiger → audit adversarial → réviser), en parallèle borné.
  const useArchitect = currentCourse() === DEFAULT_COURSE;
  // V8 — RÉSILIENCE : on découpe TOUS les slots en lots (longueur réelle, pas plafonnée à 6).
  // Lots plus petits pour les cours sans architecte (one-shot) → plus parallèles, plus robustes
  // au timeout. cs-202 (architecte, 6 slots, BATCH=3) reste [3,3] — comportement INCHANGÉ.
  const BATCH = useArchitect ? 3 : 2;
  const chunk = <T,>(arr: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
  const batches = chunk(slots, BATCH).filter((b) => b.length);
  const nBatches = batches.length;
  const auditAll: Record<string, unknown> = {};
  let qDone = 0;
  const qTotal = slots.length;

  // checkpoint : lots déjà générés lors d'un run précédent interrompu.
  // Phase C — quand le run appartient à un JOB (opts.jobId), la progression est persistée
  // PAR LOT dans jobs.checkpoint_json (DB) : un worker tué et re-pompé reprend au lot
  // suivant, sans doublon. Sans job (scripts/tests) : fichier disque historique.
  const jobId = opts.jobId;
  type Ckpt = { at: number; batches: (ExamQuestion[] | null)[] };
  let saved: (ExamQuestion[] | null)[] = [null, null];
  if (typeof jobId === "number") {
    const j = await loadJobCheckpoint<Ckpt>(jobId);
    if (j && Array.isArray(j.batches) && Date.now() - (j.at ?? 0) < 2 * 3600_000) saved = j.batches;
  } else {
    try {
      const j = JSON.parse(fs.readFileSync(CKPT(), "utf8"));
      if (Array.isArray(j?.batches) && Date.now() - (j.at ?? 0) < 2 * 3600_000) saved = j.batches;
    } catch {}
  }
  const saveCkpt = async (batchIndex: number) => {
    if (typeof jobId === "number") {
      await saveJobCheckpoint(jobId, { at: Date.now(), batches: saved } satisfies Ckpt);
    } else {
      try { fs.mkdirSync(path.dirname(CKPT()), { recursive: true }); fs.writeFileSync(CKPT(), JSON.stringify({ at: Date.now(), batches: saved })); } catch {}
    }
    // Crochet de TEST (inerte sans l'env) : simule la MORT du worker juste après la
    // persistance d'un lot → preuve déterministe de la reprise sans perte (Phase C).
    if (process.env.CORTEX_TEST_DIE_AFTER_BATCH === String(batchIndex)) process.exit(9);
  };

  /** Architecte par slot (pool de 2 dans le lot → ≤4 pipelines claude en parallèle au pic). */
  async function architectBatch(bslots: Slot[], lotIdx: number): Promise<ExamQuestion[]> {
    const { architectQuestion } = await import("@/lib/architect");
    const archs = profile().archetypes;
    const out: (ExamQuestion | null)[] = new Array(bslots.length).fill(null);
    const failed: number[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < bslots.length) {
        const k = idx++;
        const slot = bslots[k] as Slot & { archetypeId?: string };
        const a = (slot.archetypeId && archs.find((x) => x.id === slot.archetypeId)) || pickArchetype(`${slot.category} ${slot.brief}`);
        try {
          const r = await architectQuestion(a, a.concept, slot.points, {
            maxRounds: 1,
            mold: (slot.mold as import("@/lib/molds").MoldKind | null) ?? null, // moteur-v2 (P2) — moule du slot (ADN)
            onStep: (m) => step(`Lot ${lotIdx + 1} · Q${k + 1} (${a.id}) · ${m}`, 10 + Math.round((qDone / qTotal) * 30)),
          });
          out[k] = { ...r.q, category: slot.category, points: slot.points };
          auditAll[`lot${lotIdx + 1}-q${k + 1}-${a.id}`] = r.auditLog;
        } catch (e) {
          failed.push(k);
          step(`Lot ${lotIdx + 1} · Q${k + 1} — architecte échoué (${(e as Error).message.slice(0, 80)}) → repli one-shot`, 0);
        }
        qDone++;
        step(`Architecte : ${qDone}/${qTotal} questions construites`, 10 + Math.round((qDone / qTotal) * 30));
      }
    };
    await Promise.all([worker(), worker()]);
    if (failed.length) {
      // repli one-shot pour les slots dont l'architecte a échoué — lui-même résilient (jamais throw).
      try {
        const fqs = await generateBatch(ctx, failed.map((k) => bslots[k]) as any);
        failed.forEach((k, j) => { if (fqs[j]) out[k] = fqs[j]; });
      } catch (e) {
        step(`Lot ${lotIdx + 1} · repli one-shot échoué (${(e as Error).message.slice(0, 80)}) → questions manquantes ignorées`, 0);
      }
    }
    const qs = out.filter((q): q is ExamQuestion => !!q);
    // V8 — RÉSILIENCE : on RENVOIE ce qu'on a (même partiel/vide). Un lot incomplet ne fait
    // JAMAIS échouer le job — l'examen sort avec les questions réussies, l'écart est loggé.
    if (qs.length < bslots.length) step(`Lot ${lotIdx + 1} : ${qs.length}/${bslots.length} questions (le reste a échoué et est ignoré)`, 0);
    return qs;
  }

  /**
   * PIPELINE (Phase 4 V2) : chaque lot est vérifié+durci DÈS qu'il est généré, sans attendre
   * l'autre lot (avant : gen des 2 lots PUIS vérif des 6) → les chaînes de vérif des 2 lots
   * tournent en parallèle (3+3), le mur d'attente séquentiel gen→verify disparaît.
   * maxAttempts de durcissement 3→2 (validé NS15 : cap du pire cas sans perte mesurée).
   */
  const settled = await Promise.all(
    batches.map(async (bslots, i) => {
      // V8 — un lot ne fait JAMAIS échouer le job : tout throw inattendu est rattrapé ici et
      // le lot rend simplement 0 question (les autres lots continuent, l'examen sort partiel).
      try {
        // Crochet de TEST (inerte sauf si l'env est posé) : force le timeout de certains lots
        // (« CORTEX_TEST_FAIL_BATCHES=0,1 ») pour prouver que le job CONTINUE et livre du partiel.
        if ((process.env.CORTEX_TEST_FAIL_BATCHES ?? "").split(",").filter(Boolean).includes(String(i)))
          throw new Error("timeout simulé (test résilience V8)");
        let qs: ExamQuestion[];
        if (saved[i]?.length === bslots.length) {
          step(`Lot ${i + 1}/${nBatches} repris du checkpoint`, 20);
          qs = saved[i]!;
          qDone += bslots.length;
        } else if (useArchitect) {
          step(`Lot ${i + 1}/${nBatches} — ARCHITECTE par question (piège → rédaction → audit adversarial)…`, 8 + i * 2);
          qs = await architectBatch(bslots, i);
          saved[i] = qs;
          await saveCkpt(i);
          step(`Lot ${i + 1}/${nBatches} construit par l'architecte ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 40);
        } else {
          // cours sans architecte : voie one-shot, RÉSILIENTE — réessai puis IGNORE le lot.
          step(`Lot ${i + 1}/${nBatches} — génération de ${bslots.length} exercices…`, 8 + i * 2);
          let got: ExamQuestion[] = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const g = (await generateBatch(ctx, bslots as any)).filter(Boolean);
              if (g.length) { got = g; break; }
              throw new Error("lot vide");
            } catch (e) {
              step(`Lot ${i + 1}/${nBatches} — ${attempt < 2 ? "réessai" : "timeout/échec → lot ignoré"} (${(e as Error).message.slice(0, 80)})`, 8 + i * 2);
            }
          }
          if (got.length < bslots.length) step(`Lot ${i + 1} : ${got.length}/${bslots.length} questions (le reste est ignoré)`, 0);
          qs = got; // peut être partiel ou vide → le job CONTINUE
          if (qs.length) {
            saved[i] = qs;
            await saveCkpt(i);
          }
          step(`Lot ${i + 1}/${nBatches} généré ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 30);
        }
        if (!qs.length) return { questions: [], report: null as VerifyReport | null };
        if (!doVerify) return { questions: qs, report: null as VerifyReport | null };
        step(`Lot ${i + 1}/${nBatches} — vérification à l'aveugle + durcissement…`, 45);
        try {
          const v = await verifyAndHarden({ title: "", questions: qs }, regenerateExercise, 2, (m) => step(`Lot ${i + 1} · ${m}`, 0));
          step(`Lot ${i + 1}/${nBatches} vérifié ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 70);
          return { questions: v.spec.questions, report: v.report as VerifyReport | null };
        } catch (e) {
          step(`Lot ${i + 1} — vérif interrompue : ${(e as Error).message}`, 70);
          return { questions: qs, report: null as VerifyReport | null };
        }
      } catch (e) {
        step(`Lot ${i + 1}/${nBatches} — échec complet, lot ignoré (${(e as Error).message.slice(0, 80)})`, 0);
        return { questions: [] as ExamQuestion[], report: null as VerifyReport | null };
      }
    })
  );

  const c = getCourse(currentCourse());
  const allQuestions = settled.flatMap((s) => s.questions);
  // V8 — on n'échoue QUE si rien n'a abouti (tous les lots ont timeout/échoué). Sinon l'examen
  // sort à sa longueur réelle (partielle si besoin) ; le checkpoint permet de relancer le reste.
  if (!allQuestions.length)
    throw new Error("Aucune question générée (tous les lots ont échoué/timeout). Relance : la génération reprend du checkpoint.");
  const missing = qTotal - allQuestions.length;
  if (missing > 0)
    step(`⚠ Examen livré PARTIEL : ${allQuestions.length}/${qTotal} questions (${missing} ignorée(s) après timeout/échec) — relance pour compléter`, 90);
  const spec: ExamSpec = {
    title: `${c.examCode} ${c.examName} — ${c.examKind}`,
    duration_min: c.durationMin,
    questions: allQuestions,
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
  // journal d'audit adversarial de l'architecte (preuve B1) — à côté des artefacts de l'examen
  if (Object.keys(auditAll).length) {
    try { fs.writeFileSync(path.join(examsDir(), `exam-${out.id}.audit.json`), JSON.stringify(auditAll, null, 2)); } catch {}
  }
  // run COMPLET → checkpoint consommé ; run PARTIEL → on GARDE le checkpoint (relance = reprend
  // les lots réussis, ne rebrûle que ceux qui ont timeout).
  if (missing <= 0) {
    try { fs.unlinkSync(CKPT()); } catch {}
    if (typeof jobId === "number") await saveJobCheckpoint(jobId, null);
  }
  if (out.texError) step(`⚠ Compilation LaTeX échouée → repli HTML lisible (${out.texError.slice(0, 180)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 100);
  return out;
}

/** Prompt pour Claude Code (headless) : le brief complet + sortie JSON stricte. */
async function buildClaudeCodePrompt(ctx: Ctx): Promise<string> {
  return [
    await buildPrompt(ctx),
    ``,
    `--- SORTIE ATTENDUE ---`,
    `Réponds UNIQUEMENT avec un objet JSON valide conforme EXACTEMENT à ce schéma (statement_tex/solution_tex = LaTeX compilable).`,
    `N'écris aucun fichier, n'utilise aucun outil, n'ajoute aucune prose ni balise markdown autour : juste l'objet JSON.`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

