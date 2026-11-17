import { spawnSync } from "node:child_process";
import type { Language } from "@/lib/exam-format";
import type { ChoiceLabel, ChoiceMark, ExamLayout, IdField, IdKind, Numbering, PageSlot, Slots } from "@/lib/exam-layout";

/**
 * RELEVÉ DE LA MISE EN PAGE D'UNE ANNALE, déterministe : aucun appel au modèle. Lit les mots du PDF
 * et leurs boîtes (`pdftotext -bbox-layout`) et les polices (`pdffonts`), puis en tire ce qui se
 * voit sans interpréter le contenu : champs de la garde et consignes, en-tête et pied, numérotation
 * des questions, étiquettes et marques des options, colonnes, place du barème, police et taille,
 * espaces de réponse. Fait une fois, à la préparation du cours (lib/format, detectFormat), tant que
 * les PDF de l'annale sont là ; stocké à côté du profil de format.
 *
 * Cœur pur : `surveyPages` (tests/exam-layout-survey, fixtures fictives). Adaptateur : `surveyAnnalePdfs`.
 * Ce qui ne se lit pas reste absent : le défaut neutre s'applique champ par champ.
 */
export type Word = { x0: number; y0: number; x1: number; y1: number; t: string };
export type Line = { x0: number; y0: number; x1: number; y1: number; words: Word[]; text: string };
export type Page = { width: number; height: number; lines: Line[] };

/**
 * Ce que le relevé a vu ; chaque champ absent garde la valeur du défaut neutre. `language` : celle
 * des consignes relevées, qui ne s'impriment que sur un examen de la même langue.
 */
export type SurveyedLayout = Partial<Omit<ExamLayout, "source" | "cover">> & { cover?: Partial<ExamLayout["cover"]>; language?: Language };

// ─────────────────────────── lecture du PDF (adaptateur) ───────────────────────────

const num = (s: string) => Number.parseFloat(s);
/**
 * Entités du XHTML, puis guillemets et apostrophes typographiques en ASCII : la police T1 du
 * préambule n'a pas « ’ » sous tectonic (« Numéro d’étudiant » s'imprimait « Numéro détudiant »).
 */
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, "\"");

/** Pages, lignes et mots du XHTML de `pdftotext -bbox-layout`. */
export function parseBboxXhtml(xhtml: string): Page[] {
  const pages: Page[] = [];
  for (const pm of xhtml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const lines: Line[] = [];
    for (const lm of pm[3].matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
      const words = [...lm[5].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g)]
        .map((w) => ({ x0: num(w[1]), y0: num(w[2]), x1: num(w[3]), y1: num(w[4]), t: decode(w[5]) }));
      if (words.length) lines.push({ x0: num(lm[1]), y0: num(lm[2]), x1: num(lm[3]), y1: num(lm[4]), words, text: words.map((w) => w.t).join(" ") });
    }
    pages.push({ width: num(pm[1]), height: num(pm[2]), lines });
  }
  return pages;
}

/** Polices du PDF (`pdffonts`), sans le préfixe de sous-ensemble. */
export function parsePdffonts(out: string): string[] {
  return out.split("\n").slice(2).map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean).map((n) => n.replace(/^[A-Z]{6}\+/, ""));
}

/** Pages lues par annale, au plus : la garde et quelques pages de questions suffisent. */
const PAGES_READ = 6;

/**
 * Relève la mise en page des annales `pdfs` (chemins absolus) : la première qui se lit. null sans
 * poppler, ou si aucune ne se lit (PDF scanné sans texte).
 */
export function surveyAnnalePdfs(pdfs: string[]): SurveyedLayout | null {
  for (const pdf of pdfs) {
    const text = spawnSync("pdftotext", ["-bbox-layout", "-l", String(PAGES_READ), pdf, "-"], { encoding: "utf8", timeout: 20_000 });
    if (text.status !== 0 || !text.stdout) continue;
    const pages = parseBboxXhtml(text.stdout);
    if (pages.reduce((n, p) => n + p.lines.length, 0) < 8) continue;
    const fonts = spawnSync("pdffonts", ["-l", String(PAGES_READ), pdf], { encoding: "utf8", timeout: 20_000 });
    return surveyPages(pages, fonts.status === 0 ? parsePdffonts(fonts.stdout) : []);
  }
  return null;
}

