import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";
import { examsDir } from "@/lib/paths";

const LATEX_DIR = path.join(process.cwd(), "latex");

const CAT_ORDER = ["Networking", "OS", "C", "Project"];
const catRank = (c?: string) => {
  const i = CAT_ORDER.indexOf(c ?? "");
  return i < 0 ? CAT_ORDER.length : i;
};
const qPoints = (q: ExamQuestion) => q.points ?? 10;

/** Échappe le texte BRUT (titres, concepts) pour LaTeX. NE PAS appliquer au LaTeX du modèle. */
function texEscape(s: string): string {
  return (s ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/**
 * \examinode et \examstates ouvrent déjà leur propre center+tikzpicture : si le
 * générateur les emballe dans un tikzpicture (et/ou un center) manuel, l'imbrication
 * de tikzpicture est fatale à la compilation → on déballe la figure.
 */
function unwrapLockedFigures(t: string): string {
  const FIG = String.raw`\\(?:examinode|examstates)\b`;
  return t
    .replace(new RegExp(String.raw`\\begin\{tikzpicture\}(?:\[[^\]]*\])?\s*(${FIG})\s*\\end\{tikzpicture\}`, "g"), "$1")
    .replace(new RegExp(String.raw`\\begin\{center\}\s*(${FIG})\s*\\end\{center\}`, "g"), "$1")
    // glyphes Unicode que le modèle émet parfois et que pdflatex ne connaît pas (vécu : corrigé
    // exam-14 cassé par ✓/✗). Translittération minimale — amssymb est dans le préambule.
    .replace(/[✓✔]/g, String.raw`\ensuremath{\checkmark}`)
    .replace(/[✗✘✕]/g, String.raw`\ensuremath{\times}`);
}

function footDate(dateLabel: string): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (!m) return texEscape(dateLabel);
  const y = m[1], mo = months[+m[2] - 1] ?? "", d = +m[3];
  return String.raw`${mo} ${d}\textsuperscript{th}, ${y}`;
}

function gradingTableTex(qs: ExamQuestion[]): string {
  const groups: { cat: string; span: number }[] = [];
  for (const q of qs) {
    const cat = q.category ?? "Autre";
    const last = groups[groups.length - 1];
    if (last && last.cat === cat) last.span++;
    else groups.push({ cat, span: 1 });
  }
  const total = qs.reduce((s, q) => s + qPoints(q), 0);
  const cols = "|" + "c|".repeat(qs.length + 1);
  const groupRow = groups.map((g) => String.raw`\multicolumn{${g.span}}{c|}{\textbf{${texEscape(g.cat)}}}`).join(" & ");
  const qRow = qs.map((_, i) => `Question ${i + 1}`).join(" & ");
  const ptsRow = qs.map((q) => String(qPoints(q))).join(" & ");
  const emptyRow = qs.map(() => "").join(" & ");
  return [
    String.raw`\begin{center}\renewcommand{\arraystretch}{1.4}\small`,
    String.raw`\begin{tabular}{${cols}}\hline`,
    String.raw`\multicolumn{${qs.length + 1}}{|c|}{\textbf{LEAVE THIS EMPTY}}\\\hline`,
    String.raw`${groupRow} & \multirow{2}{*}{\textbf{TOTAL}}\\\cline{1-${qs.length}}`,
    String.raw`${qRow} & \\\hline`,
    String.raw`${ptsRow} & ${total}\\\hline`,
    String.raw`${emptyRow} & \\[0.55cm]\hline`,
    String.raw`\end{tabular}\end{center}`,
  ].join("\n");
}

function coverTex(spec: ExamSpec, qs: ExamQuestion[], dateLabel: string): string {
  const total = qs.reduce((s, q) => s + qPoints(q), 0);
  const dur = spec.duration_min ?? 180;
  const hours = Math.round(dur / 60);
  // métadonnées du cours courant (cs-202 reproduit le texte historique à l'identique)
  const c = getCourse(currentCourse());
  const examCodeTex = c.examCode.replace(/-/g, "--"); // « CS-202 » → « CS--202 » (en-dash LaTeX)
  const uniLines = c.universityLines.join("\\\\ ");
  const profsTex = c.profs.length
    ? c.profs.slice(0, -1).join(", ") + (c.profs.length > 1 ? " \\& " : "") + c.profs[c.profs.length - 1]
    : "";
  const facultyLine = [`\\textbf{${c.faculty}}`, `${examCodeTex} ${c.examName}`, profsTex].filter(Boolean).join("\\\\ ");
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.30\textwidth}\vspace{0pt}\epfllogo[30]\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.64\textwidth}\vspace{2pt}\raggedleft\footnotesize\scshape`,
    `${uniLines}\\end{minipage}`,
    String.raw`\vspace{2pt}\noindent\rule{\textwidth}{1pt}`,
    `\\noindent\\begin{minipage}[t]{0.7\\textwidth}\\vspace{0pt}\\footnotesize${facultyLine}\\end{minipage}\\hfill`,
    String.raw`\begin{minipage}[t]{0.25\textwidth}\vspace{0pt}\raggedleft\footnotesize Anonymisation:\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{10pt}\noindent\normalsize NOM : Hanon Ymous \quad(000000)\hfill\textbf{Seat \#:} 0`,
    `\\vspace{0.5cm}\\begin{center}{\\Large\\textbf{${examCodeTex} ${c.examName.toUpperCase()}}}\\\\[6pt]{\\large\\textbf{${c.examKind}}}\\\\[5pt]${footDate(dateLabel)}\\end{center}`,
    String.raw`\vspace{0.25cm}\noindent{\large\textbf{INSTRUCTIONS (please read carefully)}}\par\smallskip`,
    String.raw`\noindent\textbf{IMPORTANT!} Please strictly follow these instructions, otherwise your exam may be canceled.`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{2pt}`,
    String.raw`\item You have ${hours} hours to complete this examination.`,
    String.raw`\item You must \textbf{use black or dark blue ink}, neither pencil nor any other color.`,
    String.raw`\item This is a closed book exam. Personal notes, four times dual-sided A4 sheets (8 sides in total), are allowed. You may not use any personal computer, mobile phone or any other electronic equipment.`,
    String.raw`\item Answer the questions \textbf{directly on the exam sheet}, in the space provided; do not use your own paper.`,
    String.raw`\item Carefully and \emph{completely} read each question so as to do only what we actually ask for. If a statement seems unclear, ask one of the assistants for clarification.`,
    String.raw`\item The exam consists of ${qs.length} independent exercises (points are indicated, the total is ${total} points); all exercises count for the final grade.`,
    String.raw`\end{enumerate}`,
    String.raw`\vspace{0.25cm}`,
    gradingTableTex(qs),
  ].join("\n");
}

/** Construit le source .tex complet à partir d'un ExamSpec (corrigé en annexe optionnel). */
export function renderExamTex(spec: ExamSpec, dateLabel: string, includeSolutions = true): string {
  const qs = [...spec.questions].sort((a, b) => catRank(a.category) - catRank(b.category));
  let preamble = fs.readFileSync(path.join(LATEX_DIR, "preamble.tex"), "utf8");
  const figPath = path.join(LATEX_DIR, "figures.tex");
  if (fs.existsSync(figPath)) preamble += "\n" + fs.readFileSync(figPath, "utf8");

  const body = qs
    .map((q, i) =>
      [
        String.raw`\examq{${i + 1}}{${texEscape(q.concept)}}{${qPoints(q)}}`,
        // l'énoncé contient lui-même les grilles de réponse (\packetgrid, \statesim, …) par sous-question
        unwrapLockedFigures((q as any).statement_tex ?? ""),
      ].join("\n")
    )
    .join("\n\n");

  const solutions = [
    String.raw`\clearpage{\Large\textbf{Corrigé}}\par\vspace{6pt}\hrule\medskip`,
    ...qs.map((q, i) =>
      [
        String.raw`\par\medskip\needspace{4\baselineskip}{\large\textbf{Question ${i + 1} — ${texEscape(q.concept)} \hfill [${qPoints(q)} points]}}\par\smallskip`,
        unwrapLockedFigures((q as any).solution_tex ?? ""),
      ].join("\n")
    ),
  ].join("\n\n");

  return [
    preamble,
    String.raw`\newcommand{\FOOTDATE}{${footDate(dateLabel)}}`,
    String.raw`\begin{document}`,
    coverTex(spec, qs, dateLabel),
    body,
    includeSolutions ? solutions : "",
    String.raw`\end{document}`,
  ].join("\n");
}

// ---------------- Compilation ----------------
function spawnP(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd });
    } catch (e: any) {
      return reject(Object.assign(new Error(String(e?.message ?? e)), { enoent: e?.code === "ENOENT" }));
    }
    let err = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Compilation LaTeX : timeout.")); }, timeoutMs);
    child.on("error", (e: any) => { clearTimeout(t); reject(Object.assign(new Error(String(e?.message ?? e)), { enoent: e?.code === "ENOENT" })); });
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", () => {});
    child.on("close", (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

function texCandidates(): { bin: string; kind: "tectonic" | "pdflatex" }[] {
  const home = os.homedir();
  const c: { bin: string; kind: "tectonic" | "pdflatex" }[] = [];
  if (process.env.CORTEX_TEX_BIN) c.push({ bin: process.env.CORTEX_TEX_BIN, kind: process.env.CORTEX_TEX_BIN.includes("tectonic") ? "tectonic" : "pdflatex" });
  for (const p of ["tectonic", "/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic", path.join(home, ".cargo/bin/tectonic"), path.join(home, ".local/bin/tectonic")])
    c.push({ bin: p, kind: "tectonic" });
  for (const p of ["pdflatex", "/Library/TeX/texbin/pdflatex", "/usr/bin/pdflatex", "/usr/local/bin/pdflatex", "/opt/homebrew/bin/pdflatex"])
    c.push({ bin: p, kind: "pdflatex" });
  return c;
}

/** Compile <base>.tex (déjà écrit dans examsDir()) en <base>.pdf. Renvoie le nom du PDF ou throw. */
/** Un moteur LaTeX (tectonic ou pdflatex) est-il disponible ? (pré-check). */
export function texAvailable(): boolean {
  for (const { bin } of texCandidates()) {
    if (bin.includes("/")) { try { if (fs.existsSync(bin)) return true; } catch {} }
    else {
      for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
        try { if (d && fs.existsSync(path.join(d, bin))) return true; } catch {}
      }
    }
  }
  return false;
}

export async function compileExamPdf(base: string): Promise<string> {
  const tex = `${base}.tex`;
  const pdf = `${base}.pdf`;
  const pdfAbs = path.join(examsDir(), pdf);
  let lastErr = "Aucun moteur LaTeX trouvé (installe tectonic : brew install tectonic).";
  for (const { bin, kind } of texCandidates()) {
    try {
      if (kind === "tectonic") {
        const r = await spawnP(bin, ["--chatter", "minimal", "--keep-logs", tex], examsDir(), 240_000);
        if (r.code === 0 && fs.existsSync(pdfAbs)) return pdf;
        lastErr = tailLog(base) || r.err || `tectonic code ${r.code}`;
      } else {
        // pdflatex : 2 passes (header/page refs)
        const a = ["-interaction=nonstopmode", "-halt-on-error", tex];
        const r1 = await spawnP(bin, a, examsDir(), 120_000);
        if (r1.code === 0) await spawnP(bin, a, examsDir(), 120_000);
        if (fs.existsSync(pdfAbs) && r1.code === 0) return pdf;
        lastErr = tailLog(base) || `pdflatex code ${r1.code}`;
      }
    } catch (e: any) {
      if (e?.enoent) continue; // binaire absent → essaie le suivant
      lastErr = String(e?.message ?? e);
    }
  }
  throw new Error(`Échec compilation LaTeX. ${lastErr}`);
}

function tailLog(base: string): string {
  const log = path.join(examsDir(), `${base}.log`);
  if (!fs.existsSync(log)) return "";
  const txt = fs.readFileSync(log, "utf8");
  const lines = txt.split("\n").filter((l) => /^!|error|Undefined|Runaway/i.test(l));
  return lines.slice(0, 8).join(" | ").slice(0, 800);
}

// ---------------- Repli HTML LISIBLE (quand la compilation LaTeX échoue) ----------------

const escHtml = (s: string) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Remplace \cmd{...} (accolades ÉQUILIBRÉES, contenu nestable) par wrap(contenu). */
function replaceBalanced(src: string, cmd: string, wrap: (inner: string) => string): string {
  const needle = cmd + "{";
  let out = "";
  let i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) return out + src.slice(i);
    out += src.slice(i, k);
    let depth = 0;
    let end = -1;
    for (let p = k + cmd.length; p < src.length; p++) {
      if (src[p] === "{") depth++;
      else if (src[p] === "}" && --depth === 0) { end = p; break; }
    }
    if (end < 0) return out + src.slice(k);
    out += wrap(src.slice(k + cmd.length + 1, end));
    i = end + 1;
  }
}

const CIRCLED = "⓪①②③④⑤⑥⑦⑧⑨";

/**
 * Convertit le LaTeX du modèle en HTML basique LISIBLE. Repli best-effort (PAS un rendu
 * fidèle) : code en <pre>, gras/italique/code inline, listes, sous-questions en titres,
 * notes à la place des figures/grilles. Le vrai rendu reste le PDF.
 */
export function texToHtml(tex: string): string {
  let t = tex ?? "";
  const stash: string[] = [];
  const NUL = String.fromCharCode(0); // sentinelle impossible dans du LaTeX, survit a escHtml -> zero collision
  const keep = (html: string) => `${NUL}${stash.push(html) - 1}${NUL}`;

  // blocs préservés (code, tableaux) ou remplacés par une note (figures/grilles non rendables en HTML)
  t = t.replace(/\\begin\{lstlisting\}(?:\[[^\]]*\])?\n?([\s\S]*?)\\end\{lstlisting\}/g, (_, c) => keep(`<pre class="code">${escHtml(c.replace(/\s+$/, ""))}</pre>`));
  t = t.replace(/\\begin\{verbatim\}\n?([\s\S]*?)\\end\{verbatim\}/g, (_, c) => keep(`<pre class="code">${escHtml(c.replace(/\s+$/, ""))}</pre>`));
  t = t.replace(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/g, (m) => keep(`<pre class="tab">${escHtml(m)}</pre>`));
  t = t.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, () => keep(`<div class="fig">⬚ figure TikZ — visible uniquement dans le PDF</div>`));
  t = t.replace(/\\begin\{examproctree\}[\s\S]*?\\end\{examproctree\}/g, () => keep(`<div class="fig">⬚ arbre de processus (fork/exec) — visible uniquement dans le PDF</div>`));
  t = t.replace(/\\tcpladder(\{[^{}]*\}){0,6}/g, () => keep(`<div class="fig">⬚ diagramme TCP en échelle (window/cwnd/ssthresh/état + handshake) — à tracer sur papier</div>`));
  t = t.replace(/\\examtopo\b/g, () => keep(`<div class="fig">⬚ Figure : topologie canonique 2-AS (R1–R4, SW1/SW2, clusters A/B/C/D, B1=DNS, D1=d1.epfl.ch, coûts/débits, cloud Internet)</div>`));
  t = t.replace(/\\examinode\b/g, () => keep(`<div class="fig">⬚ Figure : inode v6 (addr[0..7], single/double-indirect → index → data)</div>`));
  t = t.replace(/\\examstates\b/g, () => keep(`<div class="fig">⬚ Figure : états de processus (Running/Ready/Blocked + transitions)</div>`));
  t = t.replace(/\\(packetgrid|statesim|diskgrid|forwardgrid|rulelines)\{(\d+)\}/g, (_, k, n) => keep(`<div class="grid">✎ grille de réponse (${k}, ${n} lignes) — réponds sur papier</div>`));
  t = t.replace(/\\\$/g, () => keep("$")); // dollar littéral ≠ délimiteur math

  // échappe le texte courant
  t = escHtml(t);

  // macros inline
  t = t.replace(/\\subq\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}/g, `<h3>$1 — $2 <span class="pts">[$3 pts]</span></h3>`);
  for (let pass = 0; pass < 3; pass++) {
    t = replaceBalanced(t, "\\callout", (x) => `<div class="callout">${x}</div>`);
    t = replaceBalanced(t, "\\textbf", (x) => `<b>${x}</b>`);
    t = replaceBalanced(t, "\\textit", (x) => `<i>${x}</i>`);
    t = replaceBalanced(t, "\\emph", (x) => `<i>${x}</i>`);
    t = replaceBalanced(t, "\\texttt", (x) => `<code>${x}</code>`);
    t = replaceBalanced(t, "\\underline", (x) => `<u>${x}</u>`);
    t = replaceBalanced(t, "\\figcaption", (x) => `<p class="caption">${x}</p>`);
  }
  t = t.replace(/\\cn\{(\d)\}/g, (_, d) => CIRCLED[+d] ?? `(${d})`);

  // math inline : $...$ → italique + exposants/indices/symboles basiques
  t = t.replace(/\$([^$]+)\$/g, (_, m: string) =>
    `<em>${m
      .replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>")
      .replace(/_\{([^}]*)\}/g, "<sub>$1</sub>")
      .replace(/\^(\w)/g, "<sup>$1</sup>")
      .replace(/_(\w)/g, "<sub>$1</sub>")
      .replace(/\\(ldots|dots|cdots)/g, "…")
      .replace(/\\infty/g, "∞")
      .replace(/\\times/g, "×")
      .replace(/\\(rightarrow|to)\b/g, "→")
      .replace(/\\le\b/g, "≤")
      .replace(/\\ge\b/g, "≥")
      .replace(/\\,/g, " ")}</em>`
  );

  // listes & structure
  t = t.replace(/\\begin\{itemize\}(\[[^\]]*\])?/g, "<ul>").replace(/\\end\{itemize\}/g, "</ul>");
  t = t.replace(/\\begin\{enumerate\}(\[[^\]]*\])?/g, "<ol>").replace(/\\end\{enumerate\}/g, "</ol>");
  t = t.replace(/\\item\s*/g, "<li>");
  t = t.replace(/\\begin\{center\}/g, '<div class="center">').replace(/\\end\{center\}/g, "</div>");

  // nettoyage final
  t = t.replace(/\\(hline|cline\{[^}]*\}|hfill|noindent|par\b|smallskip|medskip|bigskip|clearpage|newpage|centering|raggedright)/g, " ");
  t = t.replace(/\\rule\{[^}]*\}\{[^}]*\}/g, "________");
  t = t.replace(/\\(vspace|hspace|needspace)\*?\{[^}]*\}/g, " ");
  t = t.replace(/\\\\(\[[^\]]*\])?/g, "<br>");
  t = t.replace(/\\(quad|qquad|;|,|!)/g, " ");
  t = t.replace(/\\&/g, "&amp;").replace(/\\([%#_])/g, "$1").replace(/\\textbackslash\{?\}?/g, "\\");
  t = t.replace(/~/g, " ");
  t = t.replace(/\\ldots/g, "…");
  // macro inconnue : garde l'argument, puis retire les commandes nues et accolades restantes
  for (let pass = 0; pass < 2; pass++) t = t.replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, "$1");
  t = t.replace(/\\[a-zA-Z]+\*?/g, "");
  t = t.replace(/[{}]/g, "");
  t = t.replace(/\n{2,}/g, "<br><br>");

  // blocs préservés réinjectés
  t = t.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_, i) => stash[+i]);
  return t;
}

/** Repli HTML LISIBLE si la compilation LaTeX échoue : plus de LaTeX source brut. */
export function htmlFallback(spec: ExamSpec, id: number, dateLabel: string, reason?: string): string {
  const qs = [...spec.questions].sort((a, b) => catRank(a.category) - catRank(b.category));
  const blocks = qs
    .map(
      (q, i) => `<section>
