import type { CourseConfig } from "@/lib/courses";
import { LANGUAGES, type DocumentRule, type Language } from "@/lib/exam-format";
import { texEscape } from "@/lib/tex-escape";

/**
 * GABARITS D'EXAMEN. Un cours de l'EPFL garde le gabarit historique (logo, anonymisation,
 * SCIPER, rouge des corrigés, consignes de l'EPFL), byte-identique (tests/gabarit-epfl-non-regression,
 * empreinte canonique de cs-202). Tout autre cours reçoit le gabarit NEUTRE : garde générique
 * (cours, durée, total des points, champs Nom et Identifiant), en-tête et pied sans marque,
 * corrigés en bleu foncé, le tout dans la langue de l'examen. Avant le 16/11/2026, un cours
 * de Duke recevait un QCM « EPFL » (logo, SCIPER, marge « Do NOT write anything here! »).
 */
export type ExamTemplate = "epfl" | "neutral";

export function examTemplate(c: Pick<CourseConfig, "university">): ExamTemplate {
  return c.university.trim().toUpperCase() === "EPFL" ? "epfl" : "neutral";
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
  nameField: string;
  idField: string;
  durationLabel: string;
  totalLabel: string;
  finalExam: string;
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
    nameField: "Name:", idField: "ID:", durationLabel: "Duration:", totalLabel: "Total:", finalExam: "Final exam",
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
    nameField: "Nom :", idField: "N° d'étudiant :", durationLabel: "Durée :", totalLabel: "Total :", finalExam: "Examen final",
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
    nameField: "Name:", idField: "Matrikelnr.:", durationLabel: "Dauer:", totalLabel: "Gesamt:", finalExam: "Abschlussprüfung",
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
    nameField: "Nome:", idField: "Matricola:", durationLabel: "Durata:", totalLabel: "Totale:", finalExam: "Esame finale",
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
    nameField: "Nombre:", idField: "N.º de estudiante:", durationLabel: "Duración:", totalLabel: "Total:", finalExam: "Examen final",
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
    nameField: "Nome:", idField: "N.º de estudante:", durationLabel: "Duração:", totalLabel: "Total:", finalExam: "Exame final",
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
    nameField: "Naam:", idField: "Studentnr.:", durationLabel: "Duur:", totalLabel: "Totaal:", finalExam: "Eindexamen",
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
};

export type CoverWords = BaseWords & NeutralWords;

/** « 1 point », « 3 points » dans la langue de l'examen. */
export function pointsText(n: number, w: CoverWords): string {
  return `${n} ${plural(n, w.point, w.points)}`;
}

/** Type d'examen affiché : le défaut de la création d'un cours (« Examen final ») suit la langue de l'examen. */
function examKindText(c: CourseConfig, w: CoverWords): string {
  return c.examKind === "Examen final" || c.examKind === "Final Exam" ? w.finalExam : c.examKind;
}

/** Titre du cours sur une ligne : « CODE -- Nom » (le code est facultatif). */
function courseTitle(c: CourseConfig): string {
  return [texEscape(c.examCode).replace(/-/g, "--"), texEscape(c.examName)].filter(Boolean).join(String.raw` \quad-- `);
}

/**
 * En-tête, pied de page et macros du gabarit neutre, à placer APRÈS le préambule commun (qui porte
 * le gabarit de cs-202) : il efface son en-tête et son pied (`\fancyhf{}` en tête du bloc), coupe la marge, rend le logo vide et
 * le rouge des corrigés bleu foncé (une macro du modèle qui les citerait compile encore), et
 * traduit les titres de question.
 */
export function neutralChrome(c: CourseConfig, w: CoverWords): string {
  return [
    String.raw`\pagestyle{fancy}\fancyhf{}`,
    String.raw`\examchromefalse`,
    String.raw`\renewcommand{\epfllogo}[1][30]{}`,
    String.raw`\definecolor{solution}{HTML}{1F4E9A}`,
    String.raw`\colorlet{epflred}{solution}`,
    String.raw`\renewcommand{\examq}[3]{\clearpage\setcounter{exq}{#1}\needspace{3\baselineskip}{\large\textbf{${w.question} #1 \quad-- #2 \hfill [#3 ${w.points}]}}\par\vspace{4pt}\hrule\vspace{10pt}}`,
    String.raw`\renewcommand{\subq}[3]{\par\medskip\needspace{3\baselineskip}{\textbf{#1 \quad-- #2 \hfill [#3 ${w.points}]}}\par\smallskip}`,
    String.raw`\renewcommand{\ansspace}[1]{\par\medskip\noindent\textbf{${w.answers}}\par\vspace*{#1}}`,
    String.raw`\renewcommand{\headrulewidth}{0.4pt}\renewcommand{\footrulewidth}{0pt}`,
    String.raw`\fancyhead[L]{\small ${courseTitle(c)}}`,
    String.raw`\fancyhead[R]{\small\thepage}`,
    String.raw`\fancyfoot[C]{\small ${texEscape(examKindText(c, w))}}`,
    String.raw`\fancyfoot[R]{\small\FOOTDATE}`,
  ].join("\n");
}

/**
 * Garde du gabarit neutre : le cours, son établissement s'il est saisi, la date, des champs Nom et
 * Identifiant à remplir, la durée et le total des points, puis les consignes (`instructions`, déjà
 * en LaTeX et dans la langue de l'examen).
 */
export function neutralCoverTex(o: { course: CourseConfig; w: CoverWords; dateTex: string; durationMin: number; totalPts: number; instructions: string[] }): string {
  const { course: c, w } = o;
  return [
    String.raw`\thispagestyle{empty}`,
    String.raw`\begin{center}`,
    String.raw`{\Large\textbf{${courseTitle(c)}}}\\[6pt]`,
    String.raw`{\large ${texEscape(examKindText(c, w))}}\\[4pt]`,
    ...c.universityLines.map((u) => String.raw`{\small ${texEscape(u)}}\\[2pt]`),
    o.dateTex,
    String.raw`\end{center}`,
    String.raw`\vspace{0.3cm}\noindent\rule{\textwidth}{0.6pt}\par\vspace{10pt}`,
    String.raw`\noindent ${w.nameField}~\makebox[0.5\textwidth]{\hrulefill}\hfill ${w.idField}~\makebox[0.22\textwidth]{\hrulefill}\par\vspace{10pt}`,
    String.raw`\noindent\textbf{${w.durationLabel}} ${durationText(o.durationMin, w)}\hfill\textbf{${w.totalLabel}} ${pointsText(o.totalPts, w)}\par\vspace{4pt}`,
    String.raw`\noindent\rule{\textwidth}{0.6pt}`,
    String.raw`\vspace{0.4cm}\par\noindent{\large\textbf{${w.instructions}}}\par\smallskip`,
    String.raw`\begin{enumerate}\setlength{\itemsep}{3pt}`,
    ...o.instructions.map((i) => String.raw`\item ${i}`),
    String.raw`\end{enumerate}\vspace{0.3cm}`,
  ].join("\n");
}