// ─────────────────────────── relevé (cœur pur) ───────────────────────────

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Bandes d'en-tête et de pied : 9 % du haut et du bas de la page. */
const BAND = 0.09;

const lineHeight = (l: Line) => median(l.words.map((w) => w.y1 - w.y0));
/** Hauteur médiane des mots : celle du corps du texte. */
const bodyHeight = (pages: Page[]) => median(pages.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => w.y1 - w.y0))));

function family(fonts: string[]): ExamLayout["font"]["family"] | null {
  const text = fonts.filter((f) => !/^(CMSY|CMMI|CMEX|LMMath|MSAM|MSBM|Symbol|ZapfDingbats|Dingbats|StandardSymbols)/i.test(f));
  if (!text.length) return null;
  const sans = text.filter((f) => /sans|helvetica|arial|SanL|calibri|verdana|tahoma|segoe|gothic|DejaVuSans(?!Mono)/i.test(f)).length;
  return sans * 2 > text.length ? "sans" : "serif";
}

/** Taille du corps : hauteur médiane des mots, rapportée au facteur de la famille. */
function size(pages: Page[], fam: "sans" | "serif"): ExamLayout["font"]["size"] {
  const pt = bodyHeight(pages) / (fam === "sans" ? 0.94 : 0.89);
  return pt < 10.5 ? 10 : pt < 11.5 ? 11 : 12;
}

/** Contenu d'une case d'en-tête ou de pied. */
function slotOf(text: string): PageSlot | null {
  const t = text.trim();
  if (/^(?:page|p\.|seite|pagina|página)?\s*\d+\s*(?:\/|of|sur|de|von|di)\s*\d+$/i.test(t)) return "pageOfTotal";
  if (/^(?:[-–—]\s*)?(?:page|p\.|seite|pagina|página)?\s*\d+(?:\s*[-–—])?$/i.test(t)) return "page";
  if (/\b(?:19|20)\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/.test(t) && !/[A-Z]{2,}\s?-?\d{2,}/.test(t)) return "date";
  if (/\b(?:final|midterm|mid-term|prelim|quiz|exam|examen|partiel|test|klausur|prüfung|esame|examination|terminal)\b/i.test(t) && !/[A-Z]{2,}\s?-?\d{2,}/.test(t)) return "examKind";
  return "course";
}

/** Lignes des bandes de page, regroupées par position (gauche, centre, droite). */
function bandSlots(pages: Page[], top: boolean): Slots | null {
  // La garde a souvent son propre style : les pages suivantes d'abord, la garde seule sinon.
  const pool = pages.length > 1 ? pages.slice(1) : pages;
  // Un en-tête est en petit : le titre de la garde, au même niveau, n'en est pas un.
  const body = bodyHeight(pages);
  const found: Partial<Record<keyof Slots, PageSlot>> = {};
  let seen = false;
  for (const p of pool) {
    for (const l of p.lines) {
      const inBand = top ? l.y1 <= p.height * BAND : l.y0 >= p.height * (1 - BAND);
      if (!inBand || lineHeight(l) > body * 1.15) continue;
      // Une ligne peut porter deux cases (« COURS ……… 3/5 ») : les groupes de mots séparés d'un grand blanc.
      for (const g of wordGroups(l, p.width)) {
        const mid = (g.x0 + g.x1) / 2;
        const pos: keyof Slots = mid < p.width * 0.38 ? "left" : mid > p.width * 0.62 ? "right" : "center";
        const s = slotOf(g.text);
        if (s && !found[pos]) { found[pos] = s; seen = true; }
      }
    }
  }
  return seen ? { left: found.left ?? "none", center: found.center ?? "none", right: found.right ?? "none" } : null;
}

