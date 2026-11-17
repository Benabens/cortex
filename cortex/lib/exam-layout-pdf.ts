import { currentCourse } from "@/db/client";
import { getCourse, type CourseConfig } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { durationOf, formatContextFor } from "@/lib/exam-format";
import type { CoverFacts, ExamForm, ExamLayout, ExamPdf, IdField, PageSlot, Slots } from "@/lib/exam-layout";
import { headNumber } from "@/lib/exam-layout-tex";
import { courseTitle, courseWords, durationText, examKindText, genericPreamble, localBlockLabels, localDate, localQcmLabels, localWrittenLabels, pointsText, solutionColor, type CoverWords } from "@/lib/exam-template";
import { texEscape } from "@/lib/tex-escape";

/**
 * ADAPTATEUR PARAMÉTRIQUE de la mise en page (lib/exam-layout) : garde, en-tête et pied,
 * numérotation, police et espaces de réponse que décrit l'`ExamLayout`, sans aucune marque
 * d'établissement, corrigés en bleu foncé, dans la langue de l'examen. Le défaut neutre
 * (NEUTRAL_LAYOUT) redonne le gabarit neutre de #116 à l'octet près (empreintes de
 * tests/exam-layout) ; une mise en page relevée dans l'annale en change ce qu'elle a vu.
 */
const qPoints = (q: ExamQuestion) => q.points ?? 10;

/** Dernière page, pour « 3/5 » : une étiquette posée en fin de document (tectonic recompile jusqu'à stabilité). */
const LAST_PAGE = "cortex-last-page";

/** Contenu d'une case, précédé de `\small` (collé à une macro, séparé d'un texte). */
function slotTex(s: Exclude<PageSlot, "none">, c: CourseConfig, w: CoverWords): string {
  switch (s) {
    case "course": return ` ${courseTitle(c)}`;
    case "examKind": return ` ${texEscape(examKindText(c, w))}`;
    case "page": return String.raw`\thepage`;
    case "pageOfTotal": return String.raw`\thepage/\pageref{${LAST_PAGE}}`;
    case "date": return String.raw`\FOOTDATE`;
  }
}

function slotsTex(side: "head" | "foot", s: Slots, c: CourseConfig, w: CoverWords): string[] {
  return ([["L", s.left], ["C", s.center], ["R", s.right]] as const)
    .filter((x): x is readonly ["L" | "C" | "R", Exclude<PageSlot, "none">] => x[1] !== "none")
    .map(([k, v]) => String.raw`\fancy${side}[${k}]{\small${slotTex(v, c, w)}}`);
}

/** Espace de réponse (`\rulelines{n}` du préambule) : lignes, cadre, ou blanc de même hauteur. */
function answerSpaceTex(layout: ExamLayout): string[] {
  if (layout.answerSpace === "box") return [String.raw`\renewcommand{\rulelines}[1]{\par\smallskip\noindent\fbox{\parbox[t][\dimexpr 6.7mm*#1\relax]{\dimexpr\linewidth-2\fboxsep-2\fboxrule\relax}{\mbox{}}}\par\smallskip}`];
  if (layout.answerSpace === "blank") return [String.raw`\renewcommand{\rulelines}[1]{\par\vspace{\dimexpr 6.7mm*#1\relax}}`];
  return [];
}

/** Points dans un titre d'exercice écrit (`#3`) : à droite par défaut ; dans la ligne, hors du gras. */
function headPoints(layout: ExamLayout, w: CoverWords): { right: string; inline: string } {
  if (layout.points === "none") return { right: "", inline: "" };
  if (layout.points === "inline") return { right: "", inline: ` (#3 ${w.points})` };
  return { right: String.raw` \hfill [#3 ${w.points}]`, inline: "" };
}

/**
 * En-tête, pied de page et macros, à placer APRÈS le préambule commun (qui porte le gabarit de
 * cs-202) : il efface son en-tête et son pied (`\fancyhf{}` en tête du bloc), coupe la marge, rend
 * le logo vide et le rouge des corrigés bleu foncé (une macro du modèle qui les citerait compile
 * encore), puis pose les titres de question, la police, l'espace de réponse et les cases de
 * l'en-tête et du pied.
 */
