/**
 * COURS SYNTHÉTIQUES pour le banc d'évaluation du générateur d'examens (lib/bench).
 * Rien ici ne vient d'un vrai cours : le domaine (une « théorie » inventée, ex. « théorie des
 * réseaux de Veltrane »), les noms de notions (combinaison de syllabes à partir de la graine),
 * les auteurs et les seuils numériques sont fabriqués par un PRNG seedé (mulberry32) — jamais
 * Math.random — pour que le modèle évalué ne puisse pas s'appuyer sur des connaissances
 * externes, et pour que deux runs avec la même graine produisent un cours strictement
 * identique (le banc doit pouvoir répéter un cas).
 *
 * Couvre les cas limites du banc : cours minuscule (1 chapitre, quelques notions) jusqu'à un
 * cours de plusieurs centaines de pages (beaucoup de chapitres × notions × exemples), rendu en
 * Markdown, PDF texte (tectonic), PDF scanné SANS couche texte (rastérisé puis réassemblé en
 * images pleine page), DOCX minimal, et cours bilingue (chapitres impairs en français, pairs en
 * anglais, mêmes gabarits dans les deux langues).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const execFileP = promisify(execFile);

// ===================== Types exposés =====================

export type SynthSpec = {
  seed: number;
  chapters: number;
  conceptsPerChapter: number;
  examplesPerConcept?: number;
  language: "fr" | "en" | "bilingual";
  title?: string;
};

export type SynthFact = {
  id: string;
  chapter: number;
  concept: string;
  kind: "definition" | "threshold" | "theorem" | "attribution" | "example" | "pitfall";
  statement: string;
  answer: string;
};

export type SynthCourse = {
  title: string;
  language: SynthSpec["language"];
  chapters: { seq: number; title: string; language: "fr" | "en"; markdown: string }[];
  facts: SynthFact[];
};

// ===================== PRNG déterministe (mulberry32) =====================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Concatène toutes les tournures (paragraphes de couleur, pas des faits) dans un ordre tiré de la graine. */
function joinAll(rng: () => number, arr: readonly string[]): string {
  const start = Math.floor(rng() * arr.length);
  return [...arr.slice(start), ...arr.slice(0, start)].join(" ");
}

// ===================== Vocabulaire inventé =====================

const SYLLABLES = [
  "vel", "tra", "nor", "kyr", "mon", "dral", "phen", "tor", "lin", "zar",
  "quin", "bran", "thes", "ulo", "yen", "corv", "isel", "amar", "oth", "fen",
  "gal", "hune", "ivor", "jask", "klor", "mire", "nyx", "opal", "pyre", "rast",
  "syl", "thal", "ulva", "vex", "wren", "zorn",
];
/** Lettres neutres utilisées comme symbole d'indice d'une notion (pas de glyphe non-ASCII, sûr dans les 4 formats). */
const SYMBOLS = ["k", "s", "t", "r", "m", "q", "d", "v", "w", "z", "c", "j", "n", "p", "u", "e"];
const FIELD_WORDS: { fr: string; en: string }[] = [
  { fr: "réseaux", en: "networks" }, { fr: "strates", en: "strata" }, { fr: "cascades", en: "cascades" },
  { fr: "treillis", en: "lattices" }, { fr: "flux", en: "flows" }, { fr: "champs", en: "fields" },
  { fr: "transitions", en: "transitions" }, { fr: "ensembles", en: "sets" },
];
const MODIFIERS: { fr: string; en: string }[] = [
  { fr: "fondements", en: "foundations" }, { fr: "structures", en: "structures" }, { fr: "limites", en: "limits" },
  { fr: "invariants", en: "invariants" }, { fr: "extensions", en: "extensions" }, { fr: "applications", en: "applications" },
  { fr: "singularités", en: "singularities" }, { fr: "régimes", en: "regimes" },
];

