import { currentCourse } from "@/db/client";
import { DEFAULT_COURSE, getCourse, type CourseConfig } from "@/lib/courses";
import { formatContextFor, LANGUAGES, type DocumentRule, type Language } from "@/lib/exam-format";
import type { BlockLabels, QcmLabels, WrittenLabels } from "@/lib/exam-layout";
import { texEscape } from "@/lib/tex-escape";
import fs from "node:fs";
import path from "node:path";

/**
 * GABARITS D'EXAMEN. Un cours de l'EPFL garde le gabarit historique (logo, anonymisation,
 * SCIPER, rouge des corrigés, consignes de l'EPFL), byte-identique (tests/gabarit-epfl-non-regression,
 * empreinte canonique de cs-202). Tout autre cours reçoit le gabarit NEUTRE : garde générique
 * (cours, durée, total des points, champs Nom et Identifiant), en-tête et pied sans marque,
 * corrigés en bleu foncé, le tout dans la langue de l'examen. Avant le 16/11/2026, un cours
 * de Duke recevait un QCM « EPFL » (logo, SCIPER, marge « Do NOT write anything here! »).
 */
export type ExamTemplate = "epfl" | "neutral";

export function examTemplate(c: Pick<CourseConfig, "id" | "university">): ExamTemplate {
  // cs-202 est le cours de référence de l'EPFL (empreinte canonique) : jamais neutre, même si
  // son établissement n'est pas renseigné en base.
  return c.id === DEFAULT_COURSE || c.university.trim().toUpperCase() === "EPFL" ? "epfl" : "neutral";
}

/** Gabarit du cours courant. */
export function courseTemplate(): ExamTemplate {
  return examTemplate(getCourse(currentCourse()));
}

/** Libellés dans la langue de l'examen du cours courant. */
export function courseWords(): CoverWords {
  return coverWords(formatContextFor(currentCourse()).language);
}

/** Couleur des corrigés : le rouge historique pour l'EPFL, le bleu foncé de neutralChrome hors EPFL. */
export function solutionColor(t: ExamTemplate): string {
  return t === "epfl" ? "epflred" : "solution";
}