function wordGroups(l: Line, width: number): { x0: number; x1: number; text: string }[] {
  const groups: { x0: number; x1: number; words: string[] }[] = [];
  for (const w of l.words) {
    const last = groups[groups.length - 1];
    if (last && w.x0 - last.x1 < width * 0.06) { last.x1 = w.x1; last.words.push(w.t); }
    else groups.push({ x0: w.x0, x1: w.x1, words: [w.t] });
  }
  return groups.map((g) => ({ x0: g.x0, x1: g.x1, text: g.words.join(" ") }));
}

const ROMAN = /^(?:X{0,3})(?:IX|IV|V?I{0,3})$/;

/** En-tête de question en début de ligne : « 1. », « Q3 », « Question 2 », « Exercice II », « Problem 4 ». */
function numberingOf(line: Line): Numbering | null {
  const t = line.text;
  const word = t.match(/^(question|exercice|exercise|problem|probl[èe]me|aufgabe|esercizio|ejercicio|task|q)\s*([0-9]+|[IVX]+)\b/i);
  if (word) {
    // Le mot même de l'annale, avec sa capitale (« Exercice », « Problem », « Q »).
    const prefix = word[1][0].toUpperCase() + word[1].slice(1).toLowerCase();
    return { prefix, style: /^\d+$/.test(word[2]) ? "arabic" : "roman" };
  }
  const bare = t.match(/^([0-9]{1,2}|[IVX]{1,4})[.)]\s+\S/);
  if (bare && (/^\d+$/.test(bare[1]) || ROMAN.test(bare[1]))) return { prefix: "", style: /^\d+$/.test(bare[1]) ? "arabic" : "roman" };
  return null;
}

function majority<T>(xs: T[], key: (x: T) => string): T | null {
  const counts = new Map<string, { n: number; x: T }>();
  for (const x of xs) {
    const k = key(x);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { n: 1, x });
  }
  let best: { n: number; x: T } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.x ?? null;
}

const BUBBLE = /^[○◯⃝◦⚪❍]$|^⃝$/;
const BOX = /^[□☐❑❒■▢]$/;

/** Ligne d'option : marque éventuelle, puis « (A) », « A) », « A. », « a) », « (a) » ou « a. ». */
function choiceOf(line: Line): { label: ChoiceLabel; mark: ChoiceMark; letter: string } | null {
  const ws = line.words.map((w) => w.t);
  let mark: ChoiceMark = "none";
  if (ws[0] && BUBBLE.test(ws[0])) { mark = "bubble"; ws.shift(); }
  else if (ws[0] && BOX.test(ws[0])) { mark = "box"; ws.shift(); }
  const m = (ws[0] ?? "").match(/^(\()?([A-Ha-h])([.)])$/);
  if (!m || !ws[1]) return null;
  const upper = m[2] === m[2].toUpperCase();
  const label = (m[1] ? (upper ? "(A)" : "(a)") : m[3] === ")" ? (upper ? "A)" : "a)") : (upper ? "A." : "a.")) as ChoiceLabel;
  return { label, mark, letter: m[2].toUpperCase() };
}

const POINTS_AT = /^[[(]\s*\d+(?:[.,]\d+)?\s*(?:points?|pts?|marks?|punkte?|punti|puntos)\.?\s*[\])]/i;

/** Place du barème : à droite de la ligne (marge), dans le fil du texte, ou absent d'une annale à questions numérotées. */
function pointsOf(pages: Page[], questions: number): ExamLayout["points"] | null {
  const places: ("margin" | "inline")[] = [];
  for (const p of pages) for (const l of p.lines) {
    const i = l.words.findIndex((_, k) => POINTS_AT.test(l.words.slice(k, k + 3).map((w) => w.t).join(" ")));
    if (i < 0) continue;
    const w = l.words[i];
    const gap = i > 0 ? w.x0 - l.words[i - 1].x1 : 0;
    places.push(w.x0 > p.width * 0.6 && (i === 0 || gap > p.width * 0.05) ? "margin" : "inline");
  }
  if (!places.length) return questions >= 5 ? "none" : null;
  return majority(places, (x) => x);
}