function title1(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function makeWord(rng: () => number, minSyl: number, maxSyl: number): string {
  const len = minSyl + Math.floor(rng() * (maxSyl - minSyl + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  return title1(s);
}

/** Nom de notion unique dans le cours : au-delà de 200 essais, un syllabe de plus pour élargir l'espace. */
function uniqueConceptName(rng: () => number, used: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const extra = attempt > 200 ? 1 : 0;
    const name = makeWord(rng, 2 + extra, 3 + extra);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const name = `Notion${used.size}`;
  used.add(name);
  return name;
}

function formatNum(value: number, decimals: number, lang: "fr" | "en"): string {
  const s = value.toFixed(decimals);
  return lang === "fr" ? s.replace(".", ",") : s;
}

// ===================== Gabarits de phrasé (≥ 3 tournures par type de fait) =====================

function pickDefinition(rng: () => number, lang: "fr" | "en", c: string, domain: string, sym: string): { statement: string; answer: string } {
  const answer = lang === "en"
    ? `object of the theory of ${domain} characterized by the index ${sym}`
    : `objet de la théorie de ${domain} caractérisé par l'indice ${sym}`;
  const variants = lang === "en" ? [
    `**Definition.** A **${c}** is an object of the theory of ${domain} characterized by the index ${sym}, which fully determines whether it belongs to this notion.`,
    `**Definition.** We call **${c}** any object of the theory of ${domain} characterized by the index ${sym}.`,
    `**Definition.** By convention, a **${c}** denotes an object of the theory of ${domain} for which the index ${sym} is defined and takes a value in the real interval between zero and one.`,
  ] : [
    `**Définition.** On appelle **${c}** tout objet de la théorie de ${domain} caractérisé par l'indice ${sym}, qui détermine entièrement l'appartenance à cette notion.`,
    `**Définition.** Une **${c}** est, par définition, un objet de la théorie de ${domain} caractérisé par l'indice ${sym}.`,
    `**Définition.** On dit qu'un objet de la théorie de ${domain} est une **${c}** lorsqu'il est caractérisé par l'indice ${sym}, à valeurs dans l'intervalle réel compris entre zéro et un.`,
  ];
  return { statement: pick(rng, variants), answer };
}

function pickThreshold(rng: () => number, lang: "fr" | "en", c: string, sym: string, thStr: string): string {
  const variants = lang === "en" ? [
    `**Property (threshold).** A **${c}** is said to be stable if and only if ${sym} < ${thStr}; beyond this threshold, stability is never observed.`,
    `**Property (threshold).** Stability of a **${c}** holds precisely when ${sym} < ${thStr}, a strict inequality that cannot be relaxed.`,
    `**Property (threshold).** One shows that a **${c}** is stable exactly when ${sym} < ${thStr}, and unstable otherwise.`,
  ] : [
    `**Propriété (seuil).** Une **${c}** est dite stable si et seulement si ${sym} < ${thStr} ; au-delà de ce seuil, la stabilité n'est jamais observée.`,
    `**Propriété (seuil).** La stabilité d'une **${c}** équivaut exactement à ${sym} < ${thStr}, une inégalité stricte qui ne peut être relâchée.`,
    `**Propriété (seuil).** On montre qu'une **${c}** est stable exactement lorsque ${sym} < ${thStr}, et instable sinon.`,
  ];
  return pick(rng, variants);
}

function pickTheorem(rng: () => number, lang: "fr" | "en", c: string, other: string): string {
  const variants = lang === "en" ? [
    `**Theorem.** Every stable **${c}** is associated, in the sense of this theory, with a unique **${other}**.`,
    `**Theorem.** If a **${c}** is stable, then it determines a corresponding **${other}**.`,
    `**Theorem.** One proves that each stable **${c}** gives rise to exactly one **${other}**.`,
  ] : [
    `**Théorème.** Toute **${c}** stable est associée, au sens de cette théorie, à une unique **${other}**.`,
    `**Théorème.** Si une **${c}** est stable, alors elle détermine une **${other}** correspondante.`,
    `**Théorème.** On démontre que chaque **${c}** stable donne naissance à exactement une **${other}**.`,
  ];
  return pick(rng, variants);
}

function pickAttribution(rng: () => number, lang: "fr" | "en", c: string, author: string, year: number): string {
  const variants = lang === "en" ? [
    `**Attribution.** The notion of **${c}** is attributed to ${author} (${year}), who first isolated it.`,
    `**Attribution.** ${author} (${year}) introduced the notion of **${c}** in its present form.`,
    `**Attribution.** The definition of **${c}** used here is due to ${author} (${year}).`,
  ] : [
    `**Attribution.** La notion de **${c}** est attribuée à ${author} (${year}), qui l'a isolée la première fois.`,
    `**Attribution.** ${author} (${year}) a introduit la notion de **${c}** sous sa forme actuelle.`,
    `**Attribution.** La définition de **${c}** retenue ici est due à ${author} (${year}).`,
  ];
  return pick(rng, variants);
}

function pickPitfall(rng: () => number, lang: "fr" | "en", c: string, sym: string, thStr: string): { statement: string; answer: string } {
  const answer = lang === "en"
    ? `believing ${sym} = ${thStr} is enough (the inequality is strict)`
    : `croire que ${sym} = ${thStr} suffit (l'inégalité est stricte)`;
  const variants = lang === "en" ? [
    `**Common pitfall.** It is often wrongly believed that ${sym} = ${thStr} suffices for a **${c}** to be stable: the inequality is strict, equality is not enough.`,
    `**Common pitfall.** A frequent mistake is to ignore the strict inequality ${sym} < ${thStr} and to accept ${sym} = ${thStr} for a **${c}**.`,
    `**Common pitfall.** It is incorrect to believe that a **${c}** remains stable once ${sym} slightly exceeds ${thStr}.`,
  ] : [
    `**Erreur fréquente.** On croit souvent, à tort, qu'il suffit que ${sym} = ${thStr} pour qu'une **${c}** soit stable : l'inégalité est stricte, l'égalité ne suffit pas.`,
    `**Erreur fréquente.** Une erreur classique consiste à négliger la stricte inégalité ${sym} < ${thStr} et à accepter ${sym} = ${thStr} pour une **${c}**.`,
    `**Erreur fréquente.** Il est faux de croire qu'une **${c}** reste stable lorsque ${sym} dépasse légèrement ${thStr}.`,
  ];
  return { statement: pick(rng, variants), answer };
}

function pickExample(rng: () => number, lang: "fr" | "en", c: string, domain: string, sym: string, p: number, k: number, compStr: string): string {
  const variants = lang === "en" ? [
    `**Example.** For a system of ${domain} with parameter p = ${p}, the index is ${sym} = p / (p + ${k}) = ${compStr}, illustrating the notion of **${c}**.`,
    `**Example.** With p = ${p} and k = ${k}, one computes ${sym} = ${p} / (${p} + ${k}) = ${compStr} for a **${c}**.`,
    `**Example.** Taking p = ${p}, we get ${sym} = ${p}/(${p}+${k}) = ${compStr}, a typical value for a **${c}**.`,
  ] : [
    `**Exemple.** Pour un système de ${domain} de paramètre p = ${p}, l'indice vaut ${sym} = p / (p + ${k}) = ${compStr}, ce qui illustre la notion de **${c}**.`,
    `**Exemple.** Avec p = ${p} et k = ${k}, on calcule ${sym} = ${p} / (${p} + ${k}) = ${compStr} pour une **${c}**.`,
    `**Exemple.** En prenant p = ${p}, on obtient ${sym} = ${p}/(${p}+${k}) = ${compStr}, une valeur typique pour une **${c}**.`,
  ];
  return pick(rng, variants);
}

/** Paragraphe de couleur (pas un fait vérifiable) : relie définition, seuil et théorème. */
function pickIntuition(rng: () => number, lang: "fr" | "en", c: string, domain: string, field: { fr: string; en: string }): string {
  const word = lang === "en" ? field.en : field.fr;
  const variants = lang === "en" ? [
    `Intuitively, a **${c}** can be read as a particular way of organizing the ${word} of ${domain} once the associated index stays in a controlled regime; this informal reading connects the definition above to the threshold property and anticipates the shape of the numerical examples that follow.`,
    `One may think of **${c}**, within the theory of ${word} of ${domain}, as describing a typical behaviour: the definition fixes the frame, the threshold property bounds it, and the theorem relates it to the rest of the course.`,
    `Without going into details, a **${c}** corresponds, in ${domain}, to a configuration found in several examples of this chapter; it serves as a landmark for comparing the other notions introduced here.`,
  ] : [
    `Intuitivement, une **${c}** se comprend comme une manière particulière d'organiser les ${word} de ${domain} lorsque l'indice associé reste dans un régime contrôlé ; cette lecture informelle relie la définition ci-dessus à la propriété de seuil et anticipe la forme des exemples numériques qui suivent.`,
    `On peut lire la notion de **${c}**, au sein de la théorie des ${word} de ${domain}, comme la description d'un comportement typique : la définition fixe le cadre, la propriété de seuil en précise la limite, et le théorème la relie au reste du cours.`,
    `Sans entrer dans les détails, une **${c}** correspond, dans ${domain}, à une configuration que l'on retrouve dans plusieurs exemples de ce chapitre ; elle sert de repère pour comparer les autres notions introduites ici.`,
  ];
  return joinAll(rng, variants);
}

/** Second paragraphe de couleur : relie la notion à celle visée par le théorème. */
function pickRemark(rng: () => number, lang: "fr" | "en", c: string, other: string): string {
  const variants = lang === "en" ? [
    `Remark. This property of **${c}** is not isolated: it belongs to a network of comparable results, and the explicit link with **${other}** established by the theorem above lets one transport some properties from one notion to the other without redoing the whole proof.`,
    `Remark. Note that the stability of a **${c}** is always discussed with respect to a fixed threshold, never with respect to an average observed over a sample of particular cases, which sets this approach apart from a purely empirical study.`,
    `Remark. The role of **${other}** in the previous statement is not incidental: several later results in this course implicitly assume that the relation between **${c}** and **${other}** has already been established.`,
  ] : [
    `Remarque. Cette propriété de **${c}** n'est pas isolée : elle s'inscrit dans un réseau de résultats comparables, et le lien explicite avec **${other}** établi par le théorème ci-dessus permet de transporter certaines propriétés d'une notion à l'autre sans refaire entièrement la démonstration.`,
    `Remarque. On retiendra que la stabilité d'une **${c}** se discute toujours par rapport à un seuil fixe, jamais par rapport à une moyenne observée sur un échantillon de cas particuliers, ce qui distingue cette approche d'une étude purement empirique.`,
    `Remarque. Le rôle de **${other}** dans l'énoncé précédent n'est pas accessoire : plusieurs résultats ultérieurs de ce cours supposent implicitement que la relation entre **${c}** et **${other}** a déjà été établie.`,
  ];
  return joinAll(rng, variants);
}

/** Troisième paragraphe de couleur : où la notion ressert dans le cours, pourquoi cette présentation. */
function pickContext(rng: () => number, lang: "fr" | "en", domain: string, field: { fr: string; en: string }): string {
  const word = lang === "en" ? field.en : field.fr;
  const variants = lang === "en" ? [
    `Later in the course, this notion comes back whenever one needs to describe a configuration of ${domain} close to the threshold fixed above, without having to redo the analysis from scratch.`,
    `This precise form is chosen because it makes the numerical check immediate: it suffices to compare the computed index to the threshold value to decide.`,
    `This presentation stays deliberately independent of any particular application, so that the same reasoning applies to any instance of the theory of ${word} of ${domain}.`,
  ] : [
    `Dans la suite du cours, cette notion réapparaît chaque fois que l'on doit décrire une configuration de ${domain} proche du seuil fixé plus haut, sans qu'il soit nécessaire de refaire l'analyse depuis le début.`,
    `On choisit de présenter la notion sous cette forme précise car elle rend la vérification numérique immédiate : il suffit de comparer l'indice calculé à la valeur du seuil pour trancher.`,
    `Cette présentation reste volontairement indépendante du contexte d'application particulier, de sorte que le même raisonnement s'applique à toute instance de la théorie des ${word} de ${domain}.`,
  ];
  return joinAll(rng, variants);
}

function pickIntro(rng: () => number, lang: "fr" | "en", n: number, domain: string, field: { fr: string; en: string }, mod: { fr: string; en: string }): string {
  const variants = lang === "en" ? [
    `This chapter studies ${n} original notions of the theory of ${field.en} of ${domain}, from the point of view of ${mod.en}. For every notion presented here, we write by convention a generic quantity $x$ satisfying $0 \\le x \\le 1$.`,
    `This chapter gathers ${n} notions proper to the theory of ${field.en} of ${domain}, centered on ${mod.en}. The generic quantity $x$ attached to each notion always satisfies $0 \\le x \\le 1$.`,
    `The ${n} notions of this chapter belong to ${mod.en} within the theory of ${field.en} of ${domain}. Recall that the generic quantity $x$ satisfies $0 \\le x \\le 1$.`,
  ] : [
    `Ce chapitre étudie ${n} notions originales de la théorie des ${field.fr} de ${domain}, du point de vue de ${mod.fr}. Pour toute notion présentée ici, on note par convention une quantité générique $x$ qui vérifie $0 \\le x \\le 1$.`,
    `On regroupe dans ce chapitre ${n} notions propres à la théorie des ${field.fr} de ${domain}, centrées sur ${mod.fr}. La quantité générique $x$ associée à chaque notion vérifie toujours $0 \\le x \\le 1$.`,
    `Les ${n} notions de ce chapitre relèvent de ${mod.fr} au sein de la théorie des ${field.fr} de ${domain}. On rappelle que la quantité générique $x$ vérifie $0 \\le x \\le 1$.`,
  ];
  return pick(rng, variants);
}

// ===================== Construction d'une notion =====================

function mkFact(chapter: number, concept: string, kind: SynthFact["kind"], statement: string, answer: string, suffix = ""): SynthFact {
  return { id: `c${chapter}-${concept.toLowerCase()}-${kind}${suffix}`, chapter, concept, kind, statement, answer };
}

function buildConcept(
  rng: () => number,
  seq: number,
  name: string,
  idx: number,
  names: string[],
  domainCore: string,
  fieldPair: { fr: string; en: string },
  lang: "fr" | "en",
  examplesPerConcept: number,
): { markdown: string; facts: SynthFact[] } {
  const sym = SYMBOLS[idx % SYMBOLS.length];
  const threshold = Math.round((0.2 + rng() * 0.6) * 100) / 100;
  const thStr = formatNum(threshold, 2, lang);
  const otherIdx = names.length > 1 ? (idx + 1 + Math.floor(rng() * (names.length - 1))) % names.length : idx;
  const other = names[otherIdx];
  const author = makeWord(rng, 2, 2);
  const year = 1920 + Math.floor(rng() * 105);

  const facts: SynthFact[] = [];
  const lines: string[] = [`## ${name}`, ""];

  const def = pickDefinition(rng, lang, name, domainCore, sym);
  facts.push(mkFact(seq, name, "definition", def.statement, def.answer));
  lines.push(def.statement, "");

  const thr = pickThreshold(rng, lang, name, sym, thStr);
  facts.push(mkFact(seq, name, "threshold", thr, thStr));
  lines.push(thr, "");

  const thm = pickTheorem(rng, lang, name, other);
  facts.push(mkFact(seq, name, "theorem", thm, other));
  lines.push(thm, "");

  const attr = pickAttribution(rng, lang, name, author, year);
  facts.push(mkFact(seq, name, "attribution", attr, `${author} (${year})`));
  lines.push(attr, "");

  const pit = pickPitfall(rng, lang, name, sym, thStr);
  facts.push(mkFact(seq, name, "pitfall", pit.statement, pit.answer));
  lines.push(pit.statement, "");

  for (let n = 0; n < examplesPerConcept; n++) {
    const p = 2 + Math.floor(rng() * 6) + n;
    const k = 3 + Math.floor(rng() * 5);
    const computed = Math.round((p / (p + k)) * 1000) / 1000;
    const compStr = formatNum(computed, 3, lang);
    const ex = pickExample(rng, lang, name, domainCore, sym, p, k, compStr);
    facts.push(mkFact(seq, name, "example", ex, compStr, `-${n}`));
    lines.push(`- ${ex}`);
  }
  lines.push("");
  lines.push(pickIntuition(rng, lang, name, domainCore, fieldPair));
  lines.push("");
  lines.push(pickRemark(rng, lang, name, other));
  lines.push("");
  lines.push(pickContext(rng, lang, domainCore, fieldPair));
  lines.push("");

  return { markdown: lines.join("\n"), facts };
}

// ===================== API publique : génération =====================

export function synthCourse(spec: SynthSpec): SynthCourse {
  const rng = mulberry32(spec.seed >>> 0);
  const examplesPerConcept = spec.examplesPerConcept ?? 1;
  const used = new Set<string>();
  const domainCore = makeWord(rng, 2, 3);
  const fieldPair = pick(rng, FIELD_WORDS);

  const total = spec.chapters * spec.conceptsPerChapter;
  const names: string[] = [];
  for (let i = 0; i < total; i++) names.push(uniqueConceptName(rng, used));

  const title = spec.title ?? (spec.language === "en"
    ? `${domainCore} theory of ${fieldPair.en}`
    : `Théorie des ${fieldPair.fr} de ${domainCore}`);

  const chapters: SynthCourse["chapters"] = [];
  const facts: SynthFact[] = [];
  for (let c = 0; c < spec.chapters; c++) {
    const seq = c + 1;
    const lang: "fr" | "en" = spec.language === "bilingual" ? (seq % 2 === 1 ? "fr" : "en") : spec.language;
    const mod = pick(rng, MODIFIERS);
    const chapterTitle = lang === "en"
      ? `Chapter ${seq}: ${title1(mod.en)} of ${domainCore}`
      : `Chapitre ${seq} : ${title1(mod.fr)} de ${domainCore}`;

    const lines = [`# ${chapterTitle}`, "", pickIntro(rng, lang, spec.conceptsPerChapter, domainCore, fieldPair, mod), ""];
    for (let j = 0; j < spec.conceptsPerChapter; j++) {
      const idx = c * spec.conceptsPerChapter + j;
      const block = buildConcept(rng, seq, names[idx], idx, names, domainCore, fieldPair, lang, examplesPerConcept);
      lines.push(block.markdown);
      facts.push(...block.facts);
    }
    const markdown = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
    chapters.push({ seq, title: chapterTitle, language: lang, markdown });
  }

  return { title, language: spec.language, chapters, facts };
}

/** ≈ 3000 caractères par page (arrondi au supérieur). */
export function estimatePages(course: SynthCourse): number {
  const chars = course.chapters.reduce((sum, ch) => sum + ch.markdown.length, 0);
  return Math.max(1, Math.ceil(chars / 3000));
}

// ===================== Rendu Markdown -> LaTeX (pour « pdf » et « scan ») =====================

function escapeLatexChars(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\\": out += "\\textbackslash{}"; break;
      case "{": out += "\\{"; break;
      case "}": out += "\\}"; break;
      case "$": out += "\\$"; break;
      case "&": out += "\\&"; break;
      case "#": out += "\\#"; break;
      case "_": out += "\\_"; break;
      case "%": out += "\\%"; break;
      case "~": out += "\\textasciitilde{}"; break;
      case "^": out += "\\textasciicircum{}"; break;
      default: out += ch;
    }
  }
  return out;
}

/** Échappe le texte LaTeX en laissant intactes les formules $...$ et en convertissant **gras** en \textbf. */
function convertLineToLatex(line: string): string {
  const tokens = line.split(/(\$[^$]*\$|\*\*[^*]*\*\*)/g);
  return tokens
    .map((tok) => {
      if (tok.startsWith("$") && tok.endsWith("$") && tok.length >= 2) return tok;
      if (tok.startsWith("**") && tok.endsWith("**") && tok.length >= 4) return `\\textbf{${escapeLatexChars(tok.slice(2, -2))}}`;
      return escapeLatexChars(tok);
    })
    .join("");
}

/** Convertit le corps d'un chapitre (sans son « # titre », déjà rendu en \section) en lignes LaTeX. */
function markdownToLatexBody(markdown: string): string[] {
  const out: string[] = [];
  const srcLines = markdown.split("\n");
  let inList = false;
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i];
    if (i === 0 && line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      if (inList) { out.push("\\end{itemize}"); inList = false; }
      out.push(`\\subsection{${convertLineToLatex(line.slice(3))}}`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) { out.push("\\begin{itemize}"); inList = true; }
      out.push(`\\item ${convertLineToLatex(line.slice(2))}`);
      continue;
    }
    if (inList) { out.push("\\end{itemize}"); inList = false; }
    if (line.trim() === "") { out.push(""); continue; }
    out.push(convertLineToLatex(line));
  }
  if (inList) out.push("\\end{itemize}");
  return out;
}

