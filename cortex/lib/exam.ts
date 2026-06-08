import { sqlite } from "@/db/client";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import { dueConcepts, markTested } from "@/lib/schedule";
import { search } from "@/lib/search";
import fs from "node:fs";
import path from "node:path";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");

export type ExamQuestion = {
  concept: string;
  statement_html: string;
  solution_html: string;
  source_inspiration?: string;
  difficulty?: number;
};
export type ExamSpec = { title: string; questions: ExamQuestion[] };

// ---------- Contexte de génération ----------
function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + " […]" : s;
}

function gatherContext() {
  const weaknesses = (
    sqlite
      .prepare(
        `SELECT topic, description FROM weaknesses ORDER BY severity DESC, datetime(logged_at) DESC LIMIT 8`
      )
      .all() as { topic: string; description: string | null }[]
  ).map((w) => ({ topic: w.topic, note: trunc(w.description ?? "", 600) }));

  const due = dueConcepts(6);

  // Style : UNIQUEMENT les 2 examens les plus récents (le format à imiter), en détail.
  const maxYear =
    (sqlite
      .prepare(`SELECT MAX(year) y FROM sources WHERE type IN ('final','midterm') AND year IS NOT NULL`)
      .get() as { y: number | null }).y ?? 2024;
  const styleRows = sqlite
    .prepare(
      `SELECT s.title src, i.text, i.images FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.type IN ('final','midterm') AND s.year >= ?
       ORDER BY s.year DESC, s.recency_weight DESC LIMIT 8`
    )
    .all(maxYear - 1) as { src: string; text: string; images: string | null }[];
  const style = styleRows.map((r) => ({ src: r.src, excerpt: trunc(r.text, 2400) }));
  const styleImages = [
    ...new Set(
      styleRows.flatMap((r) => {
        try {
          return r.images ? (JSON.parse(r.images) as string[]) : [];
        } catch {
          return [];
        }
      })
    ),
  ];

  // Matière de cours pertinente pour les sujets ciblés
  const seed = [...weaknesses.map((w) => w.topic), ...due].join(" ");
  const courseItems: { src: string; text: string }[] = [];
  for (const g of search(seed, 12, "or")) {
    for (const h of g.hits) {
      const row = sqlite.prepare(`SELECT text FROM items WHERE id = ?`).get(h.itemId) as
        | { text: string }
        | undefined;
      if (row) courseItems.push({ src: h.sourceTitle, text: trunc(row.text, 500) });
      if (courseItems.length >= 8) break;
    }
    if (courseItems.length >= 8) break;
  }

  return { weaknesses, due, style, styleImages, courseItems };
}

const EXAM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: { type: "string" },
          statement_html: { type: "string", description: "Énoncé en HTML simple (p, ul, code, pre)" },
          solution_html: { type: "string", description: "Corrigé détaillé en HTML simple" },
          source_inspiration: { type: "string", description: "D'où s'inspire la question (lecture/exam)" },
          difficulty: { type: "integer", description: "1 à 3" },
        },
        required: ["concept", "statement_html", "solution_html"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
} as const;

