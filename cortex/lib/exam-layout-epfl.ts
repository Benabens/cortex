import { currentCourse } from "@/db/client";
import { DEFAULT_COURSE, getCourse } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { durationOf, formatContextFor } from "@/lib/exam-format";
import type { BlockLabels, CoverFacts, ExamForm, ExamLayout, ExamPdf, QcmLabels, WrittenLabels } from "@/lib/exam-layout";
import { courseWords, coverWords, durationText, epflExamKind, epflLocalChrome, epflWords, genericPreamble, localBlockLabels, localDate, localQcmLabels, localWrittenLabels, solutionColor, type CoverWords } from "@/lib/exam-template";
import { getFormatProfile } from "@/lib/format";
import { esc, qrText, texEscape } from "@/lib/tex-escape";

/**
 * ADAPTATEUR EPFL de la mise en page (lib/exam-layout) : la garde, l'en-tête et le pied historiques
 * de l'EPFL (logo, anonymisation, SCIPER, QR, rouge des corrigés), byte-identiques. cs-202 garde
 * son texte canonique (empreinte de tests/tex-guard) ; les autres cours de l'EPFL, leurs libellés
 * dans la langue de l'examen (lib/exam-template, epflWords). Verrouillé par
 * tests/gabarit-epfl-non-regression et tests/gabarit-epfl-langue.
 */
const qPoints = (q: ExamQuestion) => q.points ?? 10;

/** Date du pied d'un examen écrit de l'EPFL, en anglais : « June 11\textsuperscript{th}, 2026 ». */
export function epflLongDate(dateLabel: string): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (!m) return texEscape(dateLabel);
  const y = m[1], mo = months[+m[2] - 1] ?? "", d = +m[3];
  return String.raw`${mo} ${d}\textsuperscript{th}, ${y}`;
}

/** Date d'un QCM de l'EPFL, en anglais : « June 11, 2026 ». */
export function footDate(dateLabel: string): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateLabel;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/** Date du pied de l'EPFL : le format historique en anglais, sinon celui de la langue de l'examen. */
function epflDate(dateLabel: string): string {
  const w = epflWords();
  return w ? localDate(dateLabel, w) : footDate(dateLabel);
}

function gradingTableTex(qs: ExamQuestion[], leaveEmpty = "LEAVE THIS EMPTY"): string {
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
    String.raw`\multicolumn{${qs.length + 1}}{|c|}{\textbf{${leaveEmpty}}}\\\hline`,
    String.raw`${groupRow} & \multirow{2}{*}{\textbf{TOTAL}}\\\cline{1-${qs.length}}`,
    String.raw`${qRow} & \\\hline`,
    String.raw`${ptsRow} & ${total}\\\hline`,
    String.raw`${emptyRow} & \\[0.55cm]\hline`,
    String.raw`\end{tabular}\end{center}`,
  ].join("\n");
}

/**
 * Règle de documents de la garde : seulement celle que le cours déclare, dans la langue de
 * l'examen ; rien sinon. Avant le 16/11/2026, chaque QCM de l'EPFL affirmait « A one-page
 * two-sided cheat sheet is allowed. No electronic device is permitted. », règle inventée.
 */
function documentsItem(): string {
  const f = formatContextFor(currentCourse());
  return f.documents ? String.raw`\item ${coverWords(f.language).documents[f.documents]}` : "";
}

/**
 * En-tête de la page de garde d'un QCM : logo, enseignant, cours, date et durée (si connue),
 * anonymisation, nom et SCIPER. Hors anglais, libellés dans la langue de l'examen (`w`, cf. epflWords).
 */