<h2>Question ${i + 1} — ${escHtml(q.concept)} <span class="pts">[${qPoints(q)} points]</span></h2>
<div class="stmt">${texToHtml((q as any).statement_tex ?? "")}</div>
<details><summary>Corrigé</summary><div class="sol">${texToHtml((q as any).solution_tex ?? "")}</div></details>
</section>`
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${escHtml(spec.title)}</title>
<style>
body{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:840px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:21px}h2{font-size:16px;border-top:1px solid #ddd;padding-top:16px;margin-top:22px}h3{font-size:14px;margin:16px 0 4px}
.pts{color:#8a6d3b;font-weight:600;font-size:12px}
pre{white-space:pre-wrap;background:#f6f6f7;padding:10px;border-radius:8px;font-size:12.5px;overflow-x:auto}
code{background:#f2f2f3;padding:1px 5px;border-radius:5px;font-size:.92em}
.fig,.grid{background:#f0f4fa;border:1px dashed #9db4d0;color:#3a5a80;padding:8px 12px;border-radius:8px;margin:10px 0;font-size:13px}
.callout{border:1.5px solid #1d1d1f;padding:8px 14px;margin:12px auto;text-align:center;max-width:85%}
.caption{text-align:center;font-size:12.5px;color:#666;margin:4px 0 12px}
.center{text-align:center}
.warn{background:#fff3e0;border:1px solid #e0a96d;padding:10px 14px;border-radius:8px;font-size:13.5px}
details{margin:8px 0}summary{cursor:pointer;color:#2563eb;font-size:13px}
.sol{border-left:3px solid #cfe3cf;padding-left:12px;margin-top:6px}
ul,ol{margin:6px 0 6px 22px}
</style>
<h1>${escHtml(spec.title)}</h1>
<p class="warn">⚠️ La compilation LaTeX (PDF) a échoué — rendu HTML lisible de secours (figures/grilles remplacées par des notes).${
    reason ? `<br><b>Erreur LaTeX :</b> <code>${escHtml(reason.slice(0, 300))}</code>` : ""
  }<br>Pour le vrai PDF EPFL : <code>brew install tectonic</code>, redémarre l'app, régénère.</p>
${blocks}`;
}

