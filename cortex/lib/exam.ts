import { sqlite } from "@/db/client";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { dueConcepts, markTested } from "@/lib/schedule";
import { search } from "@/lib/search";
import { referencePaths } from "@/lib/sources";
import fs from "node:fs";
import path from "node:path";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");

export type ExamQuestion = {
  concept: string;
  statement_html: string;
  solution_html: string;
  source_inspiration?: string;
  difficulty?: number;
  points?: number;
};
export type ExamSpec = { title: string; questions: ExamQuestion[]; duration_min?: number };

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

  // Style = le FORMAT à imiter. Priorité ABSOLUE aux examens que Ben a cochés comme
  // « références » (cf. page Sources) ; à défaut, repli sur les 2 examens les plus récents.
  const refs = referencePaths();
  let styleRows: { src: string; text: string; images: string | null }[];
  let styleSource: "selected" | "recent";
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(",");
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text, i.images FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.path IN (${placeholders})
         ORDER BY s.year DESC, s.recency_weight DESC LIMIT 14`
      )
      .all(...refs) as { src: string; text: string; images: string | null }[];
    styleSource = "selected";
  } else {
    const maxYear =
      (sqlite
        .prepare(`SELECT MAX(year) y FROM sources WHERE type IN ('final','midterm') AND year IS NOT NULL`)
        .get() as { y: number | null }).y ?? 2024;
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text, i.images FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.type IN ('final','midterm') AND s.year >= ?
         ORDER BY s.year DESC, s.recency_weight DESC LIMIT 8`
      )
      .all(maxYear - 1) as { src: string; text: string; images: string | null }[];
    styleSource = "recent";
  }
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

  return { weaknesses, due, style, styleImages, courseItems, styleSource };
}

const EXAM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    duration_min: { type: "integer", description: "Durée conseillée en minutes (ex. 120)" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: { type: "string" },
          statement_html: { type: "string", description: "Énoncé en HTML simple (p, ul, code, pre, table)" },
          solution_html: { type: "string", description: "Corrigé détaillé en HTML simple" },
          source_inspiration: { type: "string", description: "D'où s'inspire la question (lecture/exam)" },
          difficulty: { type: "integer", description: "1 à 3" },
          points: { type: "integer", description: "Barème de la question (ex. 8, 12, 20)" },
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
    ctx.styleSource === "selected"
      ? `>>> FORMAT À REPRODUIRE — les examens de RÉFÉRENCE que Ben a sélectionnés (les plus pertinents) <<<`
      : `>>> FORMAT À REPRODUIRE — UNIQUEMENT les 2 examens les plus récents <<<`,
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
    `Barème : attribue à chaque question un \`points\` réaliste (questions simples ~6-8, moyennes ~10-14, lourdes ~16-22) et une \`duration_min\` cohérente pour l'ensemble (typiquement 120). Le total doit ressembler à un vrai examen (≈ 60-100 points).`,
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
    duration_min: 120,
    questions: [
      {
        concept: w,
        difficulty: 3,
        points: 20,
        statement_html: `<p>[DRY-RUN] Problème ciblant ta faiblesse : <strong>${w}</strong>.</p><p>Considérez le code C suivant et répondez aux sous-questions (a)–(c). Un vrai énoncé inédit apparaîtra ici une fois ta clé API en place (ou via <code>npm run exam:brief</code> + Claude Code).</p><pre>int main(){ pid_t p = fork(); /* ... */ }</pre>`,
        solution_html: `<p>Corrigé détaillé, étape par étape, généré à partir du cours et de ta faiblesse.</p>`,
        source_inspiration: "faiblesse enregistrée",
      },
      {
        concept: due,
        difficulty: 2,
        points: 12,
        statement_html: `<p>[DRY-RUN] Problème de révision espacée sur : <strong>${due}</strong>. Remplissez le tableau ci-dessous.</p>`,
        solution_html: `<p>Corrigé étape par étape.</p>`,
        source_inspiration: "répétition espacée",
      },
    ],
  };
}

// ---------- Rendu HTML : un vrai papier d'examen EPFL, imprimable en PDF ----------
function questionPoints(q: ExamQuestion): number {
  return q.points ?? [6, 10, 16][Math.max(1, Math.min(3, q.difficulty ?? 2)) - 1];
}