function coverHeader(dateLabel: string, durationMin: number | null, w: CoverWords | null = epflWords()): string[] {
  const c = getCourse(currentCourse());
  const code = texEscape(c.examCode).replace(/-/g, "--");
  const lecturer = c.profs[0] ?? "";
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.62\textwidth}\vspace{0pt}\epfllogo[26]\par\smallskip\footnotesize`,
    lecturer ? `${w?.lecturer ?? "Lecturer:"} ${texEscape(lecturer)}\\\\` : "",
    `\\textbf{${code}: ${texEscape(c.examName)}}\\\\`,
    w
      ? (durationMin ? `${localDate(dateLabel, w)}\\quad ${w.durationLabel} ${durationText(durationMin, w)}` : localDate(dateLabel, w))
      : (durationMin ? `${footDate(dateLabel)}\\quad Duration: ${durationMin} minutes` : footDate(dateLabel)),
    String.raw`\end{minipage}\hfill\begin{minipage}[t]{0.32\textwidth}\vspace{0pt}\raggedleft\footnotesize ${w?.anonymisation ?? "Anonymisation:"}\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{6pt}\noindent\rule{\textwidth}{1pt}`,
    String.raw`\vspace{6pt}\noindent{\Large\textbf{Student One}}\hfill SCIPER: \textbf{111111}`,
  ];
}

/** Garde d'un QCM (style CS-233 : lecturer, SCIPER, convention SCQ/MCQ détectée). */
async function qcmCover(dateLabel: string, nQcm: number, nOpen: number, totalPts: number, durationMin: number | null): Promise<string> {
  // EPFL hors anglais : même garde, consignes dans la langue de l'examen.
  const w = epflWords();
  if (w) {
    const parts = [nQcm ? w.qcmCount(nQcm) : "", nOpen ? w.openCount(nOpen) : ""].filter(Boolean).join(` ${w.and} `);
    return [
      ...coverHeader(dateLabel, durationMin, w),
      String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{${w.instructions}}}\par\smallskip\small`,
      String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
      String.raw`\item ${w.contains(parts, totalPts)}${durationMin ? ` ${w.duration(durationText(durationMin, w))}` : ""}`,
      nQcm ? String.raw`\item ${w.qcmConvention} ${w.tick}` : "",
      documentsItem(),
      String.raw`\item ${w.onSheet}`,
      String.raw`\end{enumerate}\vspace{0.3cm}`,
    ].filter(Boolean).join("\n");
  }
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
      return `\\item This exam has ${parts.join(" and ")}, for a total of \\textbf{${totalPts} points}.${durationMin ? ` You have ${durationMin} minutes.` : ""}`;
    })(),
    nQcm ? `\\item ${convention} Tick the box(es) \\fbox{$\\checkmark$} you believe are correct.` : "",
    documentsItem(),
    String.raw`\item Answer directly on this exam sheet, in the space provided.`,
    String.raw`\end{enumerate}\vspace{0.3cm}`,
  ].filter(Boolean).join("\n");
}

/** Garde des questions composées. */
function blocksCover(dateLabel: string, n: number, totalPts: number, durationMin: number | null): string {
  // EPFL hors anglais : même garde, consignes dans la langue de l'examen.
  const w = epflWords();
  if (w) {
    return [
      ...coverHeader(dateLabel, durationMin, w),
      String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{${w.instructions}}}\par\smallskip\small`,
      String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
      String.raw`\item ${w.blocks(n, totalPts)}${durationMin ? ` ${w.duration(durationText(durationMin, w))}` : ""}`,
      String.raw`\item ${w.blocksHow}`,
      documentsItem(),
      String.raw`\item ${w.onSheet}`,
      String.raw`\end{enumerate}\vspace{0.3cm}`,
    ].filter(Boolean).join("\n");
  }
  return [
    ...coverHeader(dateLabel, durationMin),
    String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{Instructions}}\par\smallskip\small`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
    `\\item This exam has \\textbf{${n} questions}, each made of a short scenario or code excerpt followed by sub-questions, for a total of \\textbf{${totalPts} points}.${durationMin ? ` You have ${durationMin} minutes.` : ""}`,
    String.raw`\item Single-choice sub-questions have exactly one correct answer: tick its box \fbox{$\checkmark$}. For code excerpts, write the exact output. Short answers take one to three sentences.`,
    documentsItem(),
    String.raw`\item Answer directly on this exam sheet, in the space provided.`,
    String.raw`\end{enumerate}\vspace{0.3cm}`,
  ].filter(Boolean).join("\n");
}