function buildPrompt(ctx: ReturnType<typeof gatherContext>): string {
  return [
    `Tu es le professeur du cours Computer Systems (CS202, EPFL). Tu rédiges un NOUVEL examen, inédit — surtout PAS une copie des anciens.`,
    `Objectif : 4 à 6 questions originales qui (1) ciblent en priorité MES faiblesses, (2) couvrent les concepts à revoir, (3) reproduisent EXACTEMENT le format des 2 examens les plus récents ci-dessous.`,
    ``,
    `MES FAIBLESSES (à mettre à l'épreuve avec de nouveaux énoncés) :`,
    ...(ctx.weaknesses.length ? ctx.weaknesses.map((w) => `- ${w.topic}${w.note ? " — " + w.note : ""}`) : ["(aucune enregistrée — couvre alors largement les concepts à revoir)"]),
    ``,
    `CONCEPTS À REVOIR (courbe de l'oubli) : ${ctx.due.join(" · ") || "(aucun)"}`,
    ``,
    `>>> FORMAT À REPRODUIRE — UNIQUEMENT les 2 examens les plus récents <<<`,
    `Calque la FORME CONCRÈTE de ces examens, pas seulement l'esthétique :`,
    `- la même structure (découpage en Problems / sous-questions a) b) c)…),`,
    `- les mêmes TYPES de questions (ex. tracer des paquets et remplir un tableau, accès disque inode/data blocks, reconvergence de routage, lecture/raisonnement sur du code C avec fork/pthread…),`,
    `- les mêmes schémas/diagrammes et tableaux à remplir quand l'original en a (recrée-les en HTML/ASCII, NE recopie PAS les images d'origine),`,
    `- le même niveau d'exigence. Mais des énoncés et des valeurs NOUVEAUX (pas de copie).`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ctx.styleImages.length ? `\n(Ces examens comportent des schémas/figures, ex. : ${ctx.styleImages.slice(0, 8).join(", ")} — prévois des schémas équivalents, recréés.)` : ``,
    ``,
    `MATIÈRE DE COURS PERTINENTE (ancre tes questions là-dessus, reste correct) :`,
    ...ctx.courseItems.map((c) => `- (${c.src}) ${c.text}`),
    ``,
    `Consignes : énoncés clairs et autonomes ; corrigés détaillés et pédagogiques (raisonnement étape par étape, pas juste la réponse) ; quand tu fais un tableau ou un schéma, utilise <pre> (ASCII) ou des <ul>/<table> ; HTML simple uniquement (<p>, <ul>, <li>, <code>, <pre>, <table>) ; pas de <script>/<style>. Réponds uniquement avec l'objet JSON demandé.`,
  ].join("\n");
}

async function callClaude(ctx: ReturnType<typeof gatherContext>): Promise<ExamSpec> {
  const stream = anthropic().messages.stream({
    model: GEN_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: EXAM_SCHEMA }, effort: "high" },
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  } as any);
  const msg: any = await stream.finalMessage();
  const text = msg.content.find((b: any) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text) as ExamSpec;
}

// Examen factice pour tester le rendu/DB/planning sans clé API.
function stubExam(ctx: ReturnType<typeof gatherContext>): ExamSpec {
  const w = ctx.weaknesses[0]?.topic ?? "fork / processus";
  const due = ctx.due[0] ?? "ordonnancement CPU";
  return {
    title: "Examen blanc Cortex (dry-run)",
    questions: [
      {
        concept: w,
        difficulty: 3,
        statement_html: `<p>[DRY-RUN] Question ciblant ta faiblesse : <strong>${w}</strong>.</p><p>Un vrai énoncé inédit apparaîtra ici une fois ta clé API en place.</p>`,
        solution_html: `<p>Corrigé détaillé généré par Claude (Opus 4.8) à partir du cours et de ta faiblesse.</p>`,
        source_inspiration: "faiblesse enregistrée",
      },
      {
        concept: due,
        difficulty: 2,
        statement_html: `<p>[DRY-RUN] Question de révision espacée sur : <strong>${due}</strong>.</p>`,
        solution_html: `<p>Corrigé étape par étape.</p>`,
        source_inspiration: "répétition espacée",
      },
    ],
  };
}

