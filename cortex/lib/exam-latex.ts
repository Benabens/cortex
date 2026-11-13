import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTexSafe } from "@/lib/tex-guard";
import { currentCourse } from "@/db/client";
import { DEFAULT_COURSE, getCourse } from "@/lib/courses";
import type { ExamQuestion, ExamSpec } from "@/lib/exam";
import { examsDir } from "@/lib/paths";
import { formatContextFor, type DocumentRule, type Language } from "@/lib/exam-format";

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
    // Un modèle peut oublier de doubler l'antislash dans son JSON : `\begin` devient alors
    // U+0008 + "egin" et `\frac` U+000C + "rac" après JSON.parse, ce que TeX refuse comme
    // « invalid character ». Ces contrôles n'ont aucun emploi légitime dans un source LaTeX.
    .replace(/\u0008/g, String.raw`\b`)
    .replace(/\u000c/g, String.raw`\f`)
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

/** Textes de la garde d'un cours hors CS-202, dans la langue de l'examen (repli : anglais). */
type CoverWords = {
  months: string[];
  date: (d: number, month: string, y: string) => string;
  duration: (d: string) => string;
  minutes: (n: number) => string;
  hours: (n: number) => string;
  documents: Record<DocumentRule, string>;
  instructions: string;
  important: string;
  ink: string;
  onSheet: string;
  readCarefully: string;
  exercises: (n: number, total: number) => string;
  leaveEmpty: string;
  name: string;
  seat: string;
  anonymisation: string;
};