/**
 * Garde d'un examen écrit de l'EPFL HORS CS-202 : durée, documents permis et langue viennent du
 * format de l'examen (déclaré ou détecté), jamais du texte de CS-202 (prod du 13/11 : « You have
 * 3 hours », notes autorisées, en anglais, pour un examen déclaré de 60 min sans documents en
 * français). Une règle inconnue (documents non déclarés) n'est pas écrite plutôt que devinée.
 */
function writtenCover(qs: ExamQuestion[], dateLabel: string): string {
  const total = qs.reduce((s, q) => s + qPoints(q), 0);
  const c = getCourse(currentCourse());
  const f = formatContextFor(currentCourse());
  const w = coverWords(f.language);
  // Durée du format (annale, déclaration) seulement : la spec du générateur et la fiche du cours
  // portent un 180 par défaut (audit 3, P1-3). Inconnue → la consigne n'est pas écrite.
  const dur = durationOf(f);
  const examCodeTex = texEscape(c.examCode).replace(/-/g, "--");
  const uniLines = c.universityLines.map(texEscape).join(String.raw`\\ `);
  const profsTex = c.profs.map(texEscape).join(", ");
  const facultyLine = [c.faculty ? String.raw`\textbf{${texEscape(c.faculty)}}` : "", `${examCodeTex} ${texEscape(c.examName)}`, profsTex].filter(Boolean).join(String.raw`\\ `);
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.30\textwidth}\vspace{0pt}\epfllogo[30]\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.64\textwidth}\vspace{2pt}\raggedleft\footnotesize\scshape`,
    String.raw`${uniLines}\end{minipage}`,
    String.raw`\vspace{2pt}\noindent\rule{\textwidth}{1pt}`,
    String.raw`\noindent\begin{minipage}[t]{0.7\textwidth}\vspace{0pt}\footnotesize ${facultyLine}\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.25\textwidth}\vspace{0pt}\raggedleft\footnotesize ${w.anonymisation}\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{10pt}\noindent\normalsize ${w.name} Hanon Ymous \quad(000000)\hfill\textbf{${w.seat}} 0`,
    String.raw`\vspace{0.5cm}\begin{center}{\Large\textbf{${examCodeTex} ${texEscape(c.examName.toUpperCase())}}}\\[6pt]{\large\textbf{${texEscape(epflExamKind(c))}}}\\[5pt]${localDate(dateLabel, w)}\end{center}`,
    String.raw`\vspace{0.25cm}\noindent{\large\textbf{${w.instructions}}}\par\smallskip`,
    String.raw`\noindent ${w.important}`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{2pt}`,
    ...(dur ? [String.raw`\item ${w.duration(durationText(dur, w))}`] : []),
    ...(f.documents ? [String.raw`\item ${w.documents[f.documents]}`] : []),
    String.raw`\item ${w.ink}`,
    String.raw`\item ${w.onSheet}`,
    String.raw`\item ${w.readCarefully}`,
    String.raw`\item ${w.exercises(qs.length, total)}`,
    String.raw`\end{enumerate}`,
    String.raw`\vspace{0.25cm}`,
    gradingTableTex(qs, w.leaveEmpty),
  ].join("\n");
}