export function layoutChrome(layout: ExamLayout, c: CourseConfig, w: CoverWords): string {
  const n = layout.numbering.style === "roman" ? String.raw`\Roman{exq}` : "#1";
  const prefix = layout.numbering.prefix ?? w.question;
  // Sans mot : « 3. Titre » (« 3 -- Titre » se lisait comme une soustraction), cf. headNumber.
  const head = !prefix ? `${n}.~` : `${prefix.length === 1 ? `${prefix}${n}` : `${prefix} ${n}`}${String.raw` \quad-- `}`;
  const pts = headPoints(layout, w);
  const usesLastPage = [layout.header, layout.footer].some((s) => [s.left, s.center, s.right].includes("pageOfTotal"));
  return [
    String.raw`\pagestyle{fancy}\fancyhf{}`,
    String.raw`\examchromefalse`,
    String.raw`\renewcommand{\epfllogo}[1][30]{}`,
    String.raw`\definecolor{solution}{HTML}{1F4E9A}`,
    String.raw`\colorlet{epflred}{solution}`,
    ...(layout.font.family === "sans" ? [String.raw`\renewcommand{\familydefault}{\sfdefault}`] : []),
    String.raw`\renewcommand{\examq}[3]{\clearpage\setcounter{exq}{#1}\needspace{3\baselineskip}{\large\textbf{${head}#2${pts.right}}${pts.inline}}\par\vspace{4pt}\hrule\vspace{10pt}}`,
    String.raw`\renewcommand{\subq}[3]{\par\medskip\needspace{3\baselineskip}{\textbf{#1 \quad-- #2${pts.right}}${pts.inline}}\par\smallskip}`,
    String.raw`\renewcommand{\ansspace}[1]{\par\medskip\noindent\textbf{${w.answers}}\par\vspace*{#1}}`,
    ...answerSpaceTex(layout),
    String.raw`\renewcommand{\headrulewidth}{0.4pt}\renewcommand{\footrulewidth}{0pt}`,
    ...slotsTex("head", layout.header, c, w),
    ...slotsTex("foot", layout.footer, c, w),
    ...(usesLastPage ? [String.raw`\AtEndDocument{\label{${LAST_PAGE}}}`] : []),
  ].join("\n");
}

/** Libellé d'un champ à remplir : celui de l'annale, sinon celui de la langue de l'examen. */
function fieldLabel(f: IdField, w: CoverWords): string {
  if (f.label !== null) return texEscape(f.label);
  return f.kind === "studentId" ? w.idField : w.nameField;
}

/** Champs à remplir de la garde, deux par ligne (le premier large, le second court). */
function idFieldsTex(fields: IdField[], w: CoverWords): string[] {
  const rows: string[] = [];
  // Deux par ligne si les libellés sont courts ; « Candidate number: » et « Desk number: » se
  // coupaient dans la case de droite : un par ligne.
  const short = (f: IdField) => (f.label ?? "").length <= 12;
  for (let i = 0; i < fields.length; i += 1) {
    const [a, b] = [fields[i], short(fields[i]) && fields[i + 1] && short(fields[i + 1]) ? fields[i + 1] : undefined];
    if (b) i += 1;
    rows.push(b
      ? String.raw`\noindent ${fieldLabel(a, w)}~\makebox[0.5\textwidth]{\hrulefill}\hfill ${fieldLabel(b, w)}~\makebox[0.22\textwidth]{\hrulefill}\par\vspace{10pt}`
      : String.raw`\noindent ${fieldLabel(a, w)}~\makebox[0.6\textwidth]{\hrulefill}\par\vspace{10pt}`);
  }
  return rows;
}

/** Tableau des points par question, la dernière ligne vide pour le correcteur (douze questions au plus). */
function pointsTableTex(points: number[], w: CoverWords): string[] {
  if (!points.length || points.length > 12) return [];
  const total = points.reduce((s, p) => s + p, 0);
  return [
    String.raw`\begin{center}\renewcommand{\arraystretch}{1.5}\small`,
    String.raw`\begin{tabular}{|${"c|".repeat(points.length + 1)}}\hline`,
    String.raw`${points.map((_, i) => i + 1).join(" & ")} & \textbf{${w.totalLabel.replace(/\s*:$/, "")}}\\\hline`,
    String.raw`${points.join(" & ")} & ${total}\\\hline`,
    String.raw`${points.map(() => "").join(" & ")} & \\[0.5cm]\hline`,
    String.raw`\end{tabular}\end{center}`,
  ];
}

/**
 * Garde : le cours, son établissement s'il est saisi, la date, les champs à remplir, la durée et le
 * total des points, puis les consignes : la ligne qui dit ce que contient l'examen, puis celles de
 * l'annale quand elle en a, sinon les consignes génériques (`generated`, déjà en LaTeX).
 */
