import { sqlite } from "@/db/client";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { directivesBlock, staffNotesText } from "@/lib/directives";
import { buildExamArtifact } from "@/lib/exam-latex";
import { refImageFor, visionBlock } from "@/lib/figrefs";
import { dueConcepts, markTested } from "@/lib/schedule";
import { referencePaths } from "@/lib/sources";
import { verifyAndHarden, type VerifyReport } from "@/lib/verify";
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
  const style = styleRows.slice(0, 12).map((r) => ({ src: r.src, excerpt: trunc(r.text, 1600) }));

  // CONTENU = tout le corpus, en priorité les séries d'exos + le reste (trimé pour la vitesse).
  const exercises = sampleByType(["exercise", "serie"], 550, 8);
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
  `      • Topologie réseau : appelle IMPÉRATIVEMENT la macro \\examtopo (topologie canonique 2-AS DÉJÀ dessinée et FIXE : AS1 = {$R_1,R_2$, SW1, cluster $A_1\\ldots A_{100}$, cluster $B_1\\ldots B_{10}$ avec $B_1$=DNS}, AS2 = {$R_3,R_4$, SW2, cluster $C_1\\ldots C_{100}$, cluster $D_1\\ldots D_{10}$ avec $D_1$=d1.epfl.ch}, interfaces orange e,f,g,h,i,j,k,l,m,p,q, coûts roses 5/10/1, débits verts 1G/100M/1G, cloud « Rest of the Internet » relié à $R_3$). NE dessine PAS de topologie à la main : utilise \\examtopo et ancre TES sous-questions (sous-réseaux, forwarding, longest-prefix, packet-trace ARP+DNS+TCP, Dijkstra/Bellman-Ford, délais) sur CES éléments fixes.`,
  `      • OS/FS : utilise les MACROS VERROUILLÉES (ne dessine PAS ces figures à la main) : \\examinode (inode v6 : addr[0..7], direct/single/double-indirect → index → data) ; \\begin{examproctree} ... \\end{examproctree} (nœuds \\node[pnode]{...}, flèches \\draw[forkarrow] = fork, \\draw[execarrow] = exec, étiquette programme + var=val) ; \\examstates (diagramme d'états Running/Ready/Blocked).`,
  `    Mets chaque figure dans \\begin{center}\\begin{tikzpicture}[node distance=1.2cm] ... \\end{tikzpicture}\\end{center}\\figcaption{Figure N: ...}. La géométrie doit être propre et lisible.`,
  `  - GRILLES DE RÉPONSE (OBLIGATOIRE) : APRÈS CHAQUE sous-question, émets son échafaudage de réponse PRÉ-DESSINÉ, dimensionné comme chez la prof — JAMAIS un simple blanc ni « Answers: » :`,
  `      • packet-trace (« list ALL packets seen at interface X », ARP + DNS + TCP) → \\packetgrid{12} (12-15 lignes).`,
  `      • simulation d'états de processus / scheduling → \\statesim{16} (15-20 lignes).`,
  `      • comptage d'accès disque / inode → \\diskgrid{8}.`,
  `      • décisions de forwarding / longest-prefix → \\forwardgrid{6}.`,
  `      • diagramme TCP → \\tcpladder{D_1}{A_1}{5 Kbytes}{1 MSS}{$\\infty$}{8} (échelle scaffoldée).`,
  `      • question ouverte / justification (V/F, « explain », « justify ») → \\rulelines{6}.`,
  `    Choisis la grille ET son nombre de lignes selon le type de sous-question. Chaque sous-question DOIT finir par sa grille.`,
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
    `Archétypes (en respectant les EXCLUSIONS) : Networking = TOPOLOGIE DENSE au niveau de la Figure 1 réelle (regarde data/refs/figref/topo_2024.png) : DEUX Autonomous Systems (AS1/AS2) avec un border router chacun, ~4 routeurs au total, 2-4 switches L2, PLUSIEURS clusters d'end-systems étiquetés (A1…A150, B1…B100, C1…C100, D1…D10), un serveur DNS (root/authoritative) ET un serveur web nommés, un cloud « Rest of the Internet ». COÛTS roses ET DÉBITS verts sur CHAQUE lien ; interfaces orange nommées sur CHAQUE port de routeur. Dessine chaque AS comme une RÉGION encadrée en POINTILLÉS étiquetée « AS1 »/« AS2 » (un rectangle ou un node[draw,dashed,fit=...] englobant ses routeurs+switches+clusters) ; note les grappes d'end-systems avec des points de suspension ($A_1 \\ldots A_{100}$). Layout propre et lisible (dense mais pas fouillis), pleine largeur, légende « Figure 1 ». Sur cette topologie : sous-réseaux & paquets (préfixes en PETIT, tableau des paquets/interfaces vus par un routeur), routage Dijkstra/Bellman-Ford, TCP (\\tcpladder : SEQ/ACK/cwnd/ssthresh/état + handshake, slow start, Tahoe/Reno, fast recovery), forwarding/longest-prefix (avec égalité piège), ARP, délais bout-en-bout (multi-saut, bottleneck). OS = accès disque & inodes (compter blocs par open/lseek/read/write, multi-level indexing, frontière direct/indirect piège), CPU scheduling (FIFO/SJF/STCF/RR/MLFQ, turnaround/response), états de processus, fork/exec/wait/waitpid (arbre de processus), kernel vs user (V/F à justifier). C = LIRE du code lab-style, reconnaître syscalls/fork/exec/wait/file descriptors (jamais écrire/débugger). Labs = lecture/compréhension de code des labs (client-serveur get_file/send_file/socket_layer, filesystem direntv6, multi-threading) — PAS « DKVS ».`,
    ``,
    `═══ LES VRAIS FINALS À IMITER (forme, types, ton, niveau, MISE EN PAGE) ═══`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ``,
    `═══ SCOPE OFFICIEL (Study Guide + hints staff — ne génère QUE sur ces sujets) ═══`,
    staffNotesText(5000),
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
    const verified = r ? r.verified : null;
    insQ.run(id, q.concept, q.statement_tex, q.solution_tex, q.source_inspiration ?? null, verified, r?.issue ?? null);
  });

  const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
  const { file } = await buildExamArtifact(spec, id, dateLabel);
  sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(file, id);
  if (report) {
    sqlite.prepare(`UPDATE exams SET verify_summary = ? WHERE id = ?`)
      .run(`ok=${report.ok} corrigés=${report.fixed} durcis=${report.regenerated} retirés=${report.removed} non-vérifiés=${report.unverified}`, id);
  }

  markTested([...spec.questions.map((q) => q.concept), ...dueConcepts(6)]);
  return { id, url: `/exam/${file}` };
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
  const prompt = [
    directivesBlock(),
    ``,
    `Regarde la vraie page de référence du même type : ${refImageFor(q.category, q.concept)} (outil Read), pour viser sa richesse/difficulté.`,
    ``,
    `Régénère UN SEUL exercice de Final CS-202 EN ANGLAIS, catégorie « ${q.category} », concept proche de « ${q.concept} », barème ${q.points} points.`,
    `La version précédente a ce PROBLÈME à corriger : ${diagnostic}`,
    `Applique le PRINCIPE DE CONSTRUCTION : UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS, au niveau de la vraie page.`,
    ``,
    LATEX_CONTRACT,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. statement_tex/solution_tex en LaTeX. Aucun fichier.`,
    JSON.stringify(ONE_EX_SCHEMA, null, 2),
  ].join("\n");
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 420_000 });
  const r = extractJson<ExamQuestion>(text);
  return { ...r, category: q.category, points: q.points };
}

/** Les 6 slots du Final (structure 2025) : catégorie, points, thèmes imposés au lot. */
const EXAM_SLOTS = [
  { category: "Networking", points: 50, brief: "Subnets / forwarding / longest-prefix (with a trap) / FULL packet-trace at a router interface (ARP + recursive DNS + TCP, \\packetgrid{12}) — anchored on the FIXED canonical topology \\examtopo (use its routers R1-R4, interfaces e-q, clusters A/B/C/D, B1=DNS, D1=d1.epfl.ch). The statement MUST start with \\examtopo." },
  { category: "Networking", points: 50, brief: "TCP on the canonical topology (no need to repeat the figure; refer to Figure 1): \\tcpladder diagram (slow start, Tahoe vs Reno, fast recovery, SEQ/ACK bookkeeping) + end-to-end delay computation across two links with a bottleneck and non-round numbers." },
  { category: "OS", points: 25, brief: "Disk access & inodes: multi-level indexing, count block accesses for an open/lseek/read/write sequence crossing the direct→single-indirect boundary (trap: sparse file / cache hit), \\diskgrid{8}. Optionally \\examinode figure." },
  { category: "OS", points: 30, brief: "Processes & CPU scheduling: ONE concrete program with fork/exec/wait (process tree via \\examproctree if helpful) + a multi-line state/scheduling simulation \\statesim{16} (FIFO/SJF/STCF/RR or MLFQ, turnaround/response, single-core, RR assumes no known durations) + a data race fixed by lock()/unlock() (max allowed concurrency).", },
  { category: "C", points: 10, brief: "READING lab-style C code (client socket code or file I/O): recognize syscalls, file descriptors, fork/exec/wait — never write/debug code. \\begin{lstlisting} with the code, then short questions with \\rulelines." },
  { category: "Labs", points: 15, brief: "A REAL lab artifact in READING: client-server get_file/send_file/socket_layer OR filesystem direntv6 inode walk. Recognize what the code does, trace a call, identify the syscalls involved." },
] as const;

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    questions: { type: "array", items: ONE_EX_SCHEMA },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

function buildBatchPrompt(ctx: ReturnType<typeof gatherContext>, slots: { category: string; points: number; brief: string }[]): string {
  return [
    directivesBlock(),
    ``,
    visionBlock(),
    ``,
    `Tu es l'équipe enseignante de CS-202 Computer Systems (EPFL). Tu rédiges ${slots.length} exercices INÉDITS, EN ANGLAIS, d'un « Final 2026 » indiscernable d'un vrai final EPFL.`,
    `PRINCIPE : chaque exercice = UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS.`,
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
    LATEX_CONTRACT,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {"questions":[{category,concept,statement_tex,solution_tex,points}, …]} — ${slots.length} exercices, dans l'ordre des slots. Aucun outil, aucun fichier, aucune prose.`,
    JSON.stringify(BATCH_SCHEMA, null, 2),
  ].join("\n");
}