/** Garde canonique de cs-202 (texte historique, empreinte de tests/tex-guard). */
function cs202Cover(qs: ExamQuestion[], dateLabel: string, specDurationMin: number | null): string {
  const total = qs.reduce((s, q) => s + qPoints(q), 0);
  const dur = specDurationMin ?? 180;
  const hours = Math.round(dur / 60);
  // métadonnées du cours courant (cs-202 reproduit le texte historique à l'identique)
  const c = getCourse(currentCourse());
  // Toutes échappées (audit du 14/11/2026, 🔴 1) : sans caractère spécial, le texte est inchangé.
  const examCodeTex = texEscape(c.examCode).replace(/-/g, "--"); // « CS-202 » → « CS--202 » (en-dash LaTeX)
  const uniLines = c.universityLines.map(texEscape).join("\\\\ ");
  const profs = c.profs.map(texEscape);
  const profsTex = profs.length
    ? profs.slice(0, -1).join(", ") + (profs.length > 1 ? " \\& " : "") + profs[profs.length - 1]
    : "";
  const facultyLine = [`\\textbf{${texEscape(c.faculty)}}`, `${examCodeTex} ${texEscape(c.examName)}`, profsTex].filter(Boolean).join("\\\\ ");
  // cs-202 en base peut ne pas renseigner son établissement : le logo suit la fiche, comme avant.
  const logoTex = c.university === "EPFL" ? String.raw`\epfllogo[30]` : "";
  return [
    String.raw`\thispagestyle{empty}`,
    `\\noindent\\begin{minipage}[t]{0.30\\textwidth}\\vspace{0pt}${logoTex}\\end{minipage}\\hfill`,
    String.raw`\begin{minipage}[t]{0.64\textwidth}\vspace{2pt}\raggedleft\footnotesize\scshape`,
    `${uniLines}\\end{minipage}`,
    String.raw`\vspace{2pt}\noindent\rule{\textwidth}{1pt}`,
    `\\noindent\\begin{minipage}[t]{0.7\\textwidth}\\vspace{0pt}\\footnotesize${facultyLine}\\end{minipage}\\hfill`,
    String.raw`\begin{minipage}[t]{0.25\textwidth}\vspace{0pt}\raggedleft\footnotesize Anonymisation:\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{10pt}\noindent\normalsize NOM : Hanon Ymous \quad(000000)\hfill\textbf{Seat \#:} 0`,
    `\\vspace{0.5cm}\\begin{center}{\\Large\\textbf{${examCodeTex} ${texEscape(c.examName.toUpperCase())}}}\\\\[6pt]{\\large\\textbf{${texEscape(c.examKind)}}}\\\\[5pt]${epflLongDate(dateLabel)}\\end{center}`,
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

/**
 * En-tête et pied d'un examen écrit : le préambule commun porte ceux de cs-202 (chaîne vide →
 * sortie byte-identique) ; les autres cours de l'EPFL y mettent leur identité.
 */
function writtenChrome(dateLabel: string): string[] {
  const id = currentCourse();
  const c = getCourse(id);
  if (id === DEFAULT_COURSE) return ["", "", String.raw`\newcommand{\FOOTDATE}{${epflLongDate(dateLabel)}}`];
  const code = texEscape(c.examCode).replace(/-/g, "--");
  const profsTex = texEscape(c.profs.length ? c.profs.join(", ") : c.university);
  // Hors registre : le gabarit par défaut du préambule.
  const override = c.id !== id ? "" : [
    `\\fancyhead[R]{\\qrcode[height=1.25cm]{${qrText(c.examCode)}-EXAM}}`,
    `\\fancyfoot[C]{\\small\\textbf{${code}, ${texEscape(epflExamKind(c))}}\\\\[-2pt]\\small ${profsTex}}`,
    ...epflLocalChrome(true),
  ].join("\n");
  return [genericPreamble(), override, String.raw`\newcommand{\FOOTDATE}{${localDate(dateLabel, courseWords())}}`];
}

/** En-tête et pied d'un QCM ou de questions composées (le préambule est écrit pour CS-202). */
function qcmChrome(dateLabel: string): string[] {
  const c = getCourse(currentCourse());
  // Métadonnées saisies à la création du cours : échappées (audit du 14/11/2026, 🔴 1). texEscape,
  // pas esc : esc remplace tout caractère au-delà de Latin-1 par une espace (« Dvořák »).
  const code = texEscape(c.examCode).replace(/-/g, "--");
  const profsTex = c.profs.map(texEscape).join(", ");
  return [
    [
      String.raw`\fancyhead[L]{}`,
      `\\fancyhead[R]{\\qrcode[height=1.25cm]{${qrText(c.examCode)}-FINAL-EXAM}}`,
      `\\fancyfoot[C]{\\small\\textbf{${code}, ${texEscape(epflExamKind(c))}}${profsTex ? `\\\\[-2pt]\\small ${profsTex}` : ""}}`,
      ...epflLocalChrome(false),
    ].join("\n"),
    String.raw`\newcommand{\FOOTDATE}{${epflDate(dateLabel)}}`,
  ];
}

const EPFL_QCM_LABELS: QcmLabels = {
  questionWord: "Question",
  openWord: "Open question",
  question: (n) => `Question ${n}.`,
  tag: (type, points) => `${type === "mcq" ? "MCQ" : "SCQ"}, ${points} pt${points > 1 ? "s" : ""}`,
  kind: (type) => (type === "mcq" ? "MCQ" : "SCQ"),
  misconception: "misconception: ",
  solution: "Solution:",
  openQuestion: (n) => `Open question ${n}`,
  points: (n) => `${n} points`,
  openSolution: "Solution.",
  color: solutionColor("epfl"),
  qcmPart: (withOpen) => (withOpen ? "First part \\quad-- Multiple-choice and single-choice questions" : "Multiple-choice and single-choice questions"),
  openPart: (withQcm) => (withQcm ? "Second part \\quad-- Open questions" : "Open questions"),
  pageBeforeFirstOpen: true,
};

const EPFL_BLOCK_LABELS: BlockLabels = {
  question: "Question", pts: (n) => `${n} pt${n > 1 ? "s" : ""}`, output: "Output:", modelAnswer: "Model answer:",
  grading: "Grading:", solution: "Solution:", color: solutionColor("epfl"),
};

const CS202_WRITTEN_LABELS: WrittenLabels = {
  solutionsTitle: "Corrigé",
  solutionHead: (n, concept, points) => String.raw`\par\medskip\needspace{4\baselineskip}{\large\textbf{Question ${n} : ${concept} \hfill [${points} points]}}\par\smallskip`,
};

/** Le PDF de la mise en page de l'EPFL, pour le cours courant. */
export function epflPdf(layout: ExamLayout): ExamPdf {
  // EPFL en anglais : le texte historique ; hors anglais, ses mots, sur la mise en page de l'EPFL.
  const w = epflWords();
  const color = solutionColor("epfl");
  return {
    layout,
    preamble: (src) => src,
    chrome: (form: ExamForm, dateLabel: string) => (form === "written" ? writtenChrome(dateLabel) : qcmChrome(dateLabel)),
    cover: async (f: CoverFacts) => {
      if (f.form === "qcm") return qcmCover(f.dateLabel, f.nQcm, f.nOpen, f.totalPts, f.durationMin);
      if (f.form === "blocks") return blocksCover(f.dateLabel, f.n, f.totalPts, f.durationMin);
      return currentCourse() === DEFAULT_COURSE ? cs202Cover(f.questions, f.dateLabel, f.specDurationMin) : writtenCover(f.questions, f.dateLabel);
    },
    qcm: w ? localQcmLabels(w, color, true) : EPFL_QCM_LABELS,
    blocks: w ? localBlockLabels(w, color) : EPFL_BLOCK_LABELS,
    // Les titres du corrigé suivent la langue de l'examen ; seul cs-202 garde son texte (empreinte canonique).
    written: currentCourse() === DEFAULT_COURSE ? CS202_WRITTEN_LABELS : localWrittenLabels(courseWords()),
    logo: true,
  };
}