const ID_FIELDS: [IdKind, RegExp][] = [
  ["firstName", /^(pr[ée]nom|first name|given name|vorname|nome di battesimo)\b/i],
  ["name", /^(nom|name|last name|surname|family name|nachname|cognome|nombre|full name)\b/i],
  ["studentId", /^(num[ée]ro d['’]?[ée]tudiant|n° d['’]?[ée]tudiant|student (?:id|number)|id number|netid|matricule|matrikel(?:nummer)?|candidate number|sciper|id|identifiant)\b/i],
  ["signature", /^(signature|unterschrift|firma)\b/i],
  ["seat", /^(seat|desk(?: number)?|place|platz|posto|table)\b/i],
];

/** Champs à remplir de la garde, avec le libellé même de l'annale (« NetID: », « Numéro d'étudiant : »). */
function idFieldsOf(cover: Page): IdField[] {
  const out: IdField[] = [];
  for (const l of cover.lines) {
    // Un champ : « Libellé : » suivi d'une ligne (sans texte) ou de pointillés, que l'on coupe.
    for (const seg of wordGroups(l, cover.width).flatMap((g) => g.text.split(/(?:[._…]\s*){2,}/))) {
      const m = seg.trim().match(/^([^:]{2,30}?)\s*:$/);
      if (!m) continue;
      const hit = ID_FIELDS.find(([, re]) => re.test(m[1].trim()));
      if (hit && !out.some((f) => f.kind === hit[0])) out.push({ kind: hit[0], label: `${m[1].trim().replace(/\s+/g, " ")}${/^(nom|pr[ée]nom|num|n°)/i.test(m[1].trim()) ? " :" : ":"}` });
    }
  }
  return out;
}

const INSTRUCTIONS_HEAD = /^(instructions|instructions to candidates|consignes|directives|hinweise|istruzioni|instrucciones|rubric|important)\b/i;
const BULLET = /^(?:[•·▪◦–—*-]|\d{1,2}[.)]|[a-z][.)])\s+/;

/**
 * Ce qu'une consigne ne peut pas dire d'un examen généré : un nombre (de questions, de minutes,
 * de points), une partie ou une section, un cahier ou une feuille à part, un ordre de lecture des
 * questions. La garde de Cortex écrit déjà ce que contient l'examen ; ces consignes décrivent
 * l'annale, pas lui.
 */