function buildLatex(course: SynthCourse): string {
  const lines: string[] = [
    "\\documentclass[11pt]{article}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{lmodern}",
    "\\usepackage[french,english]{babel}",
    "\\usepackage[margin=2cm]{geometry}",
    `\\title{${convertLineToLatex(course.title)}}`,
    "\\begin{document}",
    "\\maketitle",
  ];
  for (const ch of course.chapters) {
    lines.push(`\\selectlanguage{${ch.language === "en" ? "english" : "french"}}`);
    lines.push(`\\section{${convertLineToLatex(ch.title)}}`);
    lines.push(...markdownToLatexBody(ch.markdown));
  }
  lines.push("\\end{document}");
  return lines.join("\n");
}

/** Un PDF SANS couche texte : une page pleine par image rastérisée. */
function buildScanLatex(pages: string[]): string {
  const body = pages.map((p, i) => `\\includegraphics[width=\\paperwidth,height=\\paperheight]{${p}}${i < pages.length - 1 ? "\n\\newpage" : ""}`).join("\n");
  return [
    "\\documentclass{article}",
    "\\usepackage[margin=0pt]{geometry}",
    "\\usepackage{graphicx}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    body,
    "\\end{document}",
  ].join("\n");
}

async function runTectonic(dir: string, texFile: string): Promise<void> {
  try {
    await execFileP("tectonic", ["--chatter", "minimal", "--outdir", dir, texFile], { cwd: dir, timeout: 180_000 });
  } catch (err) {
    throw new Error(`tectonic a échoué sur ${texFile} : ${String(err)}`);
  }
}

