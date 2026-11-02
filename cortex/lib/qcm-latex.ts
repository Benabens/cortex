import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { compileExamPdf } from "@/lib/exam-latex";
import { assertTexSafe } from "@/lib/tex-guard";
import { getFormatProfile } from "@/lib/format";
import { examsDir } from "@/lib/paths";
import type { QcmItem } from "@/lib/qcm";
import fs from "node:fs";
import path from "node:path";

/**
 * Rendu PDF d'un examen QCM + partie ouverte, au LOOK d'un vrai final du cours (ici CS-233 :
 * garde EPFL/lecturer/SCIPER, « First part: multiple/single choice » avec cases à cocher, points
 * par question, puis partie ouverte avec espace de réponse). Générique (course-aware via getCourse).
 * NE TOUCHE PAS au rendu CS-202 (fichier séparé, réutilise seulement preamble + compileExamPdf).
 */
const LATEX_DIR = path.join(process.cwd(), "latex");

// Unicode math → LaTeX (pdflatex ne gère pas l'UTF-8 math ; tectonic oui mais absent ici).
const UMATH: [RegExp, string][] = [
  [/[α]/g, "\\ensuremath{\\alpha}"], [/[β]/g, "\\ensuremath{\\beta}"], [/[γ]/g, "\\ensuremath{\\gamma}"], [/[δ]/g, "\\ensuremath{\\delta}"], [/[Δ]/g, "\\ensuremath{\\Delta}"],
  [/[ε]/g, "\\ensuremath{\\epsilon}"], [/[ζ]/g, "\\ensuremath{\\zeta}"], [/[η]/g, "\\ensuremath{\\eta}"], [/[θ]/g, "\\ensuremath{\\theta}"], [/[λ]/g, "\\ensuremath{\\lambda}"],
  [/[μ]/g, "\\ensuremath{\\mu}"], [/[ν]/g, "\\ensuremath{\\nu}"], [/[ξ]/g, "\\ensuremath{\\xi}"], [/[π]/g, "\\ensuremath{\\pi}"], [/[ρ]/g, "\\ensuremath{\\rho}"],
  [/[σ]/g, "\\ensuremath{\\sigma}"], [/[Σ]/g, "\\ensuremath{\\Sigma}"], [/[τ]/g, "\\ensuremath{\\tau}"], [/[φ]/g, "\\ensuremath{\\phi}"], [/[Φ]/g, "\\ensuremath{\\Phi}"],
  [/[χ]/g, "\\ensuremath{\\chi}"], [/[ψ]/g, "\\ensuremath{\\psi}"], [/[ω]/g, "\\ensuremath{\\omega}"], [/[Ω]/g, "\\ensuremath{\\Omega}"],
  [/[∂]/g, "\\ensuremath{\\partial}"], [/[∇]/g, "\\ensuremath{\\nabla}"], [/[∞]/g, "\\ensuremath{\\infty}"], [/[√]/g, "\\ensuremath{\\sqrt{\\ }}"],
  [/[∑]/g, "\\ensuremath{\\sum}"], [/[∏]/g, "\\ensuremath{\\prod}"], [/[∈]/g, "\\ensuremath{\\in}"], [/[∉]/g, "\\ensuremath{\\notin}"], [/[∩]/g, "\\ensuremath{\\cap}"], [/[∪]/g, "\\ensuremath{\\cup}"],
  [/[≤]/g, "\\ensuremath{\\le}"], [/[≥]/g, "\\ensuremath{\\ge}"], [/[≠]/g, "\\ensuremath{\\neq}"], [/[≈]/g, "\\ensuremath{\\approx}"], [/[≡]/g, "\\ensuremath{\\equiv}"],
  [/[×]/g, "\\ensuremath{\\times}"], [/[÷]/g, "\\ensuremath{\\div}"], [/[·∙]/g, "\\ensuremath{\\cdot}"], [/[±]/g, "\\ensuremath{\\pm}"], [/[∝]/g, "\\ensuremath{\\propto}"],
  [/[→]/g, "\\ensuremath{\\to}"], [/[⇒]/g, "\\ensuremath{\\Rightarrow}"], [/[←]/g, "\\ensuremath{\\leftarrow}"], [/[↦]/g, "\\ensuremath{\\mapsto}"],
  [/[‖]/g, "\\ensuremath{\\|}"], [/[⟨]/g, "\\ensuremath{\\langle}"], [/[⟩]/g, "\\ensuremath{\\rangle}"], [/[∀]/g, "\\ensuremath{\\forall}"], [/[∃]/g, "\\ensuremath{\\exists}"],
  [/²/g, "\\textsuperscript{2}"], [/³/g, "\\textsuperscript{3}"], [/¹/g, "\\textsuperscript{1}"],
  [/½/g, "\\ensuremath{\\frac12}"], [/¼/g, "\\ensuremath{\\frac14}"], [/[⁻]/g, "\\ensuremath{^{-}}"], [/[ℝ]/g, "\\ensuremath{\\mathbb{R}}"], [/[ℓ]/g, "\\ensuremath{\\ell}"], [/[°]/g, "\\ensuremath{^\\circ}"],
  [/[−]/g, "\\ensuremath{-}"], [/[′]/g, "\\ensuremath{'}"], [/[″]/g, "\\ensuremath{''}"], [/[∼∿]/g, "\\ensuremath{\\sim}"], [/[∘]/g, "\\ensuremath{\\circ}"], [/[⊙]/g, "\\ensuremath{\\odot}"],
  [/[⊗]/g, "\\ensuremath{\\otimes}"], [/[⊕]/g, "\\ensuremath{\\oplus}"], [/[⊤]/g, "\\ensuremath{\\top}"], [/[⊥]/g, "\\ensuremath{\\perp}"], [/[…]/g, "\\ldots{}"], [/[•]/g, "\\ensuremath{\\bullet}"],
];