/** Textes de la garde d'un cours hors CS-202, dans la langue de l'examen (repli : anglais). */
type BaseWords = {
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

const COVER_WORDS: Record<Language, BaseWords> = {
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
  ko: {
    months: ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"],
    date: (d, m, y) => `${y}년 ${m} ${d}일`,
    duration: (d) => `이 시험을 완료하는 데 ${d}이 주어집니다.`,
    minutes: (n) => `${n}분`,
    hours: (n) => `${n}시간`,
    documents: { none: "어떠한 자료도 허용되지 않습니다.", notes: "개인 노트는 허용됩니다.", open: "모든 자료가 허용됩니다." },
    instructions: "안내 사항 (주의해서 읽어 주세요)",
    important: String.raw`\textbf{중요!} 이 지시 사항을 엄격히 따르십시오.`,
    ink: String.raw`반드시 \textbf{검은색 또는 진한 파란색 잉크}를 사용하십시오. 연필이나 다른 색은 사용하지 마십시오.`,
    onSheet: String.raw`\textbf{시험지에 직접}, 주어진 공간에 답을 작성하십시오.`,
    readCarefully: String.raw`질문을 \emph{끝까지} 주의 깊게 읽고, 요구된 것만 수행하십시오.`,
    exercises: (n, t) => `이 시험은 ${n}개의 독립된 문제로 구성되어 있습니다 (배점이 표시되어 있으며, 총점은 ${t}점입니다).`,
    leaveEmpty: "이 부분은 비워 두십시오",
    name: "이름:", seat: "좌석 번호:", anonymisation: "익명화:",
  },
  he: {
    months: ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"],
    date: (d, m, y) => `${d} ב${m} ${y}`,
    duration: (d) => `יש לכם ${d} להשלמת המבחן.`,
    minutes: (n) => `${n} דקות`,
    hours: (n) => `${n} שעות`,
    documents: { none: "אין להשתמש בחומר כלשהו.", notes: "מותר להשתמש בפתקים אישיים.", open: "מותר להשתמש בכל החומרים." },
    instructions: "הנחיות (קראו בעיון)",
    important: String.raw`\textbf{חשוב!} יש לפעול בהקפדה לפי ההנחיות הבאות.`,
    ink: String.raw`עליכם \textbf{לכתוב בדיו שחורה או כחולה כהה}, לא בעיפרון ולא בצבע אחר.`,
    onSheet: String.raw`ענו על השאלות \textbf{ישירות על גיליון הבחינה}, במקום המיועד לכך.`,
    readCarefully: String.raw`קראו כל שאלה בעיון וב\emph{שלמותה}, כדי לבצע רק את הנדרש.`,
    exercises: (n, t) => `הבחינה מורכבת מ-${n} תרגילים עצמאיים (הניקוד מצוין, הסך הכול ${t} נקודות).`,
    leaveEmpty: "השאירו ריק",
    name: "שם:", seat: "מספר מקום:", anonymisation: "אנונימיזציה:",
  },
  ar: {
    months: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
    date: (d, m, y) => `${d} ${m} ${y}`,
    duration: (d) => `لديك ${d} لإنهاء هذا الامتحان.`,
    minutes: (n) => `${n} دقيقة`,
    hours: (n) => `${n} ساعة`,
    documents: { none: "لا يُسمح بأي وثائق.", notes: "يُسمح بالملاحظات الشخصية.", open: "يُسمح بجميع الوثائق." },
    instructions: "التعليمات (يُرجى القراءة بعناية)",
    important: String.raw`\textbf{مهم!} يُرجى اتباع هذه التعليمات بدقة.`,
    ink: String.raw`يجب \textbf{الكتابة بحبر أسود أو أزرق داكن}، دون استخدام القلم الرصاص أو أي لون آخر.`,
    onSheet: String.raw`أجب عن الأسئلة \textbf{مباشرة على ورقة الامتحان}، في المساحة المخصصة.`,
    readCarefully: String.raw`اقرأ كل سؤال بعناية \emph{وبالكامل}، لتنفيذ ما هو مطلوب فقط.`,
    exercises: (n, t) => `يتكون الامتحان من ${n} تمرينًا مستقلًا (العلامات مُحددة، والمجموع ${t} نقطة).`,
    leaveEmpty: "اترك هذا فارغًا",
    name: "الاسم:", seat: "رقم المقعد:", anonymisation: "إخفاء الهوية:",
  },
};

export function coverWords(language: string): CoverWords {
  const l = (LANGUAGES as readonly string[]).includes(language) ? (language as Language) : "en";
  return { ...COVER_WORDS[l], ...NEUTRAL_WORDS[l] };
}

export function localDate(dateLabel: string, w: CoverWords): string {
  const m = dateLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return texEscape(dateLabel);
  return w.date(+m[3], w.months[+m[2] - 1] ?? "", m[1]);
}

/** Durée lisible : en heures à partir de 2 h pile (« 3 heures »), sinon en minutes (« 60 minutes », « 90 minutes »). */
export function durationText(min: number, w: CoverWords): string {
  return min >= 120 && min % 60 === 0 ? w.hours(min / 60) : w.minutes(min);
}

/** Libellés du gabarit neutre et des rendus QCM / questions composées hors EPFL. */
type NeutralWords = {
  /** Enseignant·e sur la garde des QCM et questions composées de l'EPFL. */
  lecturer: string;
  nameField: string;
  idField: string;
  durationLabel: string;
  totalLabel: string;
  finalExam: string;
  midtermExam: string;
  point: string;
  points: string;
  question: string;
  openQuestion: string;
  part: string;
  qcmPart: string;
  openPart: string;
  single: string;
  multiple: string;
  qcmConvention: string;
  tick: string;
  qcmCount: (n: number) => string;
  openCount: (n: number) => string;
  and: string;
  contains: (parts: string, total: number) => string;
  blocks: (n: number, total: number) => string;
  blocksHow: string;
  output: string;
  modelAnswer: string;
  grading: string;
  solution: string;
  solutions: string;
  misconception: string;
  answers: string;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const NEUTRAL_WORDS: Record<Language, NeutralWords> = {
  en: {
    lecturer: "Lecturer:", nameField: "Name:", idField: "ID:", durationLabel: "Duration:", totalLabel: "Total:", finalExam: "Final exam", midtermExam: "Midterm exam",
    point: "point", points: "points", question: "Question", openQuestion: "Open question", part: "Part",
    qcmPart: "Multiple-choice questions", openPart: "Open questions", single: "single choice", multiple: "multiple choice",
    qcmConvention: "Single-choice questions have exactly one correct answer; multiple-choice questions have one or more.",
    tick: "Tick the box(es) you believe are correct.",
    qcmCount: (n) => `${n} multiple-choice ${plural(n, "question", "questions")}`,
    openCount: (n) => `${n} open ${plural(n, "question", "questions")}`,
    and: "and", contains: (p, t) => `This exam has ${p}, for a total of ${t} points.`,
    blocks: (n, t) => `This exam has ${n} ${plural(n, "question", "questions")}, each made of a scenario followed by sub-questions, for a total of ${t} points.`,
    blocksHow: "For a single-choice sub-question, tick the one correct box. For a code excerpt, write the exact output. A short answer takes one to three sentences.",
    output: "Output:", modelAnswer: "Model answer:", grading: "Grading:", solution: "Solution", solutions: "Solutions",
    misconception: "misconception", answers: "Answers and justifications:",
  },
  fr: {
    lecturer: "Responsable :", nameField: "Nom :", idField: String.raw`N\textsuperscript{o} d'étudiant :`, durationLabel: "Durée :", totalLabel: "Total :", finalExam: "Examen final", midtermExam: "Examen partiel",
    point: "point", points: "points", question: "Question", openQuestion: "Question ouverte", part: "Partie",
    qcmPart: "Questions à choix multiple", openPart: "Questions ouvertes", single: "choix unique", multiple: "choix multiple",
    qcmConvention: "Une question à choix unique a exactement une bonne réponse ; une question à choix multiple en a une ou plusieurs.",
    tick: "Cochez la ou les cases que vous pensez correctes.",
    qcmCount: (n) => `${n} ${plural(n, "question", "questions")} à choix multiple`,
    openCount: (n) => `${n} ${plural(n, "question ouverte", "questions ouvertes")}`,
    and: "et", contains: (p, t) => `L'examen comporte ${p}, pour un total de ${t} points.`,
    blocks: (n, t) => `L'examen comporte ${n} ${plural(n, "question", "questions")}, chacune faite d'une mise en situation suivie de sous-questions, pour un total de ${t} points.`,
    blocksHow: "Pour une sous-question à choix unique, cochez la seule bonne case. Pour un extrait de code, écrivez la sortie exacte. Une réponse courte tient en une à trois phrases.",
    output: "Sortie :", modelAnswer: "Réponse type :", grading: "Barème :", solution: "Solution", solutions: "Corrigé",
    misconception: "idée fausse", answers: "Réponses et justifications :",
  },
  de: {
    lecturer: "Lehrperson:", nameField: "Name:", idField: "Matrikelnr.:", durationLabel: "Dauer:", totalLabel: "Gesamt:", finalExam: "Abschlussprüfung", midtermExam: "Zwischenklausur",
    point: "Punkt", points: "Punkte", question: "Aufgabe", openQuestion: "Offene Frage", part: "Teil",
    qcmPart: "Multiple-Choice-Fragen", openPart: "Offene Fragen", single: "Einfachauswahl", multiple: "Mehrfachauswahl",
    qcmConvention: "Eine Einfachauswahlfrage hat genau eine richtige Antwort, eine Mehrfachauswahlfrage eine oder mehrere.",
    tick: "Kreuzen Sie das Kästchen oder die Kästchen an, die Sie für richtig halten.",
    qcmCount: (n) => `${n} Multiple-Choice-${plural(n, "Frage", "Fragen")}`,
    openCount: (n) => `${n} ${plural(n, "offene Frage", "offene Fragen")}`,
    and: "und", contains: (p, t) => `Die Prüfung umfasst ${p}, insgesamt ${t} Punkte.`,
    blocks: (n, t) => `Die Prüfung umfasst ${n} ${plural(n, "Aufgabe", "Aufgaben")}, jeweils ein Szenario mit Teilfragen, insgesamt ${t} Punkte.`,
    blocksHow: "Bei einer Einfachauswahl kreuzen Sie das eine richtige Kästchen an. Bei einem Codeauszug schreiben Sie die genaue Ausgabe. Eine Kurzantwort umfasst ein bis drei Sätze.",
    output: "Ausgabe:", modelAnswer: "Musterlösung:", grading: "Bewertung:", solution: "Lösung", solutions: "Lösungen",
    misconception: "Fehlvorstellung", answers: "Antworten und Begründungen:",
  },
  it: {
    lecturer: "Docente:", nameField: "Nome:", idField: "Matricola:", durationLabel: "Durata:", totalLabel: "Totale:", finalExam: "Esame finale", midtermExam: "Esame intermedio",
    point: "punto", points: "punti", question: "Domanda", openQuestion: "Domanda aperta", part: "Parte",
    qcmPart: "Domande a scelta multipla", openPart: "Domande aperte", single: "scelta singola", multiple: "scelta multipla",
    qcmConvention: "Una domanda a scelta singola ha esattamente una risposta corretta; una domanda a scelta multipla ne ha una o più.",
    tick: "Barrate la o le caselle che ritenete corrette.",
    qcmCount: (n) => `${n} ${plural(n, "domanda", "domande")} a scelta multipla`,
    openCount: (n) => `${n} ${plural(n, "domanda aperta", "domande aperte")}`,
    and: "e", contains: (p, t) => `L'esame comprende ${p}, per un totale di ${t} punti.`,
    blocks: (n, t) => `L'esame comprende ${n} ${plural(n, "domanda", "domande")}, ciascuna con uno scenario seguito da sottodomande, per un totale di ${t} punti.`,
    blocksHow: "Per una sottodomanda a scelta singola, barrate l'unica casella corretta. Per un estratto di codice, scrivete l'output esatto. Una risposta breve occupa da una a tre frasi.",
    output: "Output:", modelAnswer: "Risposta modello:", grading: "Punteggio:", solution: "Soluzione", solutions: "Soluzioni",
    misconception: "idea sbagliata", answers: "Risposte e giustificazioni:",
  },
  es: {
    lecturer: "Docente:", nameField: "Nombre:", idField: String.raw`N.\textsuperscript{o} de estudiante:`, durationLabel: "Duración:", totalLabel: "Total:", finalExam: "Examen final", midtermExam: "Examen parcial",
    point: "punto", points: "puntos", question: "Pregunta", openQuestion: "Pregunta abierta", part: "Parte",
    qcmPart: "Preguntas de opción múltiple", openPart: "Preguntas abiertas", single: "opción única", multiple: "opción múltiple",
    qcmConvention: "Una pregunta de opción única tiene exactamente una respuesta correcta; una de opción múltiple, una o varias.",
    tick: "Marque la casilla o las casillas que considere correctas.",
    qcmCount: (n) => `${n} ${plural(n, "pregunta", "preguntas")} de opción múltiple`,
    openCount: (n) => `${n} ${plural(n, "pregunta abierta", "preguntas abiertas")}`,
    and: "y", contains: (p, t) => `El examen consta de ${p}, con un total de ${t} puntos.`,
    blocks: (n, t) => `El examen consta de ${n} ${plural(n, "pregunta", "preguntas")}, cada una con un escenario seguido de subpreguntas, con un total de ${t} puntos.`,
    blocksHow: "En una subpregunta de opción única, marque la única casilla correcta. En un fragmento de código, escriba la salida exacta. Una respuesta corta ocupa de una a tres frases.",
    output: "Salida:", modelAnswer: "Respuesta modelo:", grading: "Puntuación:", solution: "Solución", solutions: "Soluciones",
    misconception: "idea errónea", answers: "Respuestas y justificaciones:",
  },
  pt: {
    lecturer: "Docente:", nameField: "Nome:", idField: String.raw`N.\textsuperscript{o} de estudante:`, durationLabel: "Duração:", totalLabel: "Total:", finalExam: "Exame final", midtermExam: "Exame intercalar",
    point: "ponto", points: "pontos", question: "Questão", openQuestion: "Questão aberta", part: "Parte",
    qcmPart: "Questões de escolha múltipla", openPart: "Questões abertas", single: "escolha única", multiple: "escolha múltipla",
    qcmConvention: "Uma questão de escolha única tem exatamente uma resposta correta; uma de escolha múltipla, uma ou mais.",
    tick: "Assinale a opção ou as opções que considera corretas.",
    qcmCount: (n) => `${n} ${plural(n, "questão", "questões")} de escolha múltipla`,
    openCount: (n) => `${n} ${plural(n, "questão aberta", "questões abertas")}`,
    and: "e", contains: (p, t) => `O exame tem ${p}, num total de ${t} pontos.`,
    blocks: (n, t) => `O exame tem ${n} ${plural(n, "questão", "questões")}, cada uma com um cenário seguido de subquestões, num total de ${t} pontos.`,
    blocksHow: "Numa subquestão de escolha única, assinale a única opção correta. Num excerto de código, escreva a saída exata. Uma resposta curta ocupa de uma a três frases.",
    output: "Saída:", modelAnswer: "Resposta modelo:", grading: "Cotação:", solution: "Solução", solutions: "Soluções",
    misconception: "conceção errada", answers: "Respostas e justificações:",
  },
  nl: {
    lecturer: "Docent:", nameField: "Naam:", idField: "Studentnr.:", durationLabel: "Duur:", totalLabel: "Totaal:", finalExam: "Eindexamen", midtermExam: "Tussentoets",
    point: "punt", points: "punten", question: "Vraag", openQuestion: "Open vraag", part: "Deel",
    qcmPart: "Meerkeuzevragen", openPart: "Open vragen", single: "één antwoord", multiple: "meerdere antwoorden",
    qcmConvention: "Een vraag met één antwoord heeft precies één juist antwoord; een vraag met meerdere antwoorden heeft er één of meer.",
    tick: "Kruis het vakje of de vakjes aan die u juist acht.",
    qcmCount: (n) => `${n} ${plural(n, "meerkeuzevraag", "meerkeuzevragen")}`,
    openCount: (n) => `${n} ${plural(n, "open vraag", "open vragen")}`,
    and: "en", contains: (p, t) => `Het examen bestaat uit ${p}, in totaal ${t} punten.`,
    blocks: (n, t) => `Het examen bestaat uit ${n} ${plural(n, "vraag", "vragen")}, elk een scenario gevolgd door deelvragen, in totaal ${t} punten.`,
    blocksHow: "Kruis bij een deelvraag met één antwoord het ene juiste vakje aan. Schrijf bij een codefragment de exacte uitvoer. Een kort antwoord telt één tot drie zinnen.",
    output: "Uitvoer:", modelAnswer: "Modelantwoord:", grading: "Beoordeling:", solution: "Oplossing", solutions: "Oplossingen",
    misconception: "misvatting", answers: "Antwoorden en motivering:",
  },
  ko: {
    lecturer: "담당 교수:", nameField: "이름:", idField: "학번:", durationLabel: "시간:", totalLabel: "총점:", finalExam: "기말고사", midtermExam: "중간고사",
    point: "점", points: "점", question: "문제", openQuestion: "주관식 문제", part: "부분",
    qcmPart: "객관식 문제", openPart: "주관식 문제", single: "단일 선택", multiple: "복수 선택",
    qcmConvention: "단일 선택 문제는 정답이 정확히 하나이며, 복수 선택 문제는 하나 이상의 정답이 있습니다.",
    tick: "맞다고 생각하는 칸에 표시하십시오.",
    qcmCount: (n) => `객관식 문제 ${n}개`,
    openCount: (n) => `주관식 문제 ${n}개`,
    and: "및", contains: (p, t) => `이 시험은 ${p}로 구성되며, 총점은 ${t}점입니다.`,
    blocks: (n, t) => `이 시험은 ${n}개의 문제로 구성되며, 각 문제는 상황 설명과 하위 문제로 이루어져 있고, 총점은 ${t}점입니다.`,
    blocksHow: "단일 선택 하위 문제는 정답 칸 하나에 표시하십시오. 코드 발췌의 경우 정확한 출력을 작성하십시오. 짧은 답변은 한 문장에서 세 문장 정도로 작성하십시오.",
    output: "출력:", modelAnswer: "모범 답안:", grading: "채점 기준:", solution: "해설", solutions: "해설",
    misconception: "오개념", answers: "답안 및 근거:",
  },
  he: {
    lecturer: "מרצה:", nameField: "שם:", idField: "מספר תעודת זהות:", durationLabel: "משך:", totalLabel: "סך הכול:", finalExam: "בחינה סופית", midtermExam: "בחינת ביניים",
    point: "נקודה", points: "נקודות", question: "שאלה", openQuestion: "שאלה פתוחה", part: "חלק",
    qcmPart: "שאלות רב-בחירה", openPart: "שאלות פתוחות", single: "בחירה יחידה", multiple: "בחירה מרובה",
    qcmConvention: "לשאלת בחירה יחידה יש תשובה נכונה אחת בלבד; לשאלת בחירה מרובה יש תשובה נכונה אחת או יותר.",
    tick: "סמנו את התיבה או התיבות שלדעתכם נכונות.",
    qcmCount: (n) => `${n} שאלות רב-בחירה`,
    openCount: (n) => `${n} שאלות פתוחות`,
    and: "ו-", contains: (p, t) => `הבחינה כוללת ${p}, בסך הכול ${t} נקודות.`,
    blocks: (n, t) => `הבחינה כוללת ${n} שאלות, כל אחת מורכבת מתיאור מצב ושאלות משנה, בסך הכול ${t} נקודות.`,
    blocksHow: "בשאלת משנה בבחירה יחידה, סמנו את התיבה הנכונה היחידה. בקטע קוד, כתבו את הפלט המדויק. תשובה קצרה נכתבת במשפט עד שלושה משפטים.",
    output: "פלט:", modelAnswer: "תשובת מודל:", grading: "ניקוד:", solution: "פתרון", solutions: "פתרונות",
    misconception: "תפיסה שגויה", answers: "תשובות והסברים:",
  },
  ar: {
    lecturer: "المحاضر:", nameField: "الاسم:", idField: "رقم الطالب:", durationLabel: "المدة:", totalLabel: "المجموع:", finalExam: "الامتحان النهائي", midtermExam: "الامتحان النصفي",
    point: "نقطة", points: "نقاط", question: "سؤال", openQuestion: "سؤال مفتوح", part: "جزء",
    qcmPart: "أسئلة الاختيار من متعدد", openPart: "أسئلة مفتوحة", single: "اختيار واحد", multiple: "اختيار متعدد",
    qcmConvention: "سؤال الاختيار الواحد له إجابة صحيحة واحدة فقط؛ سؤال الاختيار المتعدد له إجابة واحدة أو أكثر.",
    tick: "ضع علامة على الخانة أو الخانات التي تعتقد أنها صحيحة.",
    qcmCount: (n) => `${n} سؤال اختيار من متعدد`,
    openCount: (n) => `${n} سؤال مفتوح`,
    and: "و", contains: (p, t) => `يتضمن الامتحان ${p}، بمجموع ${t} نقطة.`,
    blocks: (n, t) => `يتضمن الامتحان ${n} سؤالًا، كل منها يتكون من وصف لحالة متبوعة بأسئلة فرعية، بمجموع ${t} نقطة.`,
    blocksHow: "بالنسبة لسؤال فرعي باختيار واحد، ضع علامة على الخانة الصحيحة الوحيدة. بالنسبة لمقتطف من الكود، اكتب المخرجات الدقيقة. الإجابة القصيرة تكون من جملة إلى ثلاث جمل.",
    output: "المخرجات:", modelAnswer: "إجابة نموذجية:", grading: "التقييم:", solution: "الحل", solutions: "الحلول",
    misconception: "فكرة خاطئة", answers: "الإجابات والتبريرات:",
  },
};

export type CoverWords = BaseWords & NeutralWords;

/** « 1 point », « 3 points » dans la langue de l'examen. */
export function pointsText(n: number, w: CoverWords): string {
  return `${n} ${plural(n, w.point, w.points)}`;
}

/** Le type d'examen par défaut (création d'un cours, ou cours historique sans type) : pas un libellé saisi. */
const isDefaultKind = (kind: string) => kind === "Examen final" || kind === "Final Exam";

/** Les annales du cours ne sont que des partiels (format résolu) : l'examen blanc en est un. */
const isMidterm = (c: CourseConfig) => formatContextFor(c.id).genre === "midterm";

/**
 * Type d'examen affiché : le défaut de la création d'un cours (« Examen final ») suit la langue de
 * l'examen, et le genre des annales (un partiel quand elles ne sont que des partiels).
 */
export function examKindText(c: CourseConfig, w: CoverWords): string {
  if (!isDefaultKind(c.examKind)) return c.examKind;
  return isMidterm(c) ? w.midtermExam : w.finalExam;
}

/**
 * GABARIT DE L'EPFL HORS CS-202, dans la langue de l'examen : la mise en page de l'EPFL (logo,
 * SCIPER, QR, rouge des corrigés) reste, ses libellés fixes suivent la langue. null = examen en
 * anglais (le texte historique, en anglais, reste tel quel) ou cs-202 (empreinte canonique).
 */
export function epflWords(): CoverWords | null {
  if (currentCourse() === DEFAULT_COURSE) return null;
  const language = formatContextFor(currentCourse()).language;
  return language === "en" ? null : coverWords(language);
}

/** Type d'examen du pied et de la garde de l'EPFL : le défaut garde « Final Exam » en anglais, sinon il est traduit. */
export function epflExamKind(c: CourseConfig): string {
  if (!isDefaultKind(c.examKind)) return c.examKind;
  const w = epflWords();
  if (isMidterm(c)) return w?.midtermExam ?? "Midterm Exam";
  return w?.finalExam ?? "Final Exam";
}

/** Type d'examen d'un titre (examen généré, résumé du plan) : celui que porte son gabarit ; CS-202 garde le sien. */
export function examKindLabel(c: CourseConfig): string {
  if (c.id === DEFAULT_COURSE) return c.examKind;
  return examTemplate(c) === "epfl" ? epflExamKind(c) : examKindText(c, coverWords(formatContextFor(c.id).language));
}

/**
 * En-tête et marge de l'EPFL hors cs-202, à placer après le préambule commun (écrit pour cs-202) :
 * « Anonymisation: » sans l'espace française d'un examen anglais, et hors anglais, titre de
 * question et marge « Do NOT write anything here! » traduits.
 */
export function epflLocalChrome(questionHead: boolean): string[] {
  const w = epflWords();
  const words = w ?? coverWords("en");
  return [
    String.raw`\fancyhead[C]{\small ${words.anonymisation} \#0000\\[-2pt]p. \thepage}`,
    ...(w && questionHead ? [String.raw`\fancyhead[L]{\small ${w.question} \theexq}`] : []),
    ...(w ? [String.raw`\examchromefalse\AddToShipoutPictureFG{\put(\LenToUnit{\dimexpr\paperwidth-0.42cm},\LenToUnit{0.32\paperheight}){\rotatebox{90}{\scriptsize\textsf{${w.leaveEmpty}}}}}`] : []),
  ];
}

/** Titre du cours sur une ligne : « CODE -- Nom » (le code est facultatif). */
export function courseTitle(c: CourseConfig): string {
  return [texEscape(c.examCode).replace(/-/g, "--"), texEscape(c.examName)].filter(Boolean).join(" -- ");
}

/** Compléments du préambule hors CS-202 (latex/generic.tex : indicatrice…). */
export function genericPreamble(): string {
  const p = path.join(process.cwd(), "latex", "generic.tex");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/** Libellés d'un QCM dans la langue de l'examen (gabarit neutre, ou EPFL hors anglais). `partSep` : entre « Part 1 » et son titre. */
export function localQcmLabels(w: CoverWords, color: string, pageBeforeFirstOpen: boolean, partSep = String.raw` \quad-- `): QcmLabels {
  return {
    questionWord: w.question,
    openWord: w.openQuestion,
    question: (n) => `${w.question} ${n}.`,
    tag: (type, points) => `${type === "mcq" ? w.multiple : w.single}, ${pointsText(points, w)}`,
    kind: (type) => (type === "mcq" ? w.multiple : w.single),
    misconception: `${w.misconception} -- `,
    solution: `${w.solution}.`,
    openQuestion: (n) => `${w.openQuestion} ${n}`,
    points: (n) => pointsText(n, w),
    openSolution: `${w.solution}.`,
    color,
    qcmPart: (withOpen) => (withOpen ? `${w.part} 1${partSep}${w.qcmPart}` : w.qcmPart),
    openPart: (withQcm) => (withQcm ? `${w.part} 2${partSep}${w.openPart}` : w.openPart),
    pageBeforeFirstOpen,
  };
}

/** Libellés des questions composées dans la langue de l'examen. */
export function localBlockLabels(w: CoverWords, color: string): BlockLabels {
  return {
    question: w.question, pts: (n) => pointsText(n, w), output: w.output, modelAnswer: w.modelAnswer,
    grading: w.grading, solution: `${w.solution}.`, color,
  };
}

/** Titres du corrigé d'un examen écrit dans la langue de l'examen ; `num` : le numéro de la question (« Question 3 »). */
export function localWrittenLabels(w: CoverWords, num: (n: number) => string = (n) => `${w.question} ${n}`): WrittenLabels {
  return {
    solutionsTitle: w.solutions,
    solutionHead: (n, concept, points) => String.raw`\par\medskip\needspace{4\baselineskip}{\large\textbf{${num(n)} \quad-- ${concept} \hfill [${pointsText(points, w)}]}}\par\smallskip`,
  };
}
