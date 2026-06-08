import { sqlite } from "@/db/client";
import { anthropic, GEN_MODEL } from "@/lib/anthropic";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { dueConcepts, markTested } from "@/lib/schedule";
import { referencePaths } from "@/lib/sources";
import fs from "node:fs";
import path from "node:path";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");

export type ExamQuestion = {
  concept: string;
  category?: string; // 'Networking' | 'OS' | 'C' | 'Project'
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
    if (n >= 2) continue; // max 2 extraits par source → diversité
    perSrc.set(r.src, n + 1);
    out.push({ src: r.src, text: trunc(r.text, perItem) });
    if (out.length >= maxItems) break;
  }
  return out;
}

function gatherContext() {
  // Faiblesses : en RETRAIT pour l'instant (légère inflexion seulement).
  const weaknesses = (
    sqlite
      .prepare(`SELECT topic, description FROM weaknesses ORDER BY severity DESC, datetime(logged_at) DESC LIMIT 6`)
      .all() as { topic: string; description: string | null }[]
  ).map((w) => ({ topic: w.topic, note: trunc(w.description ?? "", 400) }));

  const due = dueConcepts(8);

  // FORMAT = les vrais finals cochés en référence (priorité absolue). Sinon repli récents.
  const refs = referencePaths();
  let styleRows: { src: string; text: string }[];
  let styleSource: "selected" | "recent";
  if (refs.length) {
    const ph = refs.map(() => "?").join(",");
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.path IN (${ph}) AND length(i.text) > 120
         ORDER BY s.year DESC, RANDOM() LIMIT 18`
      )
      .all(...refs) as { src: string; text: string }[];
    styleSource = "selected";
  } else {
    styleRows = sqlite
      .prepare(
        `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.type IN ('final','midterm') ORDER BY s.year DESC, RANDOM() LIMIT 12`
      )
      .all() as { src: string; text: string }[];
    styleSource = "recent";
  }
  const style = styleRows.map((r) => ({ src: r.src, excerpt: trunc(r.text, 1900) }));

  // CONTENU = tout le corpus, en priorité les séries d'exos + le reste.
  const exercises = sampleByType(["exercise", "serie"], 650, 12);
  const reviews = sampleByType(["review"], 360, 10); // reviews de lectures = concepts flagués prof
  const staff = sampleByType(["note", "doc"], 700, 4); // attendus du staff
  const cheats = sampleByType(["cheatsheet"], 450, 4);
  const course = sampleByType(["course_pdf"], 360, 6);

  return { weaknesses, due, style, styleSource, exercises, reviews, staff, cheats, course };
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
          statement_html: { type: "string", description: "Énoncé COMPLET avec sous-questions N.M [pts], énumérateurs ➀➁➂, code/tableaux en <pre>. HTML simple." },
          solution_html: { type: "string", description: "Corrigé détaillé étape par étape, par sous-question." },
          source_inspiration: { type: "string", description: "D'où vient l'inspiration (final/série/lecture)" },
          points: { type: "integer", description: "Barème total de l'exercice (ex. 50, 30, 25, 15, 10)" },
        },
        required: ["category", "concept", "statement_html", "solution_html", "points"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
} as const;

function buildPrompt(ctx: ReturnType<typeof gatherContext>): string {
  const block = (title: string, items: { src: string; excerpt?: string; text?: string }[]) =>
    items.length ? [``, title, ...items.map((c) => `• (${c.src}) ${c.excerpt ?? c.text}`)] : [];
  return [
    `Tu es l'équipe enseignante de CS-202 Computer Systems à l'EPFL (Argyraki, Kashyap, Chappelier).`,
    `Tu rédiges le FINAL de l'an prochain : un « Final 2026 » INÉDIT qui doit être INDISCERNABLE d'un vrai final EPFL. Un étudiant qui le voit doit dire « ça aurait pu tomber tel quel ».`,
    ``,
    `═══ RÈGLE D'OR : LE FORMAT VIENT EXACTEMENT DES FINALS 2024 & 2025 FOURNIS ═══`,
    `Structure imposée : 6 exercices indépendants, notés séparément, regroupés par catégorie :`,
    `  • Networking : 2 exercices (gros, ~50 pts chacun)`,
    `  • OS : 2 exercices (~25 et ~30 pts)`,
    `  • C : 1 exercice (~10 pts)`,
    `  • Project : 1 exercice (~15 pts)`,
    `Total ≈ 180 points, durée 3 heures (duration_min = 180).`,
    `Chaque exercice a un thème puis des SOUS-QUESTIONS « N.M – Titre [Y points] » (mets-les en <h4>).`,
    `À l'intérieur : énumérateurs ➀ ➁ ➂ ➃, listes « On vous donne : » (<ul>), options a) b) c) d), code en <code>/<pre>.`,
    ``,
    `═══ TYPES DE QUESTIONS : SURTOUT APPLIQUÉ ET QUANTITATIF (PAS de pur « définissez X ») ═══`,
    `Networking : sous-réseaux & paquets (assigner des préfixes IP de taille minimale, REMPLIR un tableau des paquets/interfaces vus par un routeur), encapsulation (qui ajoute quel header à quelle couche), routage (reconvergence type Bellman-Ford après panne de lien), TCP (séquence/ACK, slow start / congestion control).`,
    `OS : mémoire virtuelle↔physique (CALCULER à partir de bits VPN/PFN/offset, taille de page, nb d'entrées de page table), accès disque & inodes (COMPTER les blocs lus/écrits par une séquence open/write/lseek/read), ordonnancement (MLFQ, états des processus), syscalls kernel vs user (Vrai/Faux à JUSTIFIER), fork/exec/wait, threads/locks/data races.`,
    `C : LIRE et TRACER du code C (que vaut le buffer après ces appels ? combien de processus créés ? quelle sortie ?), pointeurs, layout mémoire.`,
    `Project : question liée aux labs (inode walk / file system / etc.).`,
    `Chaque exercice doit demander de CALCULER / TRACER / REMPLIR UN TABLEAU / JUSTIFIER, avec des valeurs numériques concrètes et NOUVELLES. Au plus 1 petite sous-question conceptuelle par exercice.`,
    ``,
    `═══ LES VRAIS FINALS À IMITER (forme, types, ton, niveau) ═══`,
    ...ctx.style.map((s) => `### ${s.src}\n${s.excerpt}`),
    ...block(`═══ SÉRIES D'EXERCICES & EXOS (la matière d'entraînement — inspire-toi des mécaniques, pas du copier-coller) ═══`, ctx.exercises),
    ...block(`═══ REVIEWS DE LECTURES / CONCEPTS FLAGUÉS IMPORTANTS ═══`, ctx.reviews),
    ...block(`═══ ATTENDUS DU STAFF ═══`, ctx.staff),
    ...block(`═══ CHEAT SHEETS ═══`, ctx.cheats),
    ...block(`═══ COURS (slides) ═══`, ctx.course),
    ``,
    `(léger) Si pertinent, glisse une difficulté sur mes points faibles : ${ctx.weaknesses.length ? ctx.weaknesses.map((w) => w.topic).join(" · ") : "(aucun pour l'instant — couvre alors largement le programme)"}.`,
    `Concepts à ne pas oublier (révision espacée) : ${ctx.due.join(" · ") || "(aucun)"}.`,
    ``,
    `═══ POUR CHAQUE EXERCICE, FOURNIS ═══`,
    `- category : « Networking » | « OS » | « C » | « Project »`,
    `- concept : titre court (ex. « Subnets and packets », « Virtual vs physical memory »)`,
    `- points : barème total de l'exercice`,
    `- statement_html : énoncé COMPLET, autonome, avec sous-questions <h4>N.M – Titre [Y points]</h4>, énumérateurs ➀➁➂, tableaux/schémas en <pre> ASCII, code en <pre>/<code>. HTML simple uniquement (<p>,<h4>,<ul>,<ol>,<li>,<code>,<pre>,<table>,<strong>,<em>). PAS d'images.`,
    `- solution_html : corrigé détaillé étape par étape (valeurs, raisonnement, points par sous-question).`,
    ``,
    `Rédige en français ; le vocabulaire technique peut rester en anglais (comme dans les vrais examens). Réponds uniquement avec l'objet JSON.`,
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

// Examen factice pour tester le rendu/DB sans IA.
function stubExam(ctx: ReturnType<typeof gatherContext>): ExamSpec {
  return {
    title: "CS-202 Computer Systems — Final Exam (dry-run)",
    duration_min: 180,
    questions: [
      {
        category: "Networking",
        concept: "Subnets and packets",
        points: 50,
        statement_html: `<p>[DRY-RUN] Considérez la topologie suivante (deux AS reliés par des routeurs de bord).</p><h4>1.1 – IP subnets [20 points]</h4><p>➀ Identifiez tous les sous-réseaux. ➁ Parmi les scénarios a)–d), un seul convient : lequel et pourquoi ?</p><h4>1.2 – Packets [30 points]</h4><p>Remplissez le tableau des paquets vus par R3.</p><pre>| Interface | Src IP | Dst IP |\n|-----------|--------|--------|\n|     ?     |   ?    |   ?    |</pre>`,
        solution_html: `<p>Corrigé détaillé (un vrai énoncé apparaît avec la génération réelle via Max).</p>`,
      },
      {
        category: "OS",
        concept: "Virtual vs physical memory",
        points: 30,
        statement_html: `<p>[DRY-RUN] Pour chaque scénario, calculez la mémoire physique adressable.</p><h4>3.1 – Memory accesses [12 points]</h4><p>On vous donne : taille de frame 256 octets, VPN 10 bits…</p>`,
        solution_html: `<p>Corrigé étape par étape.</p>`,
      },
    ],
  };
}

// ---------- Rendu HTML : réplique fidèle du papier d'examen EPFL CS-202 ----------
const CAT_ORDER = ["Networking", "OS", "C", "Project"];
function catRank(c?: string) {
  const i = CAT_ORDER.indexOf(c ?? "");
  return i < 0 ? CAT_ORDER.length : i;
}
function questionPoints(q: ExamQuestion): number {
  return q.points ?? [6, 10, 16][Math.max(1, Math.min(3, q.difficulty ?? 2)) - 1];
}

/** Faux QR-code déterministe (esthétique de l'anonymisation EPFL). */
function qrSvg(seed: number): string {
  let s = (seed >>> 0) || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  const N = 21, c = 4;
  let r = `<rect width="${N * c}" height="${N * c}" fill="#fff"/>`;
  const finder = (x: number, y: number) => {
    r += `<rect x="${x * c}" y="${y * c}" width="${7 * c}" height="${7 * c}"/>`;
    r += `<rect x="${(x + 1) * c}" y="${(y + 1) * c}" width="${5 * c}" height="${5 * c}" fill="#fff"/>`;
    r += `<rect x="${(x + 2) * c}" y="${(y + 2) * c}" width="${3 * c}" height="${3 * c}"/>`;
  };
  finder(0, 0); finder(N - 7, 0); finder(0, N - 7);
  const inF = (x: number, y: number) => (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (inF(x, y)) continue;
    if (rnd() > 0.5) r += `<rect x="${x * c}" y="${y * c}" width="${c}" height="${c}"/>`;
  }
  return `<svg viewBox="0 0 ${N * c} ${N * c}" xmlns="http://www.w3.org/2000/svg" fill="#000">${r}</svg>`;
}

function gradingTable(qs: ExamQuestion[]): string {
  // groupes de catégories consécutives
  const groups: { cat: string; span: number }[] = [];
  for (const q of qs) {
    const cat = q.category ?? "Autre";
    const last = groups[groups.length - 1];
    if (last && last.cat === cat) last.span++;
    else groups.push({ cat, span: 1 });
  }
  const total = qs.reduce((s, q) => s + questionPoints(q), 0);
  const groupCells = groups.map((g) => `<td colspan="${g.span}" class="gt-cat">${g.cat}</td>`).join("");
  const qCells = qs.map((_, i) => `<td>Question ${i + 1}</td>`).join("");
  const ptCells = qs.map((q) => `<td>${questionPoints(q)}</td>`).join("");
  const emptyCells = qs.map(() => `<td></td>`).join("");
  return `<table class="grading">
    <tr><td colspan="${qs.length + 1}" class="gt-title">LEAVE THIS EMPTY</td></tr>
    <tr class="gt-cats">${groupCells}<td rowspan="2" class="gt-total">TOTAL</td></tr>
    <tr class="gt-q">${qCells}</tr>
    <tr class="gt-pts">${ptCells}<td>${total}</td></tr>
    <tr class="gt-blank">${emptyCells}<td></td></tr>
  </table>`;
}

function renderExamHtml(spec: ExamSpec, id: number, dateLabel: string): string {
  const qs = [...spec.questions].sort((a, b) => catRank(a.category) - catRank(b.category));
  const total = qs.reduce((s, q) => s + questionPoints(q), 0);
  const duration = spec.duration_min ?? 180;
  const qr = qrSvg(id * 7919 + 13);

  const problems = qs
    .map((q, i) => {
      const pts = questionPoints(q);
      const space = Math.min(22, Math.max(9, pts * 0.42)); // espace réponse ∝ barème
      return `
    <section class="problem">
      <h2 class="q-head">Question ${i + 1} <span class="q-dash">–</span> ${q.concept} <span class="q-pts">[${pts} points]</span></h2>
      <div class="statement">${q.statement_html}</div>
      <p class="ans-label">Answers and justifications:</p>
      <div class="answer" style="min-height:${space}cm"></div>
    </section>`;
    })
    .join("\n");

  const solutions = qs
    .map((q, i) => `
    <section class="sol">
      <h3 class="sol-h">Question ${i + 1} — ${q.concept} <span class="q-pts">[${questionPoints(q)} points]</span></h3>
      <div class="sol-body">${q.solution_html}</div>
      ${q.source_inspiration ? `<p class="sol-src">Inspiré de : ${q.source_inspiration}</p>` : ""}
    </section>`)
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${spec.title}</title>
<style>
  @import url('https://fonts.cdnfonts.com/css/cmu-serif');
  :root{ --red:#e30613; --ink:#000; --line:#000; }
  *{box-sizing:border-box}
  html{background:#d8d8db;}
  body{margin:0;color:var(--ink);
    font-family:'CMU Serif','Latin Modern Roman','Times New Roman',Georgia,serif;
    font-size:12pt;line-height:1.32;}

  /* Barre d'outils (écran seulement) */
  .toolbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;
    padding:9px 16px;background:rgba(20,20,22,.92);color:#fff;font-family:system-ui,sans-serif;}
  .toolbar .sp{flex:1}
  .btn{display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;font-size:13px;
    font-weight:600;padding:8px 15px;border-radius:999px;background:#fff;color:#111;}
  .toolbar label{font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;opacity:.9}

  .epfl{color:var(--red);font-family:Arial,Helvetica,sans-serif;font-weight:800;letter-spacing:-1px;}

  /* Feuilles A4 */
  .sheet{background:#fff;width:21cm;min-height:29.7cm;margin:20px auto;padding:1.7cm 1.9cm 2cm;
    box-shadow:0 3px 18px rgba(0,0,0,.18);position:relative;}

  /* —— Page de garde —— */
  .cover-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;
    border-bottom:1.5px solid var(--ink);padding-bottom:8px;}
  .cover-head .epfl{font-size:34px;line-height:1;}
  .inst{font-variant:small-caps;font-size:9.5pt;line-height:1.25;text-align:left;letter-spacing:.02em;}
  .faculty{font-size:9.5pt;margin:6px 0 0;}
  .faculty b{font-weight:700;}
  .cand{display:flex;justify-content:space-between;align-items:flex-start;margin:16px 0 4px;font-size:11pt;}
  .cand .qr{width:2.6cm;height:2.6cm;}
  .seat{margin-top:6px;font-weight:700;}
  .title-block{text-align:center;margin:34px 0 6px;}
  .title-block .t1{font-size:19pt;font-weight:700;letter-spacing:.02em;}
  .title-block .t2{font-size:17pt;font-weight:700;margin-top:6px;}
  .title-block .t3{font-size:12pt;margin-top:6px;}
  .instr h3{font-size:13pt;margin:26px 0 8px;}
  .instr ol{margin:0;padding-left:20px;}
  .instr li{margin:5px 0;}
  .grading{border-collapse:collapse;width:100%;margin:18px 0 0;text-align:center;font-size:10.5pt;}
  .grading td{border:1px solid var(--ink);padding:4px 3px;}
  .gt-title{font-weight:700;letter-spacing:.06em;border:1px solid var(--ink);}
  .gt-cat,.gt-total{font-weight:700;}
  .gt-blank td{height:34px;}

  /* —— Questions —— */
  .problem{page-break-before:always;padding-top:4px;}
  .q-head{font-size:14pt;font-weight:700;margin:0 0 12px;}
  .q-head .q-dash{font-weight:400;}
  .q-head .q-pts{font-weight:700;}
  .statement{font-size:11.5pt;}
  .statement p{margin:.5em 0;text-align:justify;}
  .statement h4{font-size:12pt;font-weight:700;margin:16px 0 6px;}
  .statement ul,.statement ol{margin:.4em 0;padding-left:22px;}
  .statement li{margin:3px 0;}
  .statement code,.sol-body code{font-family:'Courier New',monospace;font-size:.93em;}
  .statement pre,.sol-body pre{font-family:'Courier New',monospace;font-size:10pt;line-height:1.3;
    border:1px solid var(--ink);padding:8px 10px;overflow:auto;white-space:pre;background:#fff;margin:8px 0;}
  .statement table,.sol-body table{border-collapse:collapse;margin:8px 0;font-size:10.5pt;}
  .statement th,.statement td,.sol-body th,.sol-body td{border:1px solid var(--ink);padding:3px 8px;}
  .ans-label{font-weight:700;margin:14px 0 0;}
  .answer{border-top:1px solid transparent;}

  /* —— En-tête / pied récurrents + marge (impression) —— */
  .runhead,.runfoot,.bindmargin{display:none;}
  .runfoot .epfl{font-size:15px;}
  .corner-note{display:none;}

  /* —— Corrigé —— */
  .solutions{page-break-before:always;}
  .solutions .corr-title{font-size:16pt;font-weight:700;border-bottom:1.5px solid var(--ink);padding-bottom:6px;}
  .solutions .corr-note{font-size:10.5pt;font-style:italic;margin:8px 0 18px;}
  .sol{margin-bottom:18px;page-break-inside:avoid;}
  .sol-h{font-size:12.5pt;font-weight:700;border-bottom:1px solid #999;padding-bottom:4px;}
  .sol-body{font-size:11pt;}
  .sol-src{font-size:9.5pt;font-style:italic;color:#444;margin-top:6px;}
  body.hide-sol .solutions{display:none;}

  @media print{
    html,body{background:#fff;}
    .toolbar{display:none;}
    .sheet{width:auto;min-height:0;margin:0;padding:0;box-shadow:none;}
    .problem,.solutions{page-break-before:always;}
    /* en-tête + pied + marge répétés sur chaque page */
    .runfoot{display:flex;position:fixed;left:1.4cm;right:1.4cm;bottom:0.7cm;
      align-items:center;justify-content:space-between;border-top:1px solid var(--ink);
      padding-top:3px;font-size:9.5pt;}
    .runfoot .mid{text-align:center;font-weight:700;}
    .bindmargin{display:block;position:fixed;right:0.18cm;top:35%;
      writing-mode:vertical-rl;transform:rotate(180deg);font-size:9pt;letter-spacing:.05em;}
  }
  @page{ size:A4; margin:1.6cm 1.7cm 2.1cm; }
</style></head>
<body>
  <div class="toolbar">
    <button class="btn" onclick="window.print()">🖨 Télécharger le PDF</button>
    <label><input type="checkbox" id="tsol" checked onchange="document.body.classList.toggle('hide-sol',!this.checked)"> inclure le corrigé</label>
    <span class="sp"></span>
    <span style="font-size:12px;opacity:.7">Cortex · examen #${id}</span>
  </div>

  <!-- éléments récurrents (impression) -->
  <div class="runfoot">
    <span class="epfl">EPFL</span>
    <span class="mid">CS-202, Final Exam – IN &amp; SC<br><span style="font-weight:400">${spec.title}</span></span>
    <span>${dateLabel}</span>
  </div>
  <div class="bindmargin">Do NOT write anything here!</div>

  <div class="sheet">
    <!-- PAGE DE GARDE -->
    <div class="cover-head">
      <span class="epfl">EPFL</span>
      <div class="inst">
        École Polytechnique Fédérale de Lausanne<br>
        Eidgenössische Technische Hochschule – Lausanne<br>
        Politecnico Federale – Losanna<br>
        Swiss Federal Institute of Technology – Lausanne
      </div>
    </div>
    <p class="faculty"><b>Faculté Informatique et Communications</b><br>CS–202 Computer Systems<br>Argyraki K., Kashyap S. &amp; Chappelier J.-C.</p>

    <div class="cand">
      <div>
        NOM : ______________________ ( ______ )
        <div class="seat">Seat #: _____</div>
      </div>
      <div class="qr">${qr}</div>
    </div>

    <div class="title-block">
      <div class="t1">CS–202 COMPUTER SYSTEMS</div>
      <div class="t2">Final Exam</div>
      <div class="t3">${dateLabel}</div>
    </div>

    <div class="instr">
      <h3>INSTRUCTIONS (please read carefully)</h3>
      <p><b>IMPORTANT!</b> Please strictly follow these instructions, otherwise your exam may be canceled.</p>
      <ol>
        <li>You have three hours to complete this examination.</li>
        <li>You must <b>use black or dark blue ink</b>, neither pencil nor any other color.</li>
        <li>This is a closed book exam. Personal notes, four times dual-sided A4 sheets (8 sides in total), allowed. You may not use any personal computer, mobile phone or any other electronic equipment.</li>
        <li>Answer the questions directly on the exam sheet; only this document will be graded.</li>
        <li>Carefully and <em>completely</em> read each question so as to do only what we actually ask for.</li>
        <li>The exam consists of six independent exercises, which can be addressed in any order, but which do not score the same (points are indicated, the total is ${total} points); all exercises count for the final grade.</li>
      </ol>
      ${gradingTable(qs)}
    </div>

    ${problems}

    <div class="solutions">
      <div class="corr-title">Corrigé</div>
      <p class="corr-note">Décoche « inclure le corrigé » en haut pour imprimer l'examen seul, puis te corriger ensuite.</p>
      ${solutions}
    </div>
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
    timeoutMs: 560_000,
  });
  const spec = extractJson<ExamSpec>(text);
  return persistExam(spec);
}