const COVER_WORDS: Record<Language, CoverWords> = {
  en: {
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    date: (d, m, y) => `${m} ${d}, ${y}`,
    duration: (d) => `You have ${d} to complete this examination.`,
    minutes: (n) => `${n} minutes`,
    hours: (n) => `${n} hours`,
    documents: { none: "No documents are allowed.", notes: "Personal notes are allowed.", open: "All documents are allowed." },
    instructions: "INSTRUCTIONS (please read carefully)",
    important: String.raw`\textbf{IMPORTANT!} Please strictly follow these instructions.`,
    ink: String.raw`You must \textbf{use black or dark blue ink}, neither pencil nor any other color.`,
    onSheet: String.raw`Answer the questions \textbf{directly on the exam sheet}, in the space provided.`,
    readCarefully: String.raw`Carefully and \emph{completely} read each question so as to do only what is actually asked.`,
    exercises: (n, t) => `The exam consists of ${n} independent exercises (points are indicated, the total is ${t} points).`,
    leaveEmpty: "LEAVE THIS EMPTY",
    name: "NAME:", seat: String.raw`Seat \#:`, anonymisation: "Anonymisation:",
  },
  fr: {
    months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    date: (d, m, y) => `${d === 1 ? String.raw`1\textsuperscript{er}` : d} ${m} ${y}`,
    duration: (d) => `Vous disposez de ${d} pour cet examen.`,
    minutes: (n) => `${n} minutes`,
    hours: (n) => `${n} heures`,
    documents: { none: "Aucun document n'est autorisé.", notes: "Les notes personnelles sont autorisées.", open: "Tous les documents sont autorisés." },
    instructions: "CONSIGNES (à lire attentivement)",
    important: String.raw`\textbf{IMPORTANT !} Respectez strictement ces consignes.`,
    ink: String.raw`Écrivez \textbf{à l'encre noire ou bleu foncé}, ni au crayon ni dans une autre couleur.`,
    onSheet: String.raw`Répondez \textbf{directement sur la feuille d'examen}, dans l'espace prévu.`,
    readCarefully: String.raw`Lisez chaque question attentivement et \emph{en entier}, pour ne faire que ce qui est demandé.`,
    exercises: (n, t) => `L'examen comporte ${n} exercices indépendants (barème indiqué, total : ${t} points).`,
    leaveEmpty: "NE RIEN ÉCRIRE ICI",
    name: "NOM :", seat: String.raw`Place n\textsuperscript{o} :`, anonymisation: "Anonymisation :",
  },
  de: {
    months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    date: (d, m, y) => `${d}. ${m} ${y}`,
    duration: (d) => `Sie haben ${d} Zeit für diese Prüfung.`,
    minutes: (n) => `${n} Minuten`,
    hours: (n) => `${n} Stunden`,
    documents: { none: "Es sind keine Unterlagen erlaubt.", notes: "Persönliche Notizen sind erlaubt.", open: "Alle Unterlagen sind erlaubt." },
    instructions: "ANWEISUNGEN (bitte sorgfältig lesen)",
    important: String.raw`\textbf{WICHTIG!} Befolgen Sie diese Anweisungen genau.`,
    ink: String.raw`Schreiben Sie \textbf{mit schwarzer oder dunkelblauer Tinte}, weder mit Bleistift noch in einer anderen Farbe.`,
    onSheet: String.raw`Beantworten Sie die Fragen \textbf{direkt auf dem Prüfungsblatt}, im vorgesehenen Platz.`,
    readCarefully: String.raw`Lesen Sie jede Frage sorgfältig und \emph{vollständig}.`,
    exercises: (n, t) => `Die Prüfung besteht aus ${n} unabhängigen Aufgaben (Punkte angegeben, insgesamt ${t} Punkte).`,
    leaveEmpty: "BITTE LEER LASSEN",
    name: "NAME:", seat: "Platz Nr.:", anonymisation: "Anonymisierung:",
  },
  it: {
    months: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    date: (d, m, y) => `${d} ${m} ${y}`,
    duration: (d) => `Avete ${d} per completare questo esame.`,
    minutes: (n) => `${n} minuti`,
    hours: (n) => `${n} ore`,
    documents: { none: "Nessun documento è ammesso.", notes: "Gli appunti personali sono ammessi.", open: "Tutti i documenti sono ammessi." },
    instructions: "ISTRUZIONI (da leggere attentamente)",
    important: String.raw`\textbf{IMPORTANTE!} Seguite rigorosamente queste istruzioni.`,
    ink: String.raw`Scrivete \textbf{con inchiostro nero o blu scuro}, né a matita né in un altro colore.`,
    onSheet: String.raw`Rispondete \textbf{direttamente sul foglio d'esame}, nello spazio previsto.`,
    readCarefully: String.raw`Leggete ogni domanda attentamente e \emph{per intero}.`,
    exercises: (n, t) => `L'esame comprende ${n} esercizi indipendenti (punti indicati, totale ${t} punti).`,
    leaveEmpty: "NON SCRIVERE QUI",
    name: "NOME:", seat: "Posto n.:", anonymisation: "Anonimizzazione:",
  },
  es: {
    months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    date: (d, m, y) => `${d} de ${m} de ${y}`,
    duration: (d) => `Dispone de ${d} para este examen.`,
    minutes: (n) => `${n} minutos`,
    hours: (n) => `${n} horas`,
    documents: { none: "No se permite ningún documento.", notes: "Se permiten los apuntes personales.", open: "Se permiten todos los documentos." },
    instructions: "INSTRUCCIONES (léalas con atención)",
    important: String.raw`\textbf{¡IMPORTANTE!} Siga estrictamente estas instrucciones.`,
    ink: String.raw`Escriba \textbf{con tinta negra o azul oscuro}, ni a lápiz ni en otro color.`,
    onSheet: String.raw`Responda \textbf{directamente en la hoja de examen}, en el espacio previsto.`,
    readCarefully: String.raw`Lea cada pregunta con atención y \emph{por completo}.`,
    exercises: (n, t) => `El examen consta de ${n} ejercicios independientes (puntos indicados, total: ${t} puntos).`,
    leaveEmpty: "NO ESCRIBA AQUÍ",
    name: "NOMBRE:", seat: "Asiento n.º:", anonymisation: "Anonimización:",
  },
  pt: {
    months: ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    date: (d, m, y) => `${d} de ${m} de ${y}`,
    duration: (d) => `Dispõe de ${d} para este exame.`,
    minutes: (n) => `${n} minutos`,
    hours: (n) => `${n} horas`,
    documents: { none: "Não é permitido nenhum documento.", notes: "São permitidas notas pessoais.", open: "São permitidos todos os documentos." },
    instructions: "INSTRUÇÕES (leia com atenção)",
    important: String.raw`\textbf{IMPORTANTE!} Siga rigorosamente estas instruções.`,
    ink: String.raw`Escreva \textbf{a tinta preta ou azul-escura}, nem a lápis nem noutra cor.`,
    onSheet: String.raw`Responda \textbf{diretamente na folha de exame}, no espaço previsto.`,
    readCarefully: String.raw`Leia cada pergunta com atenção e \emph{por inteiro}.`,
    exercises: (n, t) => `O exame tem ${n} exercícios independentes (pontuação indicada, total: ${t} pontos).`,
    leaveEmpty: "NÃO ESCREVER AQUI",
    name: "NOME:", seat: "Lugar n.º:", anonymisation: "Anonimização:",
  },
  nl: {
    months: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
    date: (d, m, y) => `${d} ${m} ${y}`,
    duration: (d) => `U hebt ${d} voor dit examen.`,
    minutes: (n) => `${n} minuten`,
    hours: (n) => `${n} uur`,
    documents: { none: "Er zijn geen documenten toegestaan.", notes: "Persoonlijke aantekeningen zijn toegestaan.", open: "Alle documenten zijn toegestaan." },
    instructions: "INSTRUCTIES (lees aandachtig)",
    important: String.raw`\textbf{BELANGRIJK!} Volg deze instructies nauwgezet.`,
    ink: String.raw`Schrijf \textbf{met zwarte of donkerblauwe inkt}, niet met potlood of in een andere kleur.`,
    onSheet: String.raw`Beantwoord de vragen \textbf{rechtstreeks op het examenblad}, in de voorziene ruimte.`,
    readCarefully: String.raw`Lees elke vraag aandachtig en \emph{volledig}.`,
    exercises: (n, t) => `Het examen bestaat uit ${n} onafhankelijke oefeningen (punten aangegeven, totaal ${t} punten).`,
    leaveEmpty: "HIER NIETS SCHRIJVEN",
    name: "NAAM:", seat: "Plaats nr.:", anonymisation: "Anonimisering:",
  },
};

