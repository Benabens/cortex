import { sqlite } from "@/db/client";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { directivesBlock, staffNotesText } from "@/lib/directives";
import { buildExamArtifact } from "@/lib/exam-latex";
import { visionBlock } from "@/lib/figrefs";
import { dueConcepts, markTested } from "@/lib/schedule";
import { referencePaths } from "@/lib/sources";
import { verifyExam, type VerifyReport } from "@/lib/verify";
import fs from "node:fs";
import path from "node:path";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");

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
  const style = styleRows.map((r) => ({ src: r.src, excerpt: trunc(r.text, 1900) }));

  // CONTENU = tout le corpus, en priorité les séries d'exos + le reste.
  const exercises = sampleByType(["exercise", "serie"], 650, 12);
  const reviews = sampleByType(["review"], 360, 10);
  const cheats = sampleByType(["cheatsheet"], 450, 4);
  const course = sampleByType(["course_pdf"], 360, 6);

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

const LATEX_CONTRACT = [
  `═══ FORMAT DE SORTIE : LaTeX COMPILABLE (pdflatex/tectonic), PAS de HTML ═══`,
  `\`statement_tex\` et \`solution_tex\` contiennent du LaTeX (le CORPS seulement). N'écris NI \\documentclass, NI \\usepackage, NI \\section, NI \\begin{document}, NI l'en-tête de question, NI l'espace réponse (le système les ajoute).`,
  `Macros disponibles (utilise-les) :`,
  `  - \\subq{1.1}{Titre de la sous-question}{16}  → en-tête de sous-question avec points.`,
  `  - \\cn{1} \\cn{2} \\cn{3} \\cn{4}  → énumérateurs entourés ① ② ③ ④.`,
  `  - \\callout{This question is \\textbf{\\large FOR ALL STUDENTS.}}  → encadré centré (comme les vrais examens).`,
  `Conventions LaTeX :`,
  `  - Listes : \\begin{itemize}...\\end{itemize} ; options a) b) c) : \\begin{enumerate}[label=\\alph*)]...\\end{enumerate}.`,
  `  - Code inline : \\texttt{find\\_all()} ; bloc de code : \\begin{lstlisting}[language=C] ... \\end{lstlisting}.`,
  `  - Variables/maths en italique : $R_1$, $A_{100}$, $C_{1000}$, $2^{16}$.`,
  `  - Tableaux À REMPLIR : \\begin{tabular}{|l|c|c|}\\hline ... \\\\\\hline \\end{tabular} avec des \\rule{2.5cm}{0.4pt} pour les cases vides.`,
  `  - FIGURES = vraies figures TikZ RICHES (PAS d'ASCII), PLEINE LARGEUR, centrées, avec une légende numérotée — au niveau des images de référence que tu as regardées :`,
  `      • TCP : utilise la macro \\tcpladder{D_1}{A_1}{5 Kbytes}{1 MSS}{$\\infty$}{7} (diagramme en échelle scaffoldé : colonnes + handshake + espace à remplir).`,
  `      • Topologie réseau : compose avec les styles rtr/host/sw/srv/iface + helpers \\cost{10} (coûts roses), \\rate{1G} (débits verts), node[cloudnode]{Rest of the\\\\Internet}. Vise la densité de la Figure 1 (routeurs/switches/clusters d'end-systems étiquetés/interfaces nommées).`,
  `      • OS : inode + direct/indirect/double-indirect → data blocks (style blk) ; arbre de processus fork/exec ; Gantt + table d'états pour le scheduling.`,
  `    Mets chaque figure dans \\begin{center}\\begin{tikzpicture}[node distance=1.2cm] ... \\end{tikzpicture}\\end{center}\\figcaption{Figure N: ...}. La géométrie doit être propre et lisible.`,
  `RÈGLES DE COMPILATION (impératif) : échappe \\% \\& \\# \\_ dans le texte courant ; équilibre toutes les accolades et environnements ; pas de markdown ; pas d'images externes ; LaTeX qui COMPILE du premier coup.`,
].join("\n");