/** Rendu d'UN exercice ciblé : page d'exo SANS garde / en-tête EPFL / barème (juste l'énoncé). */
export function renderExerciseLatex(q: ExamQuestion, dateLabel: string, includeSolutions = true): string {
  let preamble = fs.readFileSync(path.join(LATEX_DIR, "preamble.tex"), "utf8");
  const figPath = path.join(LATEX_DIR, "figures.tex");
  if (fs.existsSync(figPath)) preamble += "\n" + fs.readFileSync(figPath, "utf8");
  const pts = qPoints(q);
  const sol = includeSolutions
    ? [String.raw`\clearpage{\large\textbf{Solution}}\par\vspace{6pt}\hrule\medskip`, unwrapLockedFigures((q as any).solution_tex ?? "")].join("\n")
    : "";
  return [
    preamble,
    String.raw`\newcommand{\FOOTDATE}{${footDate(dateLabel)}}`,
    String.raw`\examchromefalse\pagestyle{empty}`,
    String.raw`\begin{document}`,
    String.raw`\noindent{\large\textbf{Exercise \quad-- ${texEscape(q.concept)} \hfill [${pts} points]}}\par\vspace{4pt}\hrule\vspace{10pt}`,
    unwrapLockedFigures((q as any).statement_tex ?? ""),
    sol,
    String.raw`\end{document}`,
  ].join("\n");
}