async function runPdftoppm(pdfPath: string, outPrefix: string): Promise<void> {
  await execFileP("pdftoppm", ["-r", "110", "-png", pdfPath, outPrefix]);
}

// ===================== Rendu DOCX minimal (jszip) =====================

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Retire les marqueurs Markdown (#, **, $) : le DOCX ne porte que du texte brut (+ gras sur les titres). */
function stripMarkdownMarkers(line: string): string {
  return line.replace(/^#{1,2}\s*/, "").replace(/\*\*/g, "").replace(/\$/g, "").trim();
}

function paragraphXml(text: string, bold: boolean): string {
  const esc = escapeXml(text);
  const run = bold
    ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc}</w:t></w:r>`
    : `<w:r><w:t xml:space="preserve">${esc}</w:t></w:r>`;
  return `<w:p>${run}</w:p>`;
}

function buildDocumentXml(course: SynthCourse): string {
  const paras: string[] = [];
  for (const ch of course.chapters) {
    for (const raw of ch.markdown.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const isTitle = /^#{1,2}\s/.test(line);
      const text = stripMarkdownMarkers(line);
      if (!text) continue;
      paras.push(paragraphXml(text, isTitle));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr/></w:body></w:document>`;
}

// ===================== Écriture des supports =====================

/** Nom de fichier sûr (sans accent) pour un titre de chapitre. */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function writeMd(course: SynthCourse, dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const ch of course.chapters) {
    const file = path.join(dir, `ch${String(ch.seq).padStart(2, "0")}-${slugify(ch.title)}.md`);
    await fsp.writeFile(file, ch.markdown, "utf8");
    paths.push(file);
  }
  return paths;
}