export function esc(s: string): string {
  let t = (s ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "--").replace(/—/g, "---")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  for (const [re, rep] of UMATH) t = t.replace(re, rep);
  // filet de sécurité : tout caractère exotique restant (> Latin-1) → espace, pour garantir la
  // compilation pdflatex (les symboles math fréquents sont déjà traités ci-dessus).
  t = t.replace(/[Ā-￿]/g, " ");
  return t;
}
const LETTER = "ABCDEFGH".split("");
const BOX = String.raw`\ding{113}`; // □ (pifont) — comme les annales CS-233

export function footDate(dateLabel: string): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateLabel;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/** En-tête de la page de garde : logo, enseignant, cours, date et durée, anonymisation, nom et SCIPER. */
export function coverHeader(dateLabel: string, durationMin: number): string[] {
  const c = getCourse(currentCourse());
  const code = c.examCode.replace(/-/g, "--");
  const lecturer = c.profs[0] ?? "";
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.62\textwidth}\vspace{0pt}\epfllogo[26]\par\smallskip\footnotesize`,
    lecturer ? `Lecturer: ${esc(lecturer)}\\\\` : "",
    `\\textbf{${code}: ${esc(c.examName)}}\\\\`,
    `${footDate(dateLabel)}\\quad Duration: ${durationMin} minutes`,
    String.raw`\end{minipage}\hfill\begin{minipage}[t]{0.32\textwidth}\vspace{0pt}\raggedleft\footnotesize Anonymisation:\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{6pt}\noindent\rule{\textwidth}{1pt}`,
    String.raw`\vspace{6pt}\noindent{\Large\textbf{Student One}}\hfill SCIPER: \textbf{111111}`,
  ];
}

/** Page de garde course-aware (style CS-233 : lecturer, SCIPER, convention SCQ/MCQ détectée). */
async function qcmCover(dateLabel: string, nQcm: number, nOpen: number, totalPts: number, durationMin: number): Promise<string> {
  const fmt = await getFormatProfile();
  const convention = fmt?.scq_vs_mcq_convention
    ? esc(fmt.scq_vs_mcq_convention)
    : "There are single-choice questions (SCQ) where exactly one box is correct, and multiple-choice questions (MCQ) where one or more boxes are correct.";
  return [
    ...coverHeader(dateLabel, durationMin),
    String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{Instructions}}\par\smallskip\small`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
    (() => {
      const parts = [nQcm ? `\\textbf{${nQcm} multiple/single-choice questions}` : "", nOpen ? `\\textbf{${nOpen} open questions}` : ""].filter(Boolean);
      return `\\item This exam has ${parts.join(" and ")}, for a total of \\textbf{${totalPts} points}. You have ${durationMin} minutes.`;
    })(),
    nQcm ? `\\item ${convention} Tick the box(es) \\fbox{$\\checkmark$} you believe are correct.` : "",
    String.raw`\item A one-page two-sided cheat sheet is allowed. No electronic device is permitted.`,
    String.raw`\item Answer directly on this exam sheet, in the space provided.`,
    String.raw`\end{enumerate}\vspace{0.3cm}`,
  ].filter(Boolean).join("\n");
}

