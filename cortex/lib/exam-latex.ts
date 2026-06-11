import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";

const LATEX_DIR = path.join(process.cwd(), "latex");
const EXAM_DIR = path.join(process.cwd(), "data", "exams");

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
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.30\textwidth}\vspace{0pt}\epfllogo[30]\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.64\textwidth}\vspace{2pt}\raggedleft\footnotesize\scshape`,
    String.raw`École Polytechnique Fédérale de Lausanne\\ Eidgenössische Technische Hochschule -- Lausanne\\ Politecnico Federale -- Losanna\\ Swiss Federal Institute of Technology -- Lausanne\end{minipage}`,
    String.raw`\vspace{2pt}\noindent\rule{\textwidth}{1pt}`,
    String.raw`\noindent\begin{minipage}[t]{0.7\textwidth}\vspace{0pt}\footnotesize\textbf{Faculté Informatique et Communications}\\ CS--202 Computer Systems\\ Argyraki K., Kashyap S. \& Chappelier J.-C.\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.25\textwidth}\vspace{0pt}\raggedleft\footnotesize Anonymisation:\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{10pt}\noindent\normalsize NOM : Hanon Ymous \quad(000000)\hfill\textbf{Seat \#:} 0`,
    String.raw`\vspace{0.5cm}\begin{center}{\Large\textbf{CS--202 COMPUTER SYSTEMS}}\\[6pt]{\large\textbf{Final Exam}}\\[5pt]${footDate(dateLabel)}\end{center}`,
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
        (q as any).statement_tex ?? "",
      ].join("\n")
    )
    .join("\n\n");

  const solutions = [
    String.raw`\clearpage{\Large\textbf{Corrigé}}\par\vspace{6pt}\hrule\medskip`,
    ...qs.map((q, i) =>
      [
        String.raw`\par\medskip\needspace{4\baselineskip}{\large\textbf{Question ${i + 1} — ${texEscape(q.concept)} \hfill [${qPoints(q)} points]}}\par\smallskip`,
        (q as any).solution_tex ?? "",
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

/** Compile <base>.tex (déjà écrit dans EXAM_DIR) en <base>.pdf. Renvoie le nom du PDF ou throw. */
export async function compileExamPdf(base: string): Promise<string> {
  const tex = `${base}.tex`;
  const pdf = `${base}.pdf`;
  const pdfAbs = path.join(EXAM_DIR, pdf);
  let lastErr = "Aucun moteur LaTeX trouvé (installe tectonic : brew install tectonic).";
  for (const { bin, kind } of texCandidates()) {
    try {
      if (kind === "tectonic") {
        const r = await spawnP(bin, ["--chatter", "minimal", "--keep-logs", tex], EXAM_DIR, 240_000);
        if (r.code === 0 && fs.existsSync(pdfAbs)) return pdf;
        lastErr = tailLog(base) || r.err || `tectonic code ${r.code}`;
      } else {
        // pdflatex : 2 passes (header/page refs)
        const a = ["-interaction=nonstopmode", "-halt-on-error", tex];
        const r1 = await spawnP(bin, a, EXAM_DIR, 120_000);
        if (r1.code === 0) await spawnP(bin, a, EXAM_DIR, 120_000);
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
  const log = path.join(EXAM_DIR, `${base}.log`);
  if (!fs.existsSync(log)) return "";
  const txt = fs.readFileSync(log, "utf8");
  const lines = txt.split("\n").filter((l) => /^!|error|Undefined|Runaway/i.test(l));
  return lines.slice(0, 8).join(" | ").slice(0, 800);
}

/** Repli HTML lisible si la compilation LaTeX échoue (rare). */
export function htmlFallback(spec: ExamSpec, id: number, dateLabel: string): string {
  const esc = (s: string) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const qs = [...spec.questions].sort((a, b) => catRank(a.category) - catRank(b.category));
  const blocks = qs
    .map((q, i) => `<section><h2>Question ${i + 1} — ${esc(q.concept)} [${qPoints(q)} points]</h2>
      <pre>${esc((q as any).statement_tex ?? "")}</pre>
      <details><summary>Corrigé</summary><pre>${esc((q as any).solution_tex ?? "")}</pre></details></section>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${esc(spec.title)}</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:20px}h2{font-size:15px;border-top:1px solid #ddd;padding-top:14px}pre{white-space:pre-wrap;background:#f6f6f7;padding:10px;border-radius:8px;font-size:12px}
.warn{background:#fff3e0;border:1px solid #e0a96d;padding:10px 14px;border-radius:8px}</style>
<h1>${esc(spec.title)}</h1>
<p class="warn">⚠️ La compilation LaTeX (PDF) a échoué — voici le contenu brut. Installe <code>tectonic</code> (brew install tectonic) pour le vrai PDF EPFL.</p>
${blocks}`;
}

/** Construit les artefacts : PDF examen SEUL (mode mock) + PDF corrigé ; HTML de repli sinon. */
export async function buildExamArtifact(spec: ExamSpec, id: number, dateLabel: string): Promise<{ file: string; kind: "pdf" | "html" }> {
  fs.mkdirSync(EXAM_DIR, { recursive: true });
  const base = `exam-${id}`;
  // copie un éventuel logo officiel pour la compilation
  for (const ext of ["pdf", "png"]) {
    const src = path.join(LATEX_DIR, `epfl-logo.${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(EXAM_DIR, `epfl-logo.${ext}`));
  }
  // 1) examen seul (corrigé caché — mode mock) ; 2) version corrigée
  fs.writeFileSync(path.join(EXAM_DIR, `${base}.tex`), renderExamTex(spec, dateLabel, false));
  fs.writeFileSync(path.join(EXAM_DIR, `${base}-corrige.tex`), renderExamTex(spec, dateLabel, true));
  try {
    const pdf = await compileExamPdf(base);
    try { await compileExamPdf(`${base}-corrige`); } catch (e) {
      console.error(`[exam] corrigé #${id} non compilé :`, (e as Error).message);
    }
    return { file: pdf, kind: "pdf" };
  } catch (e) {
    const html = `${base}.html`;
    fs.writeFileSync(path.join(EXAM_DIR, html), htmlFallback(spec, id, dateLabel));
    console.error(`[exam] compilation LaTeX échouée pour #${id} → repli HTML :`, (e as Error).message);
    return { file: html, kind: "html" };
  }
}