async function writePdf(course: SynthCourse, dir: string): Promise<string> {
  await fsp.writeFile(path.join(dir, "cours.tex"), buildLatex(course), "utf8");
  await runTectonic(dir, "cours.tex");
  return path.join(dir, "cours.pdf");
}

async function writeDocx(course: SynthCourse, dir: string): Promise<string> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  zip.file("word/document.xml", buildDocumentXml(course));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const out = path.join(dir, "cours.docx");
  await fsp.writeFile(out, buf);
  return out;
}

/** PDF scanné : compile le vrai PDF dans un dossier temporaire, le rastérise, puis réassemble les images sans couche texte. */
async function writeScan(course: SynthCourse, dir: string): Promise<string> {
  const tmp = await fsp.mkdtemp(path.join(dir, ".scan-"));
  try {
    await fsp.writeFile(path.join(tmp, "cours.tex"), buildLatex(course), "utf8");
    await runTectonic(tmp, "cours.tex");
    await runPdftoppm(path.join(tmp, "cours.pdf"), path.join(tmp, "page"));
    const pages = (await fsp.readdir(tmp)).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
    if (pages.length === 0) throw new Error("pdftoppm n'a produit aucune image pour le scan");
    await fsp.writeFile(path.join(tmp, "cours-scan.tex"), buildScanLatex(pages), "utf8");
    await runTectonic(tmp, "cours-scan.tex");
    const finalPath = path.join(dir, "cours-scan.pdf");
    await fsp.rename(path.join(tmp, "cours-scan.pdf"), finalPath);
    return finalPath;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

export async function writeCourseFiles(course: SynthCourse, dir: string, format: "md" | "pdf" | "docx" | "scan"): Promise<string[]> {
  if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
  if (format === "md") return writeMd(course, dir);
  if (format === "pdf") return [await writePdf(course, dir)];
  if (format === "docx") return [await writeDocx(course, dir)];
  return [await writeScan(course, dir)];
}