function coverWords(language: string): CoverWords {
  return COVER_WORDS[language as Language] ?? COVER_WORDS.en;
}

function localDate(dateLabel: string, w: CoverWords): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return texEscape(dateLabel);
  return w.date(+m[3], w.months[+m[2] - 1] ?? "", m[1]);
}

/** Durée lisible : en heures à partir de 2 h pile (« 3 heures »), sinon en minutes (« 60 minutes », « 90 minutes »). */
function durationText(min: number, w: CoverWords): string {
  return min >= 120 && min % 60 === 0 ? w.hours(min / 60) : w.minutes(min);
}

/**
 * Garde d'un cours HORS CS-202 : durée, documents permis et langue viennent du format de
 * l'examen (déclaré ou détecté), jamais du texte de CS-202 (prod du 13/11 : « You have 3 hours »,
 * notes autorisées, en anglais, pour un examen déclaré de 60 min sans documents en français).
 * Une règle inconnue (documents non déclarés) n'est pas écrite plutôt que devinée.
 */
function genericCoverTex(spec: ExamSpec, qs: ExamQuestion[], dateLabel: string): string {
  const total = qs.reduce((s, q) => s + qPoints(q), 0);
  const c = getCourse(currentCourse());
  const f = formatContextFor(currentCourse());
  const w = coverWords(f.language);
  const dur = f.durationMin ?? spec.duration_min ?? c.durationMin;
  const examCodeTex = texEscape(c.examCode).replace(/-/g, "--");
  const uniLines = c.universityLines.map(texEscape).join(String.raw`\\ `);
  const profsTex = c.profs.map(texEscape).join(", ");
  const facultyLine = [c.faculty ? String.raw`\textbf{${texEscape(c.faculty)}}` : "", `${examCodeTex} ${texEscape(c.examName)}`, profsTex].filter(Boolean).join(String.raw`\\ `);
  const logoTex = c.university === "EPFL" ? String.raw`\epfllogo[30]` : "";
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\noindent\begin{minipage}[t]{0.30\textwidth}\vspace{0pt}${logoTex}\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.64\textwidth}\vspace{2pt}\raggedleft\footnotesize\scshape`,
    String.raw`${uniLines}\end{minipage}`,
    String.raw`\vspace{2pt}\noindent\rule{\textwidth}{1pt}`,
    String.raw`\noindent\begin{minipage}[t]{0.7\textwidth}\vspace{0pt}\footnotesize ${facultyLine}\end{minipage}\hfill`,
    String.raw`\begin{minipage}[t]{0.25\textwidth}\vspace{0pt}\raggedleft\footnotesize ${w.anonymisation}\\ \textbf{\#0000}\end{minipage}`,
    String.raw`\vspace{10pt}\noindent\normalsize ${w.name} Hanon Ymous \quad(000000)\hfill\textbf{${w.seat}} 0`,
    String.raw`\vspace{0.5cm}\begin{center}{\Large\textbf{${examCodeTex} ${texEscape(c.examName.toUpperCase())}}}\\[6pt]{\large\textbf{${texEscape(c.examKind)}}}\\[5pt]${localDate(dateLabel, w)}\end{center}`,
    String.raw`\vspace{0.25cm}\noindent{\large\textbf{${w.instructions}}}\par\smallskip`,
    String.raw`\noindent ${w.important}`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{2pt}`,
    String.raw`\item ${w.duration(durationText(dur, w))}`,
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

function coverTex(spec: ExamSpec, qs: ExamQuestion[], dateLabel: string): string {
  if (currentCourse() !== DEFAULT_COURSE) return genericCoverTex(spec, qs, dateLabel);
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
  // Logo institutionnel : réservé à EPFL. Un cours hors EPFL ne doit produire
  // AUCUNE marque EPFL. cs-202 (university="EPFL") reste
  // byte-identique : la garde émet exactement `\epfllogo[30]` comme avant.
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

/** Fin de l'argument `{…}` qui s'ouvre à `open` (accolades équilibrées, `\{` ignoré) ; -1 si non fermé. */
function closingBrace(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Retire l'encadré `\callout{… FOR ALL STUDENTS …}` : il distingue les sections IN et SC de
 * CS-202 et n'a aucun sens ailleurs (prod du 13/11 : en anglais dans un examen en français).
 */
function dropSectionCallouts(t: string): string {
  let out = "";
  let from = 0;
  for (let at = t.indexOf(String.raw`\callout{`); at >= 0; at = t.indexOf(String.raw`\callout{`, from)) {
    const end = closingBrace(t, at + String.raw`\callout`.length);
    if (end < 0) break;
    if (/FOR\s+ALL\s+STUDENTS/i.test(t.slice(at, end))) {
      out += t.slice(from, at);
      from = end + 1;
    } else {
      out += t.slice(from, end + 1);
      from = end + 1;
    }
  }
  return out + t.slice(from);
}

/**
 * Sous-questions numérotées d'après la question qui les porte. Le modèle écrit `\subq{1.1}`
 * sans connaître la place finale de son exercice (lots générés à part, tri par catégorie) :
 * prod du 13/11, sous-questions 1.1–1.5 sous la question 2.
 */
function renumberSubquestions(t: string, question: number): string {
  return t.replace(/\\subq\{\s*\d+\s*\.\s*(\d+)\s*\}/g, (_m, sub: string) => String.raw`\subq{${question}.${sub}}`);
}

/** Compléments du préambule hors CS-202 (latex/generic.tex : indicatrice…). */
function genericPreamble(): string {
  const p = path.join(LATEX_DIR, "generic.tex");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/**
 * Indicatrice écrite en `\indic` (défini par latex/generic.tex) : `\mathbb{1}` d'amssymb rend un
 * glyphe cassé (prod du 13/11 : 𝟙[z>0] affiché comme ⊮), `\mathbbm` exige un paquet absent et
 * 𝟙 (U+1D7D9) n'existe pas dans les polices du PDF. Le groupe `{\indic}` garde un indice
 * (`\mathbb{1}_{z>0}`) accroché au symbole.
 */
function indicatorTex(t: string): string {
  return t
    .replace(/\\math(?:bbm|bb|ds)\s*(?:\{\s*1\s*\}|1(?![0-9]))/g, String.raw`{\indic}`)
    .replace(/\u{1D7D9}/gu, String.raw`\ensuremath{\indic}`);
}

/**
 * LaTeX du modèle pour un cours HORS CS-202, avant rendu. CS-202 garde son texte tel quel
 * (empreinte canonique byte-identique, invariant n° 1).
 */
function courseTex(t: string, question: number): string {
  if (currentCourse() === DEFAULT_COURSE) return t;
  return indicatorTex(renumberSubquestions(dropSectionCallouts(t), question));
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
        unwrapLockedFigures(courseTex((q as any).statement_tex ?? "", i + 1)),
      ].join("\n")
    )
    .join("\n\n");

  const solutions = [
    String.raw`\clearpage{\Large\textbf{Corrigé}}\par\vspace{6pt}\hrule\medskip`,
    ...qs.map((q, i) =>
      [
        String.raw`\par\medskip\needspace{4\baselineskip}{\large\textbf{Question ${i + 1} : ${texEscape(q.concept)} \hfill [${qPoints(q)} points]}}\par\smallskip`,
        unwrapLockedFigures(courseTex((q as any).solution_tex ?? "", i + 1)),
      ].join("\n")
    ),
  ].join("\n\n");

  return [
    preamble,
    currentCourse() === DEFAULT_COURSE ? "" : genericPreamble(),
    courseHeaderOverride(),
    String.raw`\newcommand{\FOOTDATE}{${currentCourse() === DEFAULT_COURSE ? footDate(dateLabel) : localDate(dateLabel, coverWords(formatContextFor(currentCourse()).language))}}`,
    String.raw`\begin{document}`,
    coverTex(spec, qs, dateLabel),
    body,
    includeSolutions ? solutions : "",
    String.raw`\end{document}`,
  ].filter(Boolean).join("\n");
}

/**
 * En-tête/pied de page COURSE-AWARE : le preamble partagé porte le gabarit
 * historique du cours par défaut ; pour tout AUTRE cours on l'override avec l'identité du cours
 * (même mécanique que qcm-latex). Cours par défaut → chaîne vide → sortie BYTE-IDENTIQUE.
 */
function courseHeaderOverride(): string {
  const id = currentCourse();
  const c = getCourse(id);
  if (id === DEFAULT_COURSE) return ""; // gabarit historique intact (hashé, byte-identique)
  if (c.id !== id) return ""; // hors registre → gabarit par défaut
  const code = c.examCode.replace(/-/g, "--");
  const profsTex = c.profs.length ? c.profs.join(", ") : c.university;
  return [
    `\\fancyhead[R]{\\qrcode[height=1.25cm]{${c.examCode}-EXAM}}`,
    `\\fancyfoot[C]{\\small\\textbf{${code}, ${c.examKind}}\\\\[-2pt]\\small ${profsTex}}`,
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

/** Le binaire tectonic supporte-t-il `--untrusted` ? (sondé une fois par binaire) */
const _untrusted = new Map<string, boolean>();
export function tectonicSupportsUntrusted(bin: string): boolean {
  const known = _untrusted.get(bin);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10_000 });
    ok = /--untrusted/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  } catch { ok = false; }
  _untrusted.set(bin, ok);
  return ok;
}

/**
 * Arguments de tectonic. `--untrusted` désactive les fonctions connues comme
 * dangereuses (shell-escape) — le source a déjà passé lib/tex-guard, ceci est
 * la seconde barrière. Sans support (vieille version), on compile sans.
 */
export function tectonicArgs(tex: string, opts: { untrustedSupported: boolean }): string[] {
  return [...(opts.untrustedSupported ? ["--untrusted"] : []), "--chatter", "minimal", "--keep-logs", tex];
}

/** Encadré qui remplace une figure générée qui ne compilait pas. */
const DROPPED_FIGURE = "\\fbox{\\parbox{0.8\\linewidth}{\\centering\\small Figure retirée : elle ne se compilait pas.}}";

/**
 * Le document sans la figure (tikzpicture) qui contient la ligne `line` (1-based), remplacée par un
 * encadré ; null si la ligne n'est dans aucune figure. Banc moteur du 04/11/2026 (CS-202) : un nœud
 * d'arbre de processus généré (« Missing \endgroup inserted ») faisait tomber énoncé et corrigé.
 */
export function dropFailingFigure(tex: string, line: number): string | null {
  const lines = tex.split("\n");
  const at = line - 1;
  let begin = -1;
  for (let i = Math.min(at, lines.length - 1); i >= 0; i--) {
    if (/\\end\{tikzpicture\}/.test(lines[i]) && i < at) break;
    if (/\\begin\{tikzpicture\}/.test(lines[i])) { begin = i; break; }
  }
  if (begin < 0) return null;
  let end = -1;
  for (let i = Math.max(at, begin); i < lines.length; i++) if (/\\end\{tikzpicture\}/.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  // Seulement une figure qui occupe ses propres lignes : retirer une ligne de texte où une figure
  // est en ligne ôterait du contenu (le repli en texte simple de l'appelant s'en charge).
  if (end === begin || !/^\\begin\{tikzpicture\}(\[[^\]]*\])?$/.test(lines[begin].trim()) || lines[end].trim() !== "\\end{tikzpicture}") return null;
  return [...lines.slice(0, begin), DROPPED_FIGURE, ...lines.slice(end + 1)].join("\n");
}

/** Macros de babel-french que le modèle écrit, que le préambule (sans babel) ne définit pas. */
const FRENCH_MACROS: [RegExp, string][] = [
  [/\\og(\{\})?\s*/g, "« "],
  [/\s*\\fg(\{\})?/g, " »"],
  [/\\iere(\{\})?/g, "\\textsuperscript{re}"],
  [/\\ier(\{\})?/g, "\\textsuperscript{er}"],
  [/\\ieme(\{\})?/g, "\\textsuperscript{e}"],
  [/\\up\{([^{}]*)\}/g, "\\textsuperscript{$1}"],
  [/\\nombre\{([^{}]*)\}/g, "$1"],
  [/\\bsc\{([^{}]*)\}/g, "\\textsc{$1}"],
];
const FRENCH_MACRO = /\\(og|fg|iere|ier|ieme|up|nombre|bsc)(?![a-zA-Z])/;

/**
 * Le document où les macros de babel-french sont remplacées par leur équivalent, si la ligne
 * fautive en contient une ; null sinon. Banc moteur du 04/11/2026 (synth-written12) : « \og » non
 * défini, ligne 375 : douze exercices livrés sans PDF. Le préambule partagé reste intact (le rendu
 * de CS-202 est épinglé octet pour octet).
 */
export function repairFrenchMacros(tex: string, line: number): string | null {
  if (!FRENCH_MACRO.test(tex.split("\n")[line - 1] ?? "")) return null;
  return FRENCH_MACROS.reduce((t, [re, to]) => t.replace(re, to), tex);
}

/** Ligne fautive d'une compilation : « error: x.tex:648: … » (tectonic) ou « l.648 » (journal pdflatex). */
export function failingLine(text: string): number | null {
  // Les avertissements (« warning: x.tex:85: Underfull… ») précèdent l'erreur : seule la ligne « error: » compte.
  const m = /^error: [^\n]*?\.tex:(\d+):/m.exec(text) ?? /^l\.(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

export async function compileExamPdf(base: string): Promise<string> {
  // Une figure générée qui ne compile pas est retirée (encadré), des macros de babel-french sont
  // remplacées, puis on recompile (3 fois au plus).
  for (let attempt = 0; ; attempt++) {
    try {
      return await compileOnce(base);
    } catch (e) {
      const texAbs = path.join(examsDir(), `${base}.tex`);
      const line = failingLine(`${(e as { raw?: string }).raw ?? ""}\n${readLog(base)}`);
      const src = attempt < 3 && line && fs.existsSync(texAbs) ? fs.readFileSync(texAbs, "utf8") : null;
      const fixed = src && line ? dropFailingFigure(src, line) ?? repairFrenchMacros(src, line) : null;
      if (!fixed) throw e;
      fs.writeFileSync(texAbs, fixed);
    }
  }
}

async function compileOnce(base: string): Promise<string> {
  const tex = `${base}.tex`;
  const pdf = `${base}.pdf`;
  const pdfAbs = path.join(examsDir(), pdf);
  let raw = "";
  let lastErr = "Aucun moteur LaTeX trouvé (installe tectonic : brew install tectonic).";
  for (const { bin, kind } of texCandidates()) {
    try {
      if (kind === "tectonic") {
        const r = await spawnP(bin, tectonicArgs(tex, { untrustedSupported: tectonicSupportsUntrusted(bin) }), examsDir(), 240_000);
        if (r.code === 0 && fs.existsSync(pdfAbs)) return pdf;
        raw = r.err ?? "";
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
  throw Object.assign(new Error(`Échec compilation LaTeX. ${lastErr}`), { raw });
}

function readLog(base: string): string {
  const log = path.join(examsDir(), `${base}.log`);
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
}

/** Bruit du paquet qrcode, pris pour des erreurs (« Error-correction level increased from M to Q »). */
const QR_NOISE = /Error-correction level|errorblock|error block|Splitting off block/i;

function tailLog(base: string): string {
  const lines = readLog(base).split("\n").filter((l) => /^!|error|Undefined|Runaway/i.test(l) && !QR_NOISE.test(l));
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

/** Groupe {…} équilibré qui s'ouvre en src[i] (espaces sautés) ; null s'il n'y en a pas ou s'il n'est pas fermé. */
function readGroup(src: string, i: number): { inner: string; end: number } | null {
  while (src[i] === " " || src[i] === "\n" || src[i] === "\t") i++;
  if (src[i] !== "{") return null;
  let depth = 0;
  for (let p = i; p < src.length; p++) {
    if (src[p] === "\\") { p++; continue; } // \{ et \} échappés
    if (src[p] === "{") depth++;
    else if (src[p] === "}" && --depth === 0) return { inner: src.slice(i + 1, p), end: p + 1 };
  }
  return null;
}

/**
 * Découpe un corps de tableau au niveau supérieur, sur `&` (cellules) ou `\\` (lignes) : jamais
 * dans des accolades, des maths $…$ ou un environnement imbriqué (pmatrix, tabular…), ni sur `\&`.
 */
function splitTop(src: string, sep: "&" | "\\\\"): string[] {
  const parts: string[] = [];
  let braces = 0, envs = 0, math = false, start = 0;
  const top = () => braces === 0 && envs === 0 && !math;
  for (let p = 0; p < src.length; p++) {
    const c = src[p];
    if (c === "\\") {
      if (src.startsWith("\\begin{", p)) envs++;
      else if (src.startsWith("\\end{", p)) envs = Math.max(0, envs - 1);
      else if (sep === "\\\\" && src[p + 1] === "\\" && top()) { parts.push(src.slice(start, p)); start = p + 2; }
      p++; // commande, ou caractère échappé (\&, \$, \{)
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    else if (c === "$") math = !math;
    else if (c === "&" && sep === "&" && top()) { parts.push(src.slice(start, p)); start = p + 1; }
  }
  parts.push(src.slice(start));
  return parts;
}

/** Remplace chaque environnement tabular (fin appariée, imbrications comprises) par render(corps). */
function replaceTabulars(src: string, render: (body: string) => string): string {
  const OPEN = "\\begin{tabular}", CLOSE = "\\end{tabular}";
  let out = "";
  let i = 0;
  for (;;) {
    const k = src.indexOf(OPEN, i);
    if (k < 0) return out + src.slice(i);
    let p = k + OPEN.length;
    const pos = /^\[[^\]]*\]/.exec(src.slice(p)); // [t], [b]…
    if (pos) p += pos[0].length;
    const cols = readGroup(src, p); // {|c|p{3cm}|…}
    if (!cols) return out + src.slice(i);
    let depth = 1, q = cols.end, end = -1;
    while (end < 0) {
      const o = src.indexOf(OPEN, q), c = src.indexOf(CLOSE, q);
      if (c < 0) break;
      if (o >= 0 && o < c) { depth++; q = o + OPEN.length; }
      else if (--depth === 0) end = c;
      else q = c + CLOSE.length;
    }
    if (end < 0) return out + src.slice(i);
    out += src.slice(i, k) + render(src.slice(cols.end, end));
    i = end + CLOSE.length;
  }
}

/** Corps d'un `tabular` → <table> ; chaque cellule est rendue comme le texte courant (renderCell). */
function tabularToHtml(body: string, renderCell: (tex: string) => string): string {
  const rows = splitTop(body.replace(/\\(hline|toprule|midrule|bottomrule)\b|\\cline\{[^}]*\}/g, ""), "\\\\")
    .map((row) => row.replace(/^\s*\[[^\]]*\]/, "").trim()) // « \\[2pt] » : espacement de ligne
    .filter(Boolean);
  if (!rows.length) return "";
  const cell = (c: string) => {
    const multi = /^\\multicolumn\b/.exec(c);
    const span = multi && readGroup(c, multi[0].length);
    const fmt = span && readGroup(c, span.end);
    const content = fmt && readGroup(c, fmt.end);
    return span && content && /^\d+$/.test(span.inner.trim())
      ? `<td colspan="${span.inner.trim()}">${renderCell(content.inner)}</td>`
      : `<td>${renderCell(c)}</td>`;
  };
  const tr = (row: string) => `<tr>${splitTop(row, "&").map((c) => cell(c.trim())).join("")}</tr>`;
  return `<div class="tab"><table><tbody>${rows.map(tr).join("")}</tbody></table></div>`;
}

/**
 * Convertit le LaTeX du modèle en HTML basique LISIBLE. Repli best-effort (PAS un rendu
 * fidèle) : code en <pre>, gras/italique/code inline, listes, sous-questions en titres,
 * notes à la place des figures/grilles. Le vrai rendu reste le PDF.
 */
export function texToHtml(tex: string): string {
  return renderTex(tex, 0);
}

function renderTex(tex: string, level: number): string {
  let t = tex ?? "";
  const stash: string[] = [];
  // sentinelle impossible dans du LaTeX, survit a escHtml -> zero collision. Une par niveau : le rendu
  // imbriqué d'une cellule de tableau laisse intacts les jetons du niveau parent (code déjà mis de côté).
  const NUL = String.fromCharCode(level);
  const keep = (html: string) => `${NUL}${stash.push(html) - 1}${NUL}`;

  // blocs préservés (code, tableaux) ou remplacés par une note (figures/grilles non rendables en HTML)
  t = t.replace(/\\begin\{lstlisting\}(?:\[[^\]]*\])?\n?([\s\S]*?)\\end\{lstlisting\}/g, (_, c) => keep(`<pre class="code">${escHtml(c.replace(/\s+$/, ""))}</pre>`));
  t = t.replace(/\\begin\{verbatim\}\n?([\s\S]*?)\\end\{verbatim\}/g, (_, c) => keep(`<pre class="code">${escHtml(c.replace(/\s+$/, ""))}</pre>`));
  t = replaceTabulars(t, (body) => keep(tabularToHtml(body, (cell) => renderTex(cell, level + 1))));
  t = t.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, () => keep(`<div class="fig">⬚ figure TikZ : visible uniquement dans le PDF</div>`));
  t = t.replace(/\\begin\{examproctree\}[\s\S]*?\\end\{examproctree\}/g, () => keep(`<div class="fig">⬚ arbre de processus (fork/exec) : visible uniquement dans le PDF</div>`));
  t = t.replace(/\\tcpladder(\{[^{}]*\}){0,6}/g, () => keep(`<div class="fig">⬚ diagramme TCP en échelle (window/cwnd/ssthresh/état + handshake) : à tracer sur papier</div>`));
  t = t.replace(/\\examtopo\b/g, () => keep(`<div class="fig">⬚ Figure : topologie canonique 2-AS (R1–R4, SW1/SW2, clusters A/B/C/D, B1=DNS, D1=d1.epfl.ch, coûts/débits, cloud Internet)</div>`));
  t = t.replace(/\\examinode\b/g, () => keep(`<div class="fig">⬚ Figure : inode v6 (addr[0..7], single/double-indirect → index → data)</div>`));
  t = t.replace(/\\examstates\b/g, () => keep(`<div class="fig">⬚ Figure : états de processus (Running/Ready/Blocked + transitions)</div>`));
  t = t.replace(/\\(packetgrid|statesim|diskgrid|forwardgrid|rulelines)\{(\d+)\}/g, (_, k, n) => keep(`<div class="grid">✎ grille de réponse (${k}, ${n} lignes) : réponds sur papier</div>`));
  t = t.replace(/\\\$/g, () => keep("$")); // dollar littéral ≠ délimiteur math

  // échappe le texte courant
  t = escHtml(t);
  // ligatures LaTeX des tirets (« --- » → —, « -- » → –), sinon « --- » s'affiche tel quel ;
  // jamais dans les maths ni dans le code (\texttt{i--}, \verb|--x| restent tels quels, comme dans le PDF)
  t = t.replace(/(\$\$[\s\S]*?\$\$|\$[^$]*\$|\\texttt\{[^{}]*\}|\\verb(\S)[\s\S]*?\2)|---|--/g, (m, verbatim) => verbatim ?? (m === "---" ? "—" : "–"));

  // macros inline
  t = t.replace(/\\subq\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}/g, `<h3>$1 · $2 <span class="pts">[$3 pts]</span></h3>`);
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
  t = t.replace(/\\&amp;/g, "&amp;").replace(/\\([%#_])/g, "$1").replace(/\\textbackslash\{?\}?/g, "\\");
  t = t.replace(/~/g, " ");
  t = t.replace(/\\ldots/g, "…");
  // macro inconnue : garde l'argument, puis retire les commandes nues et accolades restantes
  for (let pass = 0; pass < 2; pass++) t = t.replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, "$1");
  t = t.replace(/\\[a-zA-Z]+\*?/g, "");
  t = t.replace(/[{}]/g, "");
  t = t.replace(/\n{2,}/g, "<br><br>");

  // blocs préservés réinjectés (un tableau mis de côté peut contenir à son tour des jetons de ce niveau)
  const token = new RegExp(`${NUL}(\\d+)${NUL}`, "g");
  for (let pass = 0; pass < 4 && t.includes(NUL); pass++) t = t.replace(token, (_, i) => stash[+i] ?? "");
  return t;
}

/** Repli HTML LISIBLE si la compilation LaTeX échoue : plus de LaTeX source brut. */
export function htmlFallback(spec: ExamSpec, id: number, dateLabel: string, reason?: string): string {
  const qs = [...spec.questions].sort((a, b) => catRank(a.category) - catRank(b.category));
  const blocks = qs
    .map(
      (q, i) => `<section>
<h2>Question ${i + 1} : ${escHtml(q.concept)} <span class="pts">[${qPoints(q)} points]</span></h2>
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
.tab{overflow-x:auto;margin:10px 0}.tab table{border-collapse:collapse;margin:0 auto}.tab td{border:1px solid #ccc;padding:4px 8px}
.warn{background:#fff3e0;border:1px solid #e0a96d;padding:10px 14px;border-radius:8px;font-size:13.5px}
details{margin:8px 0}summary{cursor:pointer;color:#2563eb;font-size:13px}
.sol{border-left:3px solid #cfe3cf;padding-left:12px;margin-top:6px}
ul,ol{margin:6px 0 6px 22px}
</style>
<h1>${escHtml(spec.title)}</h1>
<p class="warn">⚠️ La compilation LaTeX (PDF) a échoué, rendu HTML lisible de secours (figures/grilles remplacées par des notes).${
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
  // Garde AVANT toute écriture : un source piégé (\input d'un fichier du
  // conteneur…) n'est ni écrit ni compilé — l'exercice échoue.
  const texEnonce = renderExerciseLatex(q, dateLabel, false);
  const texCorrige = renderExerciseLatex(q, dateLabel, true);
  assertTexSafe(texEnonce);
  assertTexSafe(texCorrige);
  fs.writeFileSync(path.join(examsDir(), `${base}.tex`), texEnonce);
  fs.writeFileSync(path.join(examsDir(), `${base}-corrige.tex`), texCorrige);
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
  // Garde AVANT toute écriture (cf. lib/tex-guard) : le rendu lui-même est
  // inchangé — le garde lit, il ne réécrit pas.
  const texEnonce = renderExamTex(spec, dateLabel, false);
  const texCorrige = renderExamTex(spec, dateLabel, true);
  assertTexSafe(texEnonce);
  assertTexSafe(texCorrige);
  fs.writeFileSync(path.join(examsDir(), `${base}.tex`), texEnonce);
  fs.writeFileSync(path.join(examsDir(), `${base}-corrige.tex`), texCorrige);
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
