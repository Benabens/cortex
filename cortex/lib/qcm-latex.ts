import type { ExamQuestion } from "@/lib/exam";
import { compileExamPdf, copyExamLogo } from "@/lib/exam-latex";
import { examDurationMin } from "@/lib/exam-format";
import { examLayout, examPdf, type ExamLayout, type ExamPdf } from "@/lib/exam-layout";
import { choicesTex, openHeadTex, qcmHeadTex } from "@/lib/exam-layout-tex";
import { esc } from "@/lib/tex-escape";
import { formulasOrText, markdownListsTex, texInline, texText } from "@/lib/tex-rich";
import { assertTexSafe } from "@/lib/tex-guard";
import { getFormatProfile } from "@/lib/format";
import { resolveExamFormat } from "@/lib/exam-format";
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

/** Les QCM de l'énoncé sur deux colonnes, comme l'annale ; le corrigé (explications) garde la pleine largeur. */
function inColumns(items: string[], two: boolean): string[] {
  return two ? [String.raw`\begin{multicols}{2}`, ...items, String.raw`\end{multicols}`] : items;
}

function renderQcmItem(q: QcmItem, n: number, points: number, withKey: boolean, pdf: ExamPdf): string {
  const L = pdf.qcm;
  const opts = q.options.map((o, k) => {
    const correct = withKey && (q.correct ?? []).includes(k);
    // Corrigé : l'idée fausse visée, SOUS l'option, en retrait et en drapeau (examen #16, 16/11 :
    // poussée à droite de l'option par \hfill, elle débordait ou se coupait en fragments entre
    // deux lignes justifiées dès que l'option ou la note étaient longues).
    const note = withKey && !correct && q.misconceptions?.[k]?.trim()
      ? String.raw`\nopagebreak{\raggedright\leftskip=1.7em\footnotesize\itshape\color{gray}${L.misconception}${texInline(q.misconceptions[k].trim())}\par}`
      : "";
    return { text: texInline(o), correct, note };
  });
  // figure rendue (PNG déjà dans examsDir, à côté du .tex compilé).
  const fig = q.figureFile
    ? String.raw`\begin{center}\includegraphics[width=0.52\linewidth]{${q.figureFile}}\end{center}`
    : "";
  return [
    qcmHeadTex(pdf.layout, L, n, q.type, points, esc(q.topic)),
    fig,
    `\\noindent ${texText(q.stem.replace(/^\s*\((SCQ|MCQ)\)\s*/i, ""))}\\par\\smallskip`,
    choicesTex(pdf.layout, opts),
    withKey && q.explanation ? String.raw`\par{\footnotesize\color{${L.color}}\textbf{${L.solution}} ${texText(q.explanation, String.raw`\newline `)}}\par` : "",
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

function renderOpen(q: ExamQuestion, n: number, withSol: boolean, defaultPts: number, pdf: ExamPdf): string {
  const L = pdf.qcm;
  // les énoncés ouverts (architecte ML) sont déjà en LaTeX (corps) — on les insère tels quels,
  // précédés d'un en-tête. Si pas de \subq dedans, on ajoute un espace de réponse.
  const stmt = alignTikzNodes(markdownListsTex((q.statement_tex ?? "").trim()));
  const hasSpace = /\\rulelines|\\diskgrid|\\statesim|\\packetgrid|\\forwardgrid/.test(stmt);
  return [
    (n > 1 || L.pageBeforeFirstOpen ? String.raw`\clearpage` : String.raw`\par\vspace{8pt}`) + openHeadTex(pdf.layout, L, n, esc(q.concept), q.points ?? defaultPts),
    stmt,
    hasSpace ? "" : String.raw`\vspace{4pt}\rulelines{8}`,
    withSol ? String.raw`\par\medskip{\textbf{\color{${L.color}}${L.openSolution}}}\par\smallskip` + "\n" + alignTikzNodes(markdownListsTex(q.solution_tex ?? "")) : "",
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
 * des ouvertes, puis l'en-tête et le pied de la mise en page (le préambule est écrit pour CS-202).
 */
export function examDocument(body: string[], dateLabel: string, pdf: ExamPdf): string {
  let preamble = pdf.preamble(fs.readFileSync(path.join(LATEX_DIR, "preamble.tex"), "utf8"));
  const figPath = path.join(LATEX_DIR, "figures.tex");
  if (fs.existsSync(figPath)) preamble += "\n" + fs.readFileSync(figPath, "utf8");
  preamble += "\n" + OPEN_TEX_COMPAT;
  return [preamble, ...pdf.chrome("qcm", dateLabel), String.raw`\begin{document}`, ...body, String.raw`\end{document}`].join("\n");
}

export { copyExamLogo, esc };

/**
 * Durée affichée d'un examen QCM, en minutes, ou null : celle des annales, sinon celle du format
 * déclaré ou du cours (lib/exam-format). Examen #16 (16/11) : un profil sans durée l'enregistre à 0,
 * que `?? 180` laissait passer — « Duration: 0 minutes », « You have 0 minutes ». Inconnue, la
 * mention est retirée plutôt qu'inventée.
 */
export async function qcmDurationMin(detected: number | null | undefined): Promise<number | null> {
  if (detected && detected > 0) return detected;
  const declared = (await resolveExamFormat().catch(() => null))?.durationMin;
  return declared && declared > 0 ? declared : null;
}

/** Source .tex complet de l'examen QCM (+ ouvert), corrigé optionnel. */
export async function renderQcmExamTex(data: QcmExamData, dateLabel: string, includeSolutions: boolean, layout?: ExamLayout): Promise<string> {
  const pdf = examPdf(layout ?? (await examLayout()));

  const fmt = await getFormatProfile();
  const dur = await examDurationMin();
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
  const L = pdf.qcm;
  const firstPart = hasQcm
    ? [
        String.raw`\par\noindent{\large\textbf{${L.qcmPart(hasOpen)} \hfill [${L.points(qcmTotal)}]}}\par\vspace{3pt}\hrule\vspace{8pt}`,
        ...inColumns(data.items.map((q, i) => renderQcmItem(q, i + 1, itemPts[i], includeSolutions, pdf)), pdf.layout.questions.columns === 2 && !includeSolutions),
      ].join("\n")
    : "";

  const secondPart = hasOpen
    ? [
        hasQcm ? String.raw`\clearpage` : "",
        String.raw`\par\noindent{\large\textbf{${L.openPart(hasQcm)} \hfill [${L.points(openPts)}]}}\par\vspace{3pt}\hrule`,
        ...data.open.map((q, i) => renderOpen(q, i + 1, includeSolutions, openDefault, pdf)),
      ].filter(Boolean).join("\n")
    : "";

  const cover = await pdf.cover({ form: "qcm", dateLabel, nQcm: data.items.length, nOpen: data.open.length, totalPts, durationMin: dur, points: [...itemPts, ...data.open.map((q) => q.points ?? openDefault)] });
  return examDocument([cover, firstPart, secondPart], dateLabel, pdf);
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
  copyExamLogo(examPdf(await examLayout()).logo);
  const plain: QcmExamData = { ...data, open: data.open.map((q) => ({ ...q, statement_tex: plainOpenTex(q.statement_tex), solution_tex: plainOpenTex(q.solution_tex) })) };
  const write = async (d: QcmExamData, solutions: boolean): Promise<string> => {
    const tex = await renderQcmExamTex(d, dateLabel, solutions);
    assertTexSafe(tex);
    const name = solutions ? `${base}-corrige` : base;
    fs.writeFileSync(path.join(examsDir(), `${name}.tex`), tex);
    return name;
  };
  const why = (e: unknown) => (e as Error).message.slice(0, 200);

  // Chaque étape retente d'abord avec les formules du texte en texte (lib/tex-rich) : une formule
  // qui ne compile pas ne doit pas faire passer les questions ouvertes en texte simple.
  const compile = async (d: QcmExamData, solutions: boolean) => {
    const r = await formulasOrText(async () => compileExamPdf(await write(d, solutions)));
    if (r.asText) formulasAsText = true;
    return r.value;
  };
  let formulasAsText = false;
  let pdf: string;
  let warning: string | undefined;
  try {
    pdf = await compile(data, false);
  } catch (e) {
    if (!data.open.length) return { file: fs.existsSync(path.join(examsDir(), `${base}.tex`)) ? `${base}.tex` : "", texError: (e as Error).message };
    try {
      pdf = await compile(plain, false);
      warning = `PDF compilé avec les questions ouvertes en texte simple (leur LaTeX ne passait pas : ${why(e)})`;
    } catch (e2) {
      return { file: fs.existsSync(path.join(examsDir(), `${base}.tex`)) ? `${base}.tex` : "", texError: `${(e as Error).message}, repli en texte simple échoué aussi : ${why(e2)}` };
    }
  }
  // Corrigé : même source que l'énoncé, puis le même repli s'il ne compile pas (examen 2 de
  // CS-290 : « Énoncé » sans « Corrigé »).
  try {
    await compile(warning ? plain : data, true);
  } catch (e) {
    try {
      if (warning || !data.open.length) throw e;
      await compile(plain, true);
      warning = `Corrigé compilé avec les questions ouvertes en texte simple (${why(e)})`;
    } catch (e2) {
      warning = `${warning ? `${warning} ; ` : ""}corrigé non compilé : ${why(e2)}`;
      console.error(`[qcm] corrigé #${examId} non compilé :`, (e2 as Error).message);
    }
  }
  if (formulasAsText) warning = `${warning ? `${warning} ; ` : ""}formules imprimées en texte (elles ne compilaient pas)`;
  return { file: pdf, ...(warning ? { texWarning: warning } : {}) };
}
