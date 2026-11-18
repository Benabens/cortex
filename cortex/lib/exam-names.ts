/**
 * NOMS D'ANNALES : un seul classifieur, multilingue, pour l'import de dossier (lib/import-folder),
 * l'ingestion des annales (lib/sources) et l'index des examens (lib/exam-index). Avant : trois
 * motifs FR/EN qui se contredisaient (« partiel » midterm au classement, final à l'ingestion), et
 * « Klausur_WS2023 », « Parcial_2023 », « exam1 » ou « Exams/2022.pdf » n'étaient pas des annales
 * (audit ingestion du 16/11/2026). Module pur, sans dépendance serveur.
 */

/** Minuscules sans accents, « _ » comme séparateur : « Prüfung_WS23 » → « prufung-ws23 ». */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/_/g, "-");

/** Un mot entier, mais collé à un chiffre accepté (« exam1 », « Final2023 »). */
const word = (alternatives: string) => new RegExp(`(?<![a-z])(?:${alternatives})(?![a-z])`);

// « Prelim » : le partiel de Cornell et d'autres universités américaines (audit 3, P1-9 : il était pris pour un final).
// Pas « preliminary » : des notes ou des résultats préliminaires ne sont pas une annale.
const MIDTERM_WORDS = "mid-?terms?|partiels?|parcial(?:es)?|zwischenpr(?:u|ue)fung|quiz+e?s?|prelims?";
const MIDTERM = word(MIDTERM_WORDS);
/** Dossier de partiels : un mot entier (« nonprelims-archive » n'en est pas un). */
const MIDTERM_FOLDER = word("mid-?terms?|partiels?|prelims?");
const FINAL = word("finals?");
/** Une annale sans année reste reconnue sur ces mots (« exam1 ») ; « final » seul exige une année. */
const STRONG = word("exams?|examens?|examinations?|klausur(?:en)?|pr(?:u|ue)fung(?:en)?|esam[ei]|tentamens?|past-?papers?");
const NOT_AN_EXAM = /(?<![a-z])final-?(?:project|report|review|presentation|thesis|essay|version|draft)/;
/** Dossier d'annales : « Exams/2022.pdf ». */
const EXAM_FOLDER = word("exams?|examens?|annales?|past-?papers?|klausuren|pr(?:u|ue)fungen|esami|tentamens|finals|midterms");

/** Année d'une épreuve : 2023, ou une année courte de semestre (« WS23 », « Fall 23 », « HS-24 »). */
export function examYear(name: string): number | null {
  const f = norm(name);
  const full = f.match(/(?<!\d)(20\d{2})(?!\d)/);
  if (full) return +full[1];
  const short = f.match(/(?<![a-z])(?:ws|ss|hs|fs|fall|spring|autumn|winter|summer|sommer)[- ]?(\d{2})(?!\d)/);
  return short ? 2000 + +short[1] : null;
}

/** Type d'une épreuve d'après son nom (et ses dossiers) ; null si ce n'est pas une annale. */
export function examKind(rel: string): "final" | "midterm" | null {
  const f = norm(rel);
  const base = f.split("/").at(-1) ?? f;
  const folders = f.split("/").slice(0, -1);
  if (NOT_AN_EXAM.test(base)) return null;
  const midterm = MIDTERM.test(base) || folders.some((d) => MIDTERM_FOLDER.test(d));
  const named = STRONG.test(base) || MIDTERM.test(base) || (FINAL.test(base) && examYear(base) != null);
  if (named || folders.some((d) => EXAM_FOLDER.test(d))) return midterm ? "midterm" : "final";
  return null;
}

/** Corrigé, en plusieurs langues (Lösung, solución, soluzione, oplossing, mark scheme…). */
const SOLUTION = /solutions?|solucion(?:es)?|soluzion[ei]|musterl(?:o|oe)sung|l(?:o|oe)sung(?:en)?|oplossing(?:en)?|uitwerking(?:en)?|answers?|mark-?scheme|marking|grading|corrig|corrections?|with-?sol|respuestas|risposte|reponses/g;

export function isSolutionName(s: string): boolean {
  return new RegExp(SOLUTION.source).test(norm(s));
}