// ---------- Rendu HTML (esthétique des sites de révision) ----------
function renderExamHtml(spec: ExamSpec, id: number, dateLabel: string): string {
  const stars = (d?: number) => "★".repeat(Math.max(1, Math.min(3, d ?? 1)));
  const questions = spec.questions
    .map(
      (q, i) => `
    <section class="q">
      <div class="q-head">
        <span class="q-num">Q${i + 1}</span>
        <span class="q-concept">${q.concept}</span>
        <span class="q-diff">${stars(q.difficulty)}</span>
      </div>
      <div class="q-statement">${q.statement_html}</div>
      <details class="q-sol">
        <summary>Voir le corrigé</summary>
        <div class="q-sol-body">${q.solution_html}</div>
        ${q.source_inspiration ? `<p class="q-src">inspiré de : ${q.source_inspiration}</p>` : ""}
      </details>
    </section>`
    )
    .join("\n");

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${spec.title} — Cortex</title>
<style>
  :root{--bg:#1f1e1d;--bg2:#2a2927;--bg3:#353330;--ink:#e8e6df;--ink2:#a8a59c;--ink3:#6e6c66;
    --accent:#c58a4f;--soft:#6fa8d6;--tree:#4fb89b;--line:#3f3d39;--r:10px;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif;}
  .wrap{max-width:780px;margin:0 auto;padding:40px 24px 80px;}
  header h1{font-size:22px;margin:0 0 4px;}
  header .meta{color:var(--ink3);font-size:13px;margin-bottom:28px;}
  .q{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:18px;}
  .q-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
  .q-num{color:var(--accent);font-weight:700;font-size:13px;}
  .q-concept{font-weight:600;flex:1;}
  .q-diff{color:var(--accent);font-size:12px;}
  .q-statement code,.q-sol-body code{background:var(--bg3);color:var(--tree);padding:1px 5px;border-radius:4px;font-family:'SF Mono',Menlo,monospace;font-size:.92em;}
  .q-statement pre,.q-sol-body pre{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;}
  details.q-sol{margin-top:14px;border-top:1px dashed var(--line);padding-top:12px;}
  details.q-sol summary{cursor:pointer;color:var(--soft);font-size:14px;font-weight:600;list-style:none;}
  details.q-sol summary::-webkit-details-marker{display:none}
  details.q-sol summary::before{content:'▸ ';color:var(--accent);}
  details.q-sol[open] summary::before{content:'▾ ';}
  .q-sol-body{margin-top:10px;color:var(--ink);}
  .q-src{color:var(--ink3);font-size:12px;font-style:italic;margin-top:10px;}
  a{color:var(--soft)}
</style></head>
<body><div class="wrap">
  <header>
    <h1>${spec.title}</h1>
    <div class="meta">Cortex · examen généré #${id} · ${dateLabel} · CS202</div>
  </header>
  ${questions}
</div></body></html>`;
}

// ---------- Persistance ----------
export function listExams() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
    format_template TEXT, targeted_weakness_ids TEXT, html_path TEXT, status TEXT DEFAULT 'draft');`);
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.created_at, e.status, e.html_path,
              (SELECT count(*) FROM exam_questions q WHERE q.exam_id = e.id) nq
       FROM exams e ORDER BY datetime(e.created_at) DESC, e.id DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    questionCount: r.nq,
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
    const p = path.join(EXAM_DIR, path.basename(row.html_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/** Brief de génération destiné à Claude Code (moi) : tout le contexte + le format JSON attendu. */
export function buildBrief(): string {
  const ctx = gatherContext();
  return [
    buildPrompt(ctx),
    ``,
    `--- FORMAT DE SORTIE ATTENDU ---`,
    `Écris un fichier JSON valide conforme exactement à ce schéma (clés en anglais, contenu en français) :`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

/** Enregistre un examen rédigé (par Claude Code OU par l'API) : DB + HTML + répétition espacée. */
export function persistExam(spec: ExamSpec): { id: number; url: string } {
  if (!spec?.questions?.length) throw new Error("ExamSpec vide ou invalide (aucune question).");

  const weaknessIds = (sqlite.prepare(`SELECT id FROM weaknesses`).all() as { id: number }[]).map((r) => r.id);
  const id = sqlite
    .prepare(`INSERT INTO exams (format_template, targeted_weakness_ids, status) VALUES (?,?,?)`)
    .run("final", JSON.stringify(weaknessIds), "ready").lastInsertRowid as number;

  const insQ = sqlite.prepare(
    `INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration)
     VALUES (?,?,?,?,?)`
  );
  for (const q of spec.questions) {
    insQ.run(id, q.concept, q.statement_html, q.solution_html, q.source_inspiration ?? null);
  }

  fs.mkdirSync(EXAM_DIR, { recursive: true });
  const fileName = `exam-${id}.html`;
  const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
  fs.writeFileSync(path.join(EXAM_DIR, fileName), renderExamHtml(spec, id, dateLabel));
  sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(fileName, id);

  // Avance la répétition espacée : concepts couverts + concepts qui étaient dus
  markTested([...spec.questions.map((q) => q.concept), ...dueConcepts(6)]);

  return { id, url: `/exam/${fileName}` };
}

/** Voie API directe (optionnelle, payante) : rédige via Claude API puis enregistre. */
export async function generateExam(opts: { dry?: boolean } = {}): Promise<{ id: number; url: string }> {
  const spec = opts.dry ? stubExam(gatherContext()) : await callClaude(gatherContext());
  return persistExam(spec);
}