function renderExamHtml(spec: ExamSpec, id: number, dateLabel: string): string {
  const total = spec.questions.reduce((s, q) => s + questionPoints(q), 0);
  const duration = spec.duration_min ?? 120;

  const problems = spec.questions
    .map((q, i) => {
      const pts = questionPoints(q);
      return `
    <section class="problem">
      <h2 class="problem-h">
        <span>Problème ${i + 1}</span>
        <span class="problem-topic">${q.concept}</span>
        <span class="problem-pts">${pts} pts</span>
      </h2>
      <div class="statement">${q.statement_html}</div>
      <div class="answer">
        <span class="answer-label">Réponse</span>
      </div>
    </section>`;
    })
    .join("\n");

  const solutions = spec.questions
    .map((q, i) => {
      const pts = questionPoints(q);
      return `
    <section class="sol">
      <h3 class="sol-h">Problème ${i + 1} — ${q.concept} <span class="problem-pts">${pts} pts</span></h3>
      <div class="sol-body">${q.solution_html}</div>
      ${q.source_inspiration ? `<p class="sol-src">Inspiré de : ${q.source_inspiration}</p>` : ""}
    </section>`;
    })
    .join("\n");

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${spec.title} — CS-202</title>
<style>
  :root{ --red:#FF0000; --ink:#1a1a1a; --ink2:#555; --line:#d0d0d0; --paper:#fff; }
  *{box-sizing:border-box}
  html{background:#e9e9ec;}
  body{margin:0;color:var(--ink);
    font:13.5px/1.5 "Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;}

  /* Barre d'outils (écran uniquement) */
  .toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:14px;
    padding:10px 18px;background:rgba(255,255,255,.85);backdrop-filter:blur(12px);
    border-bottom:1px solid var(--line);}
  .toolbar .sp{flex:1}
  .btn{display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;
    font-size:13px;font-weight:600;padding:8px 16px;border-radius:999px;background:#111;color:#fff;}
  .toolbar label{font-size:13px;color:var(--ink2);display:inline-flex;align-items:center;gap:6px;cursor:pointer}

  /* La feuille A4 */
  .sheet{background:var(--paper);max-width:21cm;margin:22px auto;padding:2cm 2cm 2.4cm;
    box-shadow:0 4px 24px rgba(0,0,0,.12);}

  .exam-head{border-bottom:2px solid var(--ink);padding-bottom:12px;margin-bottom:6px;}
  .exam-head .row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}
  .epfl{font-weight:700;letter-spacing:.02em;font-size:13px;}
  .epfl .bar{color:var(--red);}
  .school{color:var(--ink2);font-size:11px;margin-top:2px;}
  .course-code{text-align:right;font-size:12px;color:var(--ink2);}
  .course-code b{display:block;color:var(--ink);font-size:15px;letter-spacing:.04em;}
  h1.title{font-size:20px;margin:18px 0 2px;text-align:center;letter-spacing:-.01em;}
  .subtitle{text-align:center;color:var(--ink2);font-size:12.5px;margin-bottom:16px;}

  .candidate{display:flex;gap:24px;margin:14px 0 6px;font-size:12.5px;}
  .candidate .field{flex:1;border-bottom:1px solid #888;padding-bottom:3px;color:var(--ink2);}
  .instructions{border:1px solid var(--line);background:#fafafa;border-radius:6px;
    padding:12px 14px;font-size:12px;color:#333;margin:14px 0 24px;}
  .instructions b{color:var(--ink)}
  .instructions ul{margin:6px 0 0;padding-left:18px;}
  .instructions li{margin:2px 0}

  .problem{margin:0 0 22px;page-break-inside:avoid;}
  .problem-h{display:flex;align-items:baseline;gap:10px;font-size:15px;margin:0 0 8px;
    border-bottom:1px solid var(--line);padding-bottom:5px;}
  .problem-h>span:first-child{font-weight:700;}
  .problem-topic{flex:1;font-weight:400;color:var(--ink2);font-size:13px;}
  .problem-pts{font-weight:700;font-size:12px;color:var(--ink2);white-space:nowrap;}
  .statement{font-size:13px;}
  .statement p{margin:.5em 0}
  .statement code,.sol-body code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.9em;
    background:#f1f1f1;padding:1px 4px;border-radius:3px;}
  .statement pre,.sol-body pre{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;
    background:#f7f7f7;border:1px solid var(--line);border-radius:5px;padding:10px 12px;overflow:auto;line-height:1.45;}
  .statement table,.sol-body table{border-collapse:collapse;margin:8px 0;font-size:12px;}
  .statement th,.statement td,.sol-body th,.sol-body td{border:1px solid #999;padding:4px 9px;text-align:left;}
  .answer{margin-top:10px;min-height:84px;border:1px dashed #bbb;border-radius:5px;position:relative;
    background:repeating-linear-gradient(transparent,transparent 27px,#eee 27px,#eee 28px);}
  .answer-label{position:absolute;top:5px;left:8px;font-size:9.5px;text-transform:uppercase;
    letter-spacing:.08em;color:#bbb;}

  /* Corrigé */
  .solutions{page-break-before:always;border-top:2px solid var(--ink);margin-top:28px;padding-top:14px;}
  .solutions h2.corr-title{font-size:17px;margin:0 0 4px;}
  .solutions .corr-note{color:var(--ink2);font-size:12px;margin-bottom:18px;}
  .sol{margin-bottom:20px;page-break-inside:avoid;}
  .sol-h{font-size:13.5px;margin:0 0 6px;display:flex;gap:10px;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:4px;}
  .sol-h .problem-pts{margin-left:auto}
  .sol-body{font-size:12.5px;}
  .sol-src{color:var(--ink2);font-size:11px;font-style:italic;margin-top:8px;}

  .foot{margin-top:24px;text-align:center;color:#aaa;font-size:10px;}

  /* Masquage du corrigé (toggle) */
  body.hide-sol .solutions{display:none;}

  @media print{
    html,body{background:#fff;}
    .toolbar{display:none;}
    .sheet{box-shadow:none;margin:0;max-width:none;padding:0;}
    .answer{break-inside:avoid;}
  }
  @page{ size:A4; margin:1.6cm; }
</style></head>
<body>
  <div class="toolbar">
    <button class="btn" onclick="window.print()">🖨 Télécharger le PDF</button>
    <label><input type="checkbox" id="tsol" checked onchange="document.body.classList.toggle('hide-sol',!this.checked)"> inclure le corrigé</label>
    <span class="sp"></span>
    <span style="font-size:12px;color:#888">Cortex · examen #${id}</span>
  </div>

  <div class="sheet">
    <div class="exam-head">
      <div class="row">
        <div>
          <div class="epfl">EPFL <span class="bar">·</span> CS-202</div>
          <div class="school">School of Computer and Communication Sciences</div>
        </div>
        <div class="course-code">
          <b>Computer Systems</b>
          Examen · ${dateLabel}
        </div>
      </div>
    </div>

    <h1 class="title">${spec.title}</h1>
    <div class="subtitle">Durée : ${duration} minutes · Total : ${total} points · ${spec.questions.length} problèmes</div>

    <div class="candidate">
      <span class="field">Nom, Prénom :</span>
      <span class="field">SCIPER :</span>
    </div>

    <div class="instructions">
      <b>Consignes.</b>
      <ul>
        <li>Documents autorisés : une feuille A4 manuscrite recto-verso. Pas de calculatrice.</li>
        <li>Justifiez chaque réponse ; une réponse non justifiée ne rapporte aucun point.</li>
        <li>Répondez dans l'espace prévu sous chaque problème. Le barème est indiqué à droite.</li>
      </ul>
    </div>

    ${problems}

    <div class="solutions">
      <h2 class="corr-title">Corrigé</h2>
      <p class="corr-note">Décoche « inclure le corrigé » ci-dessus pour imprimer l'examen seul, puis te corriger ensuite.</p>
      ${solutions}
    </div>

    <div class="foot">Généré par Cortex à partir de ton corpus CS-202 · examen blanc inédit</div>
  </div>
</body></html>`;
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

/** Prompt pour Claude Code (headless) : le brief complet + sortie JSON stricte (aucun outil/fichier). */
function buildClaudeCodePrompt(ctx: ReturnType<typeof gatherContext>): string {
  return [
    buildPrompt(ctx),
    ``,
    `--- SORTIE ATTENDUE ---`,
    `Réponds UNIQUEMENT avec un objet JSON valide conforme EXACTEMENT à ce schéma (clés en anglais, contenu en français).`,
    `N'écris aucun fichier, n'utilise aucun outil, n'ajoute aucune prose ni balise markdown autour : juste l'objet JSON.`,
    JSON.stringify(EXAM_SCHEMA, null, 2),
  ].join("\n");
}

/** Voie gratuite (abonnement Max) : rédige via Claude Code en sous-processus puis enregistre. */
export async function generateExamViaClaudeCode(): Promise<{ id: number; url: string }> {
  const text = await runClaudeCode({
    prompt: buildClaudeCodePrompt(gatherContext()),
    model: "opus",
    timeoutMs: 280_000,
  });
  const spec = extractJson<ExamSpec>(text);
  return persistExam(spec);
}