/**
 * Les énoncés d'une liste d'annales, sans les corrigés — sauf s'il n'y a que des corrigés (ils
 * portent alors les seules questions connues). Sert au décompte des annales et à l'étalon visuel.
 */
export function withoutSolutions<R>(rows: R[], nameOf: (r: R) => string): R[] {
  const statements = rows.filter((r) => !isSolutionName(nameOf(r)));
  return statements.length ? statements : rows;
}

/** Radical d'un nom sans les mots de corrigé : « Final_Exam_Solutions » et « Final_Exam » se rejoignent. */
const stemOf = (p: string) => norm(p.split("/").at(-1) ?? p).replace(/\.[a-z0-9]+$/, "").replace(SOLUTION, "").replace(/[-. ]+/g, "-").replace(/^-|-$/g, "");

/** Numéro d'une épreuve dans l'année : « Midterm 2 », « prelim1 », « Quiz_3 » ; null sans numéro. */
const NUMBERED = new RegExp(`(?<![a-z])(?:${MIDTERM_WORDS}|tests?|exams?|examens?|klausur(?:en)?)[- ]?(\\d{1,2})(?!\\d)`);
function examNumber(year: number | null, ...names: string[]): number | null {
  for (const n of names) {
    const m = norm(n).match(NUMBERED);
    // « Midterm23 » de 2023 : l'année courte collée au mot, pas un numéro.
    if (m && 2000 + +m[1] !== year) return +m[1];
  }
  return null;
}

/** Garde UN énoncé par (type d'épreuve, année, numéro) — évite de compter énoncé + corrigé (doublons faux)
 *  et ne mélange plus finals et midterms d'une même année dans un seul bucket, ni « Midterm 1 » et
 *  « Midterm 2 » (audit 3, P1-9 : le second disparaissait de l'index).
 *  Préfère une source SCANNABLE (PDF rendable en vision) à un extrait HTML : c'est générique
 *  (aucune matière) et ça permet l'index/scan là où un site et un PDF coexistent pour la même épreuve.
 *  Sans année, un corrigé est écarté quand son énoncé (même radical) est là. */
export function pickEnonces<R extends { path: string; title: string; year: number | null }>(rows: R[]): R[] {
  const isSol = (r: R) => isSolutionName(r.path) || isSolutionName(r.title);
  const isPdf = (s: string) => /\.pdf$/i.test(s);
  const kindOf = (r: R) => examKind(`${r.path} ${r.title}`) ?? "final";
  // score : énoncé (pas corrigé) avant tout, puis scannable (PDF) avant HTML.
  const score = (r: R) => (isSol(r) ? 0 : 2) + (isPdf(r.path) ? 1 : 0);
  const byKey = new Map<string, R[]>();
  const noYear: R[] = [];
  const unnumbered: [string, R][] = [];
  for (const r of rows) {
    if (r.year == null) { noYear.push(r); continue; }
    const n = examNumber(r.year, r.title, r.path);
    const k = `${kindOf(r)}|${r.year}|${n ?? ""}`;
    if (n == null) unnumbered.push([k, r]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  // Une épreuve sans numéro (un extrait HTML « Midterm Exam ») rejoint l'unique épreuve numérotée de
  // son type et de son année ; s'il y en a plusieurs, on ne sait pas laquelle elle est : elle reste à part.
  for (const [k, r] of unnumbered) {
    const numbered = [...byKey.keys()].filter((o) => o !== k && o.startsWith(k));
    if (numbered.length !== 1) continue;
    byKey.get(numbered[0])!.push(r);
    const rest = byKey.get(k)!.filter((x) => x !== r);
    if (rest.length) byKey.set(k, rest); else byKey.delete(k);
  }
  const out: R[] = [];
  for (const [, group] of byKey) {
    out.push([...group].sort((a, b) => score(b) - score(a))[0]); // meilleur ; corrigé seul dispo = pris
  }
  const statements = new Set(noYear.filter((r) => !isSol(r)).map((r) => stemOf(r.path)));
  out.push(...noYear.filter((r) => !isSol(r) || !statements.has(stemOf(r.path))));
  return out.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
}