const ANNALE_ONLY = new RegExp([
  String.raw`\d`,
  String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|ein|eine|zwei|drei|vier|fünf|uno|due|tre|dos|tres)\b`,
  String.raw`\b(?:sections?|parts?|parties?|partie|teil|booklets?|cahiers?|livrets?|scantron|answer sheet|feuille de réponses?|bubble sheet|copie double|annexe|appendix|choose|choisir|choisissez|wählen|any)\b`,
].join("|"), "i");

/**
 * Consignes de la garde : les items de la liste qui suit « Instructions » / « Consignes », sans ceux
 * qui ne valent que pour l'annale (ANNALE_ONLY).
 */
function instructionsOf(cover: Page): string[] {
  const at = cover.lines.findIndex((l) => INSTRUCTIONS_HEAD.test(l.text.trim()));
  if (at < 0) return [];
  const out: string[] = [];
  const x0 = cover.lines[at].x0;
  let prev = cover.lines[at];
  for (const l of cover.lines.slice(at + 1)) {
    const t = l.text.trim();
    // La liste s'arrête au premier grand blanc (la suite est la première question, ou un trait).
    if (l.y0 - prev.y1 > lineHeight(prev) * 1.6) break;
    prev = l;
    if (BULLET.test(t)) out.push(t.replace(BULLET, ""));
    else if (out.length && l.x0 > x0 + 4) out[out.length - 1] += ` ${t}`;
    else if (out.length) break;
  }
  return out.filter((t) => !ANNALE_ONLY.test(t) && t.length <= 200).slice(0, 6);
}

const STOPWORDS: [Language, RegExp][] = [
  ["fr", /\b(?:le|la|les|des|est|sont|vous|aucun|une|du|sur|pas|être)\b/gi],
  ["en", /\b(?:the|is|are|you|your|of|and|not|be|must|may|each|do|to|this|until|for|on)\b/gi],
  ["de", /\b(?:der|die|das|ist|sind|sie|nicht|und|ein|eine|keine)\b/gi],
  ["it", /\b(?:il|lo|gli|sono|non|una|della|del|essere)\b/gi],
  ["es", /\b(?:el|los|las|son|usted|una|del|ser|está)\b/gi],
];

/** Langue d'un texte, par ses mots les plus courants ; null si rien n'emporte la majorité. */
export function guessLanguage(text: string): Language | null {
  const scores = STOPWORDS.map(([l, re]) => [l, (text.match(re) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  return scores[0][1] >= 2 && scores[0][1] > scores[1][1] ? scores[0][0] : null;
}

/** Lignes à remplir (soulignés, pointillés), grands blancs, ou rien de lisible. */
function answerSpaceOf(pages: Page[]): ExamLayout["answerSpace"] | null {
  let rules = 0, gaps = 0;
  for (const p of pages) {
    const body = p.lines.filter((l) => l.y0 > p.height * BAND && l.y1 < p.height * (1 - BAND));
    for (const l of body) if (/^[_.…\s]{20,}$/.test(l.text)) rules++;
    for (let i = 1; i < body.length; i++) if (body[i].y0 - body[i - 1].y1 > 60) gaps++;
  }
  return rules >= 3 ? "lines" : gaps >= 2 ? "blank" : null;
}

/**
 * Options sur deux colonnes : deux options sur une même ligne. Une page dont les QUESTIONS sont
 * sur deux colonnes garde ses options l'une sous l'autre (première capture du QCM américain).
 */
function columnsOf(pages: Page[]): 1 | 2 {
  for (const p of pages) {
    const paired = p.lines.filter((l) => wordGroups(l, p.width).filter((g) => /^\(?[A-Ha-h][.)]\s/.test(`${g.text} `)).length >= 2);
    if (paired.length >= 2) return 2;
  }
  return 1;
}

/** Tableau des points sur la garde : une ligne « Question 1 2 3 … Total ». */
function pointsTableOf(cover: Page): boolean {
  return cover.lines.some((l) => /\b(total|score|note)\b/i.test(l.text) && (l.text.match(/\b\d{1,2}\b/g) ?? []).length >= 3);
}

/** Relevé d'une annale lue : ce qui se voit, rien d'autre. */
export function surveyPages(pages: Page[], fonts: string[]): SurveyedLayout {
  const out: SurveyedLayout = {};
  if (!pages.length) return out;
  const cover = pages[0];
  const fam = family(fonts);
  if (fam) out.font = { family: fam, size: size(pages, fam) };
  const header = bandSlots(pages, true);
  if (header) out.header = header;
  const footer = bandSlots(pages, false);
  if (footer) out.footer = footer;
  const heads = pages.flatMap((p) => p.lines.filter((l) => l.y0 > p.height * BAND && l.y1 < p.height * (1 - BAND))).map(numberingOf).filter((n): n is Numbering => !!n);
  const numbering = majority(heads, (n) => `${n.prefix}/${n.style}`);
  if (numbering) out.numbering = numbering;
  const choices = pages.flatMap((p) => p.lines.map(choiceOf)).filter((c): c is NonNullable<ReturnType<typeof choiceOf>> => !!c);
  // Il faut au moins une série A, B, C pour parler d'options (une ligne « a) » isolée est une sous-question).
  if (choices.filter((c) => c.letter === "C").length >= 1 && choices.length >= 6) {
    const pick = majority(choices, (c) => `${c.label}/${c.mark}`)!;
    out.choices = { label: pick.label, mark: pick.mark, columns: columnsOf(pages) };
  }
  const points = pointsOf(pages, heads.length);
  if (points) out.points = points;
  const space = answerSpaceOf(pages);
  if (space) out.answerSpace = space;
  const cov: Partial<ExamLayout["cover"]> = {};
  const ids = idFieldsOf(cover);
  if (ids.length) cov.idFields = ids;
  const instructions = instructionsOf(cover);
  if (instructions.length) {
    cov.instructions = instructions;
    const language = guessLanguage(instructions.join(" "));
    if (language) out.language = language;
  }
  if (pointsTableOf(cover)) cov.pointsTable = true;
  if (Object.keys(cov).length) out.cover = cov;
  return out;
}