export type ArtifactResult = { file: string; kind: "pdf" | "html"; texError?: string };

/** Construit l'artefact d'UN exercice ciblé : PDF énoncé (sans corrigé) + PDF corrigé, sans garde. */
export async function buildExerciseArtifact(q: ExamQuestion, id: number, dateLabel: string): Promise<ArtifactResult> {
  fs.mkdirSync(examsDir(), { recursive: true });
  const base = `exam-${id}`;
  for (const ext of ["pdf", "png"]) {
    const src = path.join(LATEX_DIR, `epfl-logo.${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(examsDir(), `epfl-logo.${ext}`));
  }
  fs.writeFileSync(path.join(examsDir(), `${base}.tex`), renderExerciseLatex(q, dateLabel, false));
  fs.writeFileSync(path.join(examsDir(), `${base}-corrige.tex`), renderExerciseLatex(q, dateLabel, true));
  try {
    const pdf = await compileExamPdf(base);
    try { await compileExamPdf(`${base}-corrige`); } catch (e) { console.error(`[exo] corrigé #${id} non compilé :`, (e as Error).message); }
    return { file: pdf, kind: "pdf" };
  } catch (e) {
    const msg = (e as Error).message;
    const html = `${base}.html`;
    fs.writeFileSync(path.join(examsDir(), html), htmlFallback({ title: q.concept, questions: [q] } as ExamSpec, id, dateLabel, msg));
    console.error(`[exo] compilation LaTeX échouée pour #${id} → repli HTML lisible :`, msg);
    return { file: html, kind: "html", texError: msg };
  }
}

/** Construit les artefacts : PDF examen SEUL (mode mock) + PDF corrigé ; HTML lisible de repli sinon. */
export async function buildExamArtifact(spec: ExamSpec, id: number, dateLabel: string): Promise<ArtifactResult> {
  fs.mkdirSync(examsDir(), { recursive: true });
  const base = `exam-${id}`;
  // copie un éventuel logo officiel pour la compilation
  for (const ext of ["pdf", "png"]) {
    const src = path.join(LATEX_DIR, `epfl-logo.${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(examsDir(), `epfl-logo.${ext}`));
  }
  // 1) examen seul (corrigé caché — mode mock) ; 2) version corrigée
  fs.writeFileSync(path.join(examsDir(), `${base}.tex`), renderExamTex(spec, dateLabel, false));
  fs.writeFileSync(path.join(examsDir(), `${base}-corrige.tex`), renderExamTex(spec, dateLabel, true));
  try {
    const pdf = await compileExamPdf(base);
    try { await compileExamPdf(`${base}-corrige`); } catch (e) {
      console.error(`[exam] corrigé #${id} non compilé :`, (e as Error).message);
    }
    return { file: pdf, kind: "pdf" };
  } catch (e) {
    const msg = (e as Error).message;
    const html = `${base}.html`;
    fs.writeFileSync(path.join(examsDir(), html), htmlFallback(spec, id, dateLabel, msg));
    console.error(`[exam] compilation LaTeX échouée pour #${id} → repli HTML lisible :`, msg);
    return { file: html, kind: "html", texError: msg };
  }
}