function buildPrompt(ctx: ReturnType<typeof gatherContext>): string {
  const block = (title: string, items: { src: string; excerpt?: string; text?: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.excerpt ?? c.text}`)] : [];
  return [
    directivesBlock(),
    ``,
    visionBlock(),
    ``,
    `Tu es l'équipe enseignante de CS-202 Computer Systems à l'EPFL (Argyraki, Kashyap, Chappelier).`,
    `Tu rédiges le FINAL de l'an prochain : un « Final 2026 » INÉDIT, EN ANGLAIS, qui doit être INDISCERNABLE d'un vrai final EPFL (« ça aurait pu tomber tel quel »). Les CONTRAINTES DURES + l'ANCRAGE VISUEL ci-dessus priment sur tout.`,
    ``,
    `═══ STRUCTURE (calquée sur le Final 2025) ═══`,
    `6 exercices indépendants, notés séparément, regroupés : Networking (2, ~50 pts), OS (2, ~25 et ~30 pts), C (1, ~10 pts), Labs (1, ~15 pts). Total ≈ 180 pts, 3 h.`,
    `PRINCIPE (cf. directives) : chaque grosse question (≥25 pts) = UN artefact unique (programme/topologie/FS+programme/trace) creusé par 5-7 sous-questions \\subq{N.M}{...}{pts} EN ESCALIER (difficulté croissante), qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE et des nombres NON RONDS. Profondeur > largeur. Modèle de profondeur = Final 2024 Q3 (regarde son image).`,
    `Archétypes (en respectant les EXCLUSIONS) : Networking = topologie riche (utilise une figure type Figure 1 : routeurs/switches/clusters/coûts roses/débits verts/interfaces orange/« Rest of the Internet ») + sous-réseaux & paquets (préfixes en PETIT, tableau des paquets/interfaces vus par un routeur), routage Dijkstra/Bellman-Ford, TCP (diagramme en échelle \\tcpladder : SEQ/ACK/cwnd/ssthresh/état + handshake, slow start, Tahoe/Reno, fast recovery), forwarding/longest-prefix, ARP, délais bout-en-bout (multi-saut, bottleneck). OS = accès disque & inodes (compter blocs par open/lseek/read/write, multi-level indexing, frontière direct/indirect), CPU scheduling (FIFO/SJF/STCF/RR/MLFQ, turnaround/response), états de processus, fork/exec/wait/waitpid (arbre de processus), kernel vs user (V/F à justifier). C = LIRE du code lab-style, reconnaître syscalls/fork/exec/wait/file descriptors (jamais écrire/débugger). Labs = lecture/compréhension de code des labs (client-serveur get_file/send_file/socket_layer, filesystem direntv6, multi-threading) — PAS « DKVS ».`,
    ``,
    `═══ LES VRAIS FINALS À IMITER (forme, types, ton, niveau, MISE EN PAGE) ═══`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ``,
    `═══ SCOPE OFFICIEL (Study Guide + hints staff — ne génère QUE sur ces sujets) ═══`,
    staffNotesText(7000),
    ...block(`═══ SÉRIES D'EXERCICES & EXOS (matière d'entraînement — inspire-toi des mécaniques) ═══`, ctx.exercises),
    ...block(`═══ REVIEWS DE LECTURES / CONCEPTS FLAGUÉS ═══`, ctx.reviews),
    ...block(`═══ CHEAT SHEETS ═══`, ctx.cheats),
    ...block(`═══ COURS (slides) ═══`, ctx.course),
    ``,
    `(léger, optionnel) Points faibles à éventuellement viser : ${ctx.weaknesses.length ? ctx.weaknesses.map((w) => w.topic).join(" · ") : "(aucun — couvre largement le programme)"}.`,
    `Concepts à ne pas oublier (révision espacée) : ${ctx.due.join(" · ") || "(aucun)"}.`,
    ``,
    LATEX_CONTRACT,
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
\node[host](A){A};\node[rtr,right=of A](R1){$R_1$};\node[rtr,right=of R1](R2){$R_2$};\node[srv,right=of R2](D){$D_1$};
\draw[lnk](A)--(R1);\draw[lnk](R1)--(R2);\draw[lnk](R2)--(D);
\end{tikzpicture}\end{center}
\subq{1.1}{IP subnets}{20}
\cn{1} Identify all the IP subnets inside AS1. \cn{2} Assign each subnet a prefix of minimal size starting at \texttt{18.0.0.0}.
\begin{center}\begin{tabular}{|l|c|c|}\hline Subnet & \# hosts & Prefix \\\hline A & 100 & \rule{2.5cm}{0.4pt}\\\hline\end{tabular}\end{center}`,
        solution_tex: String.raw`A needs $\geq 100$ hosts $\Rightarrow$ a \texttt{/25} (126 usable). Prefix \texttt{18.0.0.0/25}.`,
      },
      {
        category: "OS",
        concept: "Disk access and inodes",
        points: 25,
        statement_tex: String.raw`\subq{3.1}{Block accesses}{12} A process runs \texttt{open}, then \texttt{lseek}, then \texttt{read} 4\,KB. Count the disk block accesses.`,
        solution_tex: String.raw`Path resolution + inode + data block(s); justify each access.`,
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
       FROM exams e ORDER BY datetime(e.created_at) DESC, e.id DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    questionCount: r.nq,
    verifySummary: r.verify_summary ?? null,
    url: r.html_path ? `/exam/${path.basename(r.html_path)}` : null,
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
    for (const ext of ["pdf", "html", "tex", "log", "aux"]) {
      const p = path.join(EXAM_DIR, `${baseNoExt}.${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
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

/** Enregistre un examen rédigé : DB + artefact (PDF LaTeX, sinon HTML) + répétition espacée. */
export async function persistExam(spec: ExamSpec, report?: VerifyReport): Promise<{ id: number; url: string }> {
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
    const verified = r ? (r.verdict === "ok" && !r.violates_exclusion ? 1 : 0) : null;
    insQ.run(id, q.concept, q.statement_tex, q.solution_tex, q.source_inspiration ?? null, verified, r?.issue ?? null);
  });

  const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
  const { file } = await buildExamArtifact(spec, id, dateLabel);
  sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(file, id);
  if (report) {
    sqlite.prepare(`UPDATE exams SET verify_summary = ? WHERE id = ?`)
      .run(`ok=${report.ok} corrigés=${report.fixed} signalés=${report.flagged}`, id);
  }

  markTested([...spec.questions.map((q) => q.concept), ...dueConcepts(6)]);
  return { id, url: `/exam/${file}` };
}

/** Voie API directe (optionnelle, payante). */
export async function generateExam(opts: { dry?: boolean } = {}): Promise<{ id: number; url: string }> {
  const spec = opts.dry ? stubExam(gatherContext()) : await callClaude(gatherContext());
  return persistExam(spec);
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

/** Voie gratuite (abonnement Max) : rédige via Claude Code, VÉRIFIE chaque exo, puis compile le PDF. */
export async function generateExamViaClaudeCode(opts: { verify?: boolean } = {}): Promise<{ id: number; url: string }> {
  const text = await runClaudeCode({
    prompt: buildClaudeCodePrompt(gatherContext()),
    model: "opus",
    timeoutMs: 840_000,
  });
  let spec = extractJson<ExamSpec>(text);
  let report: VerifyReport | undefined;
  if (opts.verify !== false) {
    try {
      const v = await verifyExam(spec);
      spec = v.spec;
      report = v.report;
    } catch (e) {
      console.error("[verify] échec, examen conservé non vérifié :", (e as Error).message);
    }
  }
  return persistExam(spec, report);
}