function coverTex(layout: ExamLayout, o: { course: CourseConfig; w: CoverWords; dateTex: string; durationMin: number | null; totalPts: number; generated: string[]; points: number[] }): string {
  const { course: c, w } = o;
  const instructions = layout.cover.instructions.length ? [o.generated[0], ...layout.cover.instructions.map(texEscape)] : o.generated;
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\begin{center}`,
    String.raw`{\Large\textbf{${courseTitle(c)}}}\\[6pt]`,
    String.raw`{\large ${texEscape(examKindText(c, w))}}\\[4pt]`,
    ...c.universityLines.map((u) => String.raw`{\small ${texEscape(u)}}\\[2pt]`),
    o.dateTex,
    String.raw`\end{center}`,
    String.raw`\vspace{0.3cm}\noindent\rule{\textwidth}{0.6pt}\par\vspace{10pt}`,
    ...idFieldsTex(layout.cover.idFields, w),
    o.durationMin
      ? String.raw`\noindent\textbf{${w.durationLabel}} ${durationText(o.durationMin, w)}\hfill\textbf{${w.totalLabel}} ${pointsText(o.totalPts, w)}\par\vspace{4pt}`
      : String.raw`\noindent\hfill\textbf{${w.totalLabel}} ${pointsText(o.totalPts, w)}\par\vspace{4pt}`,
    String.raw`\noindent\rule{\textwidth}{0.6pt}`,
    String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{${w.instructions}}}\par\smallskip`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
    ...instructions.map((i) => String.raw`\item ${i}`),
    String.raw`\end{enumerate}\vspace{0.3cm}`,
    ...(layout.cover.pointsTable ? pointsTableTex(o.points, w) : []),
  ].join("\n");
}

function cover(layout: ExamLayout, f: CoverFacts): string {
  const w = courseWords();
  const course = getCourse(currentCourse());
  const dateTex = localDate(f.dateLabel, w);
  if (f.form === "qcm") {
    // Convention traduite : la phrase détectée dans les annales est souvent en anglais.
    const parts = [f.nQcm ? w.qcmCount(f.nQcm) : "", f.nOpen ? w.openCount(f.nOpen) : ""].filter(Boolean).join(` ${w.and} `);
    return coverTex(layout, {
      course, w, dateTex, durationMin: f.durationMin, totalPts: f.totalPts, points: f.points,
      generated: [w.contains(parts, f.totalPts), ...(f.nQcm ? [`${w.qcmConvention} ${w.tick}`] : []), w.onSheet],
    });
  }
  if (f.form === "blocks") {
    return coverTex(layout, {
      course, w, dateTex, durationMin: f.durationMin, totalPts: f.totalPts, points: f.points,
      generated: [w.blocks(f.n, f.totalPts), w.blocksHow, w.onSheet],
    });
  }
  const total = f.questions.reduce((s, q) => s + qPoints(q), 0);
  const fc = formatContextFor(currentCourse());
  return coverTex(layout, {
    course, w, dateTex, durationMin: durationOf(fc), totalPts: total, points: f.questions.map(qPoints),
    generated: [w.exercises(f.questions.length, total), ...(fc.documents ? [w.documents[fc.documents]] : []), w.onSheet, w.readCarefully],
  });
}

function chrome(layout: ExamLayout) {
  return (form: ExamForm, dateLabel: string): string[] => {
    const id = currentCourse();
    const c = getCourse(id);
    const w = courseWords();
    const foot = String.raw`\newcommand{\FOOTDATE}{${localDate(dateLabel, w)}}`;
    if (form !== "written") return [layoutChrome(layout, c, w), foot];
    // Hors registre : le gabarit par défaut du préambule (comportement historique de l'écrit).
    return [genericPreamble(), c.id !== id ? "" : layoutChrome(layout, c, w), foot];
  };
}

/** Taille de la classe : le préambule commun est en 11 pt. */
function preamble(layout: ExamLayout) {
  return (src: string) => (layout.font.size === 11 ? src : src.replace(/\\documentclass\[11pt/, String.raw`\documentclass[${layout.font.size}pt`));
}

/** Le PDF de la mise en page paramétrique `layout`, pour le cours courant. */
export function layoutPdf(layout: ExamLayout): ExamPdf {
  const w = courseWords();
  const color = solutionColor("neutral");
  return {
    layout,
    preamble: preamble(layout),
    chrome: chrome(layout),
    cover: async (f) => cover(layout, f),
    qcm: localQcmLabels(w, color, false),
    blocks: localBlockLabels(w, color),
    written: localWrittenLabels(w, (n) => headNumber(layout.numbering, n, w.question).num),
    logo: false,
  };
}
