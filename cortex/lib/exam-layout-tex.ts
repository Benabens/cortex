import type { BlockLabels, ExamLayout, Numbering, QcmLabels } from "@/lib/exam-layout";

/**
 * TITRES ET OPTIONS selon la mise en page (lib/exam-layout) : ce que les moteurs de rendu
 * écrivent pour chaque question (numéro, points) et chaque option de QCM (marque, lettre,
 * colonnes). Les valeurs du défaut neutre redonnent le texte d'avant le module à l'octet près :
 * l'EPFL et le gabarit neutre ne changent pas (empreintes de tests/exam-layout).
 */
const LETTER = "ABCDEFGH".split("");
const BOX = String.raw`\ding{113}`; // □ (pifont) — comme les annales CS-233
const TICK = String.raw`\ding{51}`; // ✓ dans le corrigé
const BUBBLE = String.raw`$\bigcirc$`;

const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];

export function toRoman(n: number): string {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

/**
 * Numéro d'une question : « Question 3 », « Exercice III », « Q3 », « 3 ». `word` : le mot de la
 * langue de l'examen, pris quand la mise en page n'impose pas le sien (`prefix` null).
 */
export function questionNumber(numbering: Numbering, n: number, word: string): string {
  const num = numbering.style === "roman" ? toRoman(n) : String(n);
  const prefix = numbering.prefix === null ? word : numbering.prefix;
  if (!prefix) return num;
  return prefix.length === 1 ? `${prefix}${num}` : `${prefix} ${num}`;
}

/** Une option de QCM, déjà en LaTeX ; `note` : ce qui s'affiche dessous dans le corrigé (ou ""). */
export type ChoiceTex = { text: string; correct: boolean; note: string };

function choiceLabel(layout: ExamLayout, k: number): string {
  const l = layout.choices.label;
  const letter = l[0] === "(" ? l[1] : l[0];
  const x = letter === "a" ? LETTER[k].toLowerCase() : LETTER[k];
  return l.startsWith("(") ? `(${x})` : `${x}${l.slice(-1)}`;
}

/** Une option : marque (case, bulle ou rien ; ✓ dans le corrigé), lettre, texte. */
function choiceTex(layout: ExamLayout, o: ChoiceTex, k: number): string {
  const mark = o.correct ? TICK : layout.choices.mark === "bubble" ? BUBBLE : layout.choices.mark === "box" ? BOX : "";
  return String.raw`${mark ? `${mark}~` : ""}\textbf{${choiceLabel(layout, k)}}~${o.text}`;
}

/**
 * Les options d'une question. Deux colonnes : deux options par ligne, côte à côte (sans nouveau
 * paquet LaTeX, le cache de tectonic n'a que ceux du préambule) ; le corrigé reste sur une colonne,
 * ses notes sous les options n'y tiendraient pas.
 */
export function choicesTex(layout: ExamLayout, opts: ChoiceTex[]): string {
  const twoCols = layout.choices.columns === 2 && !opts.some((o) => o.note || o.correct);
  if (!twoCols) return opts.map((o, k) => String.raw`\noindent${choiceTex(layout, o, k)}\par${o.note}\smallskip`).join("\n");
  const rows: string[] = [];
  for (let k = 0; k < opts.length; k += 2) {
    const cell = (i: number) => String.raw`\begin{minipage}[t]{0.48\linewidth}\raggedright ${choiceTex(layout, opts[i], i)}\end{minipage}`;
    rows.push(String.raw`\noindent${cell(k)}${k + 1 < opts.length ? String.raw`\hfill${cell(k + 1)}` : ""}\par\smallskip`);
  }
  return rows.join("\n");
}

/**
 * Numéro et séparateur d'un titre : « Question 3 -- Titre », mais « 3. Titre » quand l'annale
 * numérote sans mot (« 3 -- Titre » se lisait comme une soustraction).
 */
export function headNumber(numbering: Numbering, n: number, word: string): { num: string; sep: string } {
  const num = questionNumber(numbering, n, word);
  return numbering.prefix === "" ? { num: `${num}.`, sep: "~" } : { num, sep: String.raw` \quad-- ` };
}

/** Points dans un titre : à droite (`margin`), entre parenthèses dans la ligne (`inline`), ou rien. */
function pointsTex(place: ExamLayout["points"], pts: string): { inline: string; right: string } {
  if (place === "none") return { inline: "", right: "" };
  if (place === "inline") return { inline: ` (${pts})`, right: "" };
  return { inline: "", right: String.raw` \hfill [${pts}]` };
}

/** Titre d'une question de QCM. `standard` : les points dans l'étiquette, entre crochets, après le numéro. */
export function qcmHeadTex(layout: ExamLayout, L: QcmLabels, n: number, type: "scq" | "mcq", points: number, topic: string): string {
  const num = layout.numbering.prefix === null && layout.numbering.style === "arabic" ? L.question(n) : `${questionNumber(layout.numbering, n, L.questionWord)}.`;
  const start = String.raw`\needspace{5\baselineskip}\par\medskip\noindent\textbf{${num}}\quad`;
  if (layout.points === "standard") return String.raw`${start}{\footnotesize[${L.tag(type, points)}]}\quad\textbf{\textit{${topic}}}\par\smallskip`;
  const p = pointsTex(layout.points, L.points(points));
  return String.raw`${start}{\footnotesize[${L.kind(type)}]}\quad\textbf{\textit{${topic}}}${p.inline}${p.right}\par\smallskip`;
}

/** Titre d'une question ouverte (sans le saut de page qui la précède). */
export function openHeadTex(layout: ExamLayout, L: QcmLabels, n: number, concept: string, points: number): string {
  const { num, sep } = layout.numbering.prefix === null && layout.numbering.style === "arabic"
    ? { num: L.openQuestion(n), sep: String.raw` \quad-- ` }
    : headNumber(layout.numbering, n, L.openWord);
  const p = pointsTex(layout.points === "standard" ? "margin" : layout.points, L.points(points));
  // Points dans la ligne : hors du gras, comme dans les annales qui les y mettent.
  return String.raw`\needspace{4\baselineskip}{\large\textbf{${num}${sep}${concept}${p.right}}${p.inline}}\par\vspace{4pt}\hrule\vspace{8pt}`;
}

/** Titre d'une question composée. */
export function blockHeadTex(layout: ExamLayout, L: BlockLabels, n: number, title: string, points: number): string {
  const { num, sep } = headNumber(layout.numbering, n, L.question);
  const place = layout.points === "standard" ? "margin" : layout.points;
  // Points hors du \textbf, à droite : la place historique des questions composées.
  const right = place === "margin" ? String.raw` \hfill [${L.pts(points)}]` : "";
  const inline = place === "inline" ? ` (${L.pts(points)})` : "";
  return String.raw`\par\bigskip\needspace{8\baselineskip}\noindent{\large\textbf{${num}${sep}${title}}${inline}${right}}\par\vspace{3pt}\hrule\vspace{8pt}`;
}