function renderQcmItem(q: QcmItem, n: number, points: number, withKey: boolean): string {
  const tag = q.type === "mcq" ? "MCQ" : "SCQ";
  const opts = q.options.map((o, k) => {
    const correct = withKey && (q.correct ?? []).includes(k);
    const box = correct ? String.raw`\ding{51}` : BOX; // ✓ dans le corrigé
    const mis = withKey && !correct && q.misconceptions?.[k] ? ` \\hfill{\\footnotesize\\itshape\\color{gray} idée fausse : ${esc(q.misconceptions[k])}}` : "";
    return String.raw`\noindent${box}~\textbf{${LETTER[k]}.}~${esc(o)}${mis}\par\smallskip`;
  }).join("\n");
  // figure rendue (PNG déjà dans examsDir, à côté du .tex compilé).
  const fig = q.figureFile
    ? String.raw`\begin{center}\includegraphics[width=0.52\linewidth]{${q.figureFile}}\end{center}`
    : "";
  return [
    String.raw`\needspace{5\baselineskip}\par\medskip\noindent\textbf{Question ${n}.}\quad{\footnotesize[${tag}, ${points} pt${points > 1 ? "s" : ""}]}\quad\textbf{\textit{${esc(q.topic)}}}\par\smallskip`,
    fig,
    `\\noindent ${esc(q.stem).replace(/^\((SCQ|MCQ)\)\s*/i, "")}\\par\\smallskip`,
    opts,
    withKey && q.explanation ? String.raw`\par{\footnotesize\color{epflred}\textbf{Solution :} ${esc(q.explanation)}}\par` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Un nœud TikZ dont le texte contient « \\\\ » exige align= ; la figure peut redéfinir
 * « every node » et écraser un réglage global (examen 2 de CS-290) : on l'ajoute donc à
 * chaque nœud qui n'en a pas (sans effet sur un texte d'une ligne). Seulement DANS les
 * figures tikzpicture : ailleurs, « node[i] » est du code ou du texte. Des options
 * imbriquées (label={[red]…}) sont laissées telles quelles.
 */
export function alignTikzNodes(tex: string): string {
  const inNode = (fig: string) => fig
    .replace(/(\\?\bnode)\[(?![^\[\]]*\balign\s*=)([^\[\]]*)\](?!\])/g, (_m, kw: string, opts: string) => `${kw}[${opts.trim() ? `${opts}, ` : ""}align=center]`)
    .replace(/(\\?\bnode)(?=\s*(?:\(|\{|at\b))/g, "$1[align=center]");
  return tex.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, inNode);
}

function renderOpen(q: ExamQuestion, n: number, withSol: boolean, defaultPts = 15): string {
  // les énoncés ouverts (architecte ML) sont déjà en LaTeX (corps) — on les insère tels quels,
  // précédés d'un en-tête. Si pas de \subq dedans, on ajoute un espace de réponse.
  const stmt = alignTikzNodes((q.statement_tex ?? "").trim());
  const hasSpace = /\\rulelines|\\diskgrid|\\statesim|\\packetgrid|\\forwardgrid/.test(stmt);
  return [
    String.raw`\clearpage\needspace{4\baselineskip}{\large\textbf{Open question ${n} \quad-- ${esc(q.concept)} \hfill [${q.points ?? defaultPts} points]}}\par\vspace{4pt}\hrule\vspace{8pt}`,
    stmt,
    hasSpace ? "" : String.raw`\vspace{4pt}\rulelines{8}`,
    withSol ? String.raw`\par\medskip{\textbf{\color{epflred}Solution.}}\par\smallskip` + "\n" + alignTikzNodes(q.solution_tex ?? "") : "",
  ].filter(Boolean).join("\n");
}

export type QcmExamData = { items: QcmItem[]; open: ExamQuestion[]; qcmPoints?: number };

/**
 * Les questions OUVERTES arrivent en LaTeX libre (architecte) : deux tournures courantes
 * faisaient échouer tout le PDF (examens 1 et 2 de CS-290, 01/11/2026 — seuls les .tex
 * existaient) : \captionof sans paquet, et « \\ » dans un nœud TikZ sans align. Ajouté au
 * préambule QCM seulement (le préambule commun fixe le .tex de CS-202, invariant), sans
 * nouveau paquet : le cache tectonic de l'image n'est préchauffé que pour le commun.
 */
const OPEN_TEX_COMPAT = String.raw`\providecommand{\captionof}[2]{\par\smallskip{\small\itshape #2}\par}
\tikzset{every node/.append style={align=center}}`;

/**
 * Document complet autour de `body` : préambule commun (figé par CS-202) + figures et compat
 * des ouvertes, en-tête et pied de page du cours (le préambule est écrit pour CS-202).
 */
export function examDocument(body: string[], dateLabel: string): string {
  let preamble = fs.readFileSync(path.join(LATEX_DIR, "preamble.tex"), "utf8");
  const figPath = path.join(LATEX_DIR, "figures.tex");
  if (fs.existsSync(figPath)) preamble += "\n" + fs.readFileSync(figPath, "utf8");
  preamble += "\n" + OPEN_TEX_COMPAT;
  const c = getCourse(currentCourse());
  const code = c.examCode.replace(/-/g, "--");
  const profsTex = c.profs.length ? c.profs.join(", ") : "";
  const footOverride = [
    String.raw`\fancyhead[L]{}`,
    `\\fancyhead[R]{\\qrcode[height=1.25cm]{${c.examCode}-FINAL-EXAM}}`,
    `\\fancyfoot[C]{\\small\\textbf{${code}, ${c.examKind}}${profsTex ? `\\\\[-2pt]\\small ${profsTex}` : ""}}`,
  ].join("\n");
  return [
    preamble,
    footOverride,
    String.raw`\newcommand{\FOOTDATE}{${footDate(dateLabel)}}`,
    String.raw`\begin{document}`,
    ...body,
    String.raw`\end{document}`,
  ].join("\n");
}

/** Copie le logo de la page de garde à côté des .tex compilés. */
export function copyExamLogo(): void {
  for (const ext of ["pdf", "png"]) {
    const src = path.join(LATEX_DIR, `epfl-logo.${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(examsDir(), `epfl-logo.${ext}`));
  }
}

/** Source .tex complet de l'examen QCM (+ ouvert), corrigé optionnel. */
export async function renderQcmExamTex(data: QcmExamData, dateLabel: string, includeSolutions: boolean): Promise<string> {

  const fmt = await getFormatProfile();
  const dur = fmt?.duration_min ?? 180;
  // Barème CALÉ sur le format détecté : chaque type (scq/mcq) vaut ses points_each réels
  // (ex. CS-233 : scq 3 pts, mcq 4 pts), les ouvertes leurs ~17 pts. Repli 2/15 si non détecté.
  const ptsOf = (t: "scq" | "mcq"): number => {
    if (data.qcmPoints) return data.qcmPoints; // override explicite éventuel
    const q = (fmt?.question_types ?? []).find((x) => x.type === t);
    return q && q.points_each > 0 ? q.points_each : 2;
  };
  const openDefault = (fmt?.question_types ?? []).find((x) => x.type === "open")?.points_each || 15;
  const itemPts = data.items.map((q) => ptsOf(q.type === "mcq" ? "mcq" : "scq"));
  const qcmTotal = itemPts.reduce((s, p) => s + p, 0);
  const openPts = data.open.reduce((s, q) => s + (q.points ?? openDefault), 0);
  const totalPts = qcmTotal + openPts;

  // drill ciblé « 0 QCM + N ouvertes » : pas de partie QCM vide. Si les deux parties existent on
  // garde « First/Second part » ; sinon on n'affiche que la partie présente.
  const hasQcm = data.items.length > 0;
  const hasOpen = data.open.length > 0;
  const qcmLabel = hasOpen ? "First part \\quad-- Multiple-choice and single-choice questions" : "Multiple-choice and single-choice questions";
  const openLabel = hasQcm ? "Second part \\quad-- Open questions" : "Open questions";
  const firstPart = hasQcm
    ? [
        String.raw`\par\noindent{\large\textbf{${qcmLabel} \hfill [${qcmTotal} points]}}\par\vspace{3pt}\hrule\vspace{8pt}`,
        ...data.items.map((q, i) => renderQcmItem(q, i + 1, itemPts[i], includeSolutions)),
      ].join("\n")
    : "";

  const secondPart = hasOpen
    ? [
        hasQcm ? String.raw`\clearpage` : "",
        String.raw`\par\noindent{\large\textbf{${openLabel} \hfill [${openPts} points]}}\par\vspace{3pt}\hrule`,
        ...data.open.map((q, i) => renderOpen(q, i + 1, includeSolutions, openDefault)),
      ].filter(Boolean).join("\n")
    : "";

  return examDocument([await qcmCover(dateLabel, data.items.length, data.open.length, totalPts, dur), firstPart, secondPart], dateLabel);
}

/**
 * LaTeX libre d'une question ouverte → texte simple échappé (repli quand il casse la
 * compilation) : figures TikZ remplacées par une mention, environnements et commandes
 * retirés, leur texte gardé, paragraphes conservés.
 */
export function plainOpenTex(tex: string): string {
  const text = (tex ?? "")
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, " [figure : voir l'examen dans l'app] ")
    .replace(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, " ")
    .replace(/\\\\(?:\[[^\]]*\])?/g, "\n")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/\\([%$&#_{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/[ \t]+/g, " ");
  return text.split(/\n\s*\n/).map((p) => esc(p.trim())).filter(Boolean).join("\n\n");
}

/**
 * Écrit énoncé + corrigé .tex et compile les 2 PDF. Le garde passe AVANT toute écriture
 * (lib/tex-guard). Un refus du garde ou un échec de compilation n'est jamais silencieux
 * ni fatal tant qu'un repli existe : les questions ouvertes (LaTeX libre, la cause
 * habituelle) passent en texte simple ; un corrigé qui ne compile pas a le même repli,
 * pour rester cohérent avec l'énoncé. `file` vide : aucun .tex sûr n'a pu être écrit.
 */
export async function buildQcmArtifact(examId: number, data: QcmExamData, dateLabel: string): Promise<{ file: string; texError?: string; texWarning?: string }> {
  fs.mkdirSync(examsDir(), { recursive: true });
  const base = `qcm-${examId}`;
  copyExamLogo();
  const plain: QcmExamData = { ...data, open: data.open.map((q) => ({ ...q, statement_tex: plainOpenTex(q.statement_tex), solution_tex: plainOpenTex(q.solution_tex) })) };
  const write = async (d: QcmExamData, solutions: boolean): Promise<string> => {
    const tex = await renderQcmExamTex(d, dateLabel, solutions);
    assertTexSafe(tex);
    const name = solutions ? `${base}-corrige` : base;
    fs.writeFileSync(path.join(examsDir(), `${name}.tex`), tex);
    return name;
  };
  const why = (e: unknown) => (e as Error).message.slice(0, 200);

  let pdf: string;
  let warning: string | undefined;
  try {
    pdf = await compileExamPdf(await write(data, false));
  } catch (e) {
    if (!data.open.length) return { file: fs.existsSync(path.join(examsDir(), `${base}.tex`)) ? `${base}.tex` : "", texError: (e as Error).message };
    try {
      pdf = await compileExamPdf(await write(plain, false));
      warning = `PDF compilé avec les questions ouvertes en texte simple (leur LaTeX ne passait pas : ${why(e)})`;
    } catch (e2) {
      return { file: fs.existsSync(path.join(examsDir(), `${base}.tex`)) ? `${base}.tex` : "", texError: `${(e as Error).message} — repli en texte simple échoué aussi : ${why(e2)}` };
    }
  }
  // Corrigé : même source que l'énoncé, puis le même repli s'il ne compile pas (examen 2 de
  // CS-290 : « Énoncé » sans « Corrigé »).
  try {
    await compileExamPdf(await write(warning ? plain : data, true));
  } catch (e) {
    try {
      if (warning || !data.open.length) throw e;
      await compileExamPdf(await write(plain, true));
      warning = `Corrigé compilé avec les questions ouvertes en texte simple (${why(e)})`;
    } catch (e2) {
      warning = `${warning ? `${warning} ; ` : ""}corrigé non compilé : ${why(e2)}`;
      console.error(`[qcm] corrigé #${examId} non compilé :`, (e2 as Error).message);
    }
  }
  return { file: pdf, ...(warning ? { texWarning: warning } : {}) };
}