const CKPT = path.join(process.cwd(), "data", "exams", ".gen-checkpoint.json");

async function generateBatch(ctx: ReturnType<typeof gatherContext>, slots: typeof EXAM_SLOTS[number][]): Promise<ExamQuestion[]> {
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
export async function generateExamViaClaudeCode(opts: { verify?: boolean } = {}): Promise<{ id: number; url: string }> {
  const t0 = Date.now();
  const ctx = gatherContext();
  const batches = [EXAM_SLOTS.slice(0, 3), EXAM_SLOTS.slice(3, 6)];

  // checkpoint : lots déjà générés lors d'un run précédent interrompu
  let saved: (ExamQuestion[] | null)[] = [null, null];
  try {
    const j = JSON.parse(fs.readFileSync(CKPT, "utf8"));
    if (Array.isArray(j?.batches) && Date.now() - (j.at ?? 0) < 2 * 3600_000) saved = j.batches;
  } catch {}

  const results = await Promise.all(
    batches.map(async (slots, i) => {
      if (saved[i]?.length === slots.length) {
        console.log(`[gen] lot ${i + 1}/2 repris du checkpoint`);
        return saved[i]!;
      }
      const qs = await generateBatch(ctx, slots as any);
      if (qs.length < slots.length) throw new Error(`Lot ${i + 1} incomplet (${qs.length}/${slots.length}).`);
      saved[i] = qs;
      try { fs.mkdirSync(path.dirname(CKPT), { recursive: true }); fs.writeFileSync(CKPT, JSON.stringify({ at: Date.now(), batches: saved })); } catch {}
      console.log(`[gen] lot ${i + 1}/2 ok (${Math.round((Date.now() - t0) / 1000)}s)`);
      return qs;
    })
  );

  let spec: ExamSpec = { title: "CS-202 Computer Systems — Final Exam", duration_min: 180, questions: results.flat() };
  let report: VerifyReport | undefined;
  if (opts.verify !== false) {
    try {
      const v = await verifyAndHarden(spec, regenerateExercise);
      spec = v.spec;
      report = v.report;
    } catch (e) {
      console.error("[verify] échec, examen conservé non vérifié :", (e as Error).message);
    }
  }
  const out = await persistExam(spec, report);
  try { fs.unlinkSync(CKPT); } catch {} // run complet → checkpoint consommé
  console.log(`[gen] total ${Math.round((Date.now() - t0) / 1000)}s`);
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

