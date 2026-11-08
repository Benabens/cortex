/**
 * CHAPITRES D'UN POLYCOPIÉ D'UN SEUL FICHIER — tout le moteur se structure par support : plan du
 * cours (lib/course-plan, une lecture = un chapitre, dès trois), chapitres de couverture
 * (lib/coverage), part de chaque support dans l'analyse du cours (lib/program). Un polycopié livré
 * en un seul DOCX ou PDF n'en donnait qu'un : banc moteur du 04/11/2026 (synth-docx), notions tirées
 * des premières pages et 12 questions sur 12 dans le chapitre 1. L'ingestion le découpe donc en un
 * support par chapitre — seulement sur des titres numérotés qui se suivent (1, 2, 3…), en
 * majuscule initiale, assez espacés pour qu'une table des matières ou un renvoi ne découpe rien.
 */

const KEYWORDS = "Chapitre|Chapter|CHAPITRE|CHAPTER|Partie|PARTIE|Part|PART|Leçon|Lesson|Lecture|Séance|Semaine|Week|Module|Unité|Unit";
const HEADING = new RegExp(`(?:^|[^\\p{L}])(${KEYWORDS})\\s+(\\d{1,3})(?![\\d\\p{L}])`, "gu");
/** Pas de découpage sous ce volume (≈ 3 pages) ni sous trois chapitres. */
const MIN_CHARS = 10_000;
const MIN_CHAPTERS = 3;
/** Écart minimal entre deux débuts de chapitre : une table des matières tient en quelques lignes. */
const MIN_GAP = 1_000;

export type ChapterPart = { title: string; text: string };

/** Début (index) et titre de chaque chapitre, ou null si le texte n'en a pas assez. */
function headings(text: string): { at: number; title: string }[] | null {
  if (text.length < MIN_CHARS) return null;
  const hits = [...text.matchAll(HEADING)].map((m) => {
    const at = m.index! + m[0].indexOf(m[1]);
    return { at, n: Number(m[2]), lineStart: at === 0 || text[at - 1] === "\n" };
  });
  const found: { at: number; title: string }[] = [];
  let next = 1;
  let after = -Infinity;
  for (;;) {
    const candidates = hits.filter((h) => h.n === next && h.at >= after);
    // Un titre en début de ligne prime sur une mention en cours de texte.
    const pick = candidates.find((h) => h.lineStart) ?? candidates[0];
    if (!pick) break;
    found.push({ at: pick.at, title: titleAt(text, pick.at) });
    after = pick.at + MIN_GAP;
    next++;
  }
  return found.length >= MIN_CHAPTERS ? found : null;
}

/** Le titre : jusqu'à la fin de la ligne, ou à un double espace (texte extrait d'un PDF), 80 caractères au plus. */
function titleAt(text: string, at: number): string {
  const rest = text.slice(at, at + 120);
  const end = [rest.indexOf("\n"), rest.indexOf("  ")].filter((i) => i > 0);
  let title = rest.slice(0, end.length ? Math.min(...end) : 80);
  if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, "");
  return title.trim();
}

/** Un texte (DOCX, Markdown, texte) découpé en chapitres, ou null s'il ne s'y prête pas. */
export function splitChapters(text: string): ChapterPart[] | null {
  const hs = headings(text);
  if (!hs) return null;
  return hs.map((h, k) => ({ title: h.title, text: text.slice(k === 0 ? 0 : h.at, hs[k + 1]?.at ?? text.length).trim() }));
}

/** Les pages d'un PDF réparties par chapitre : chaque page va au chapitre où elle commence. */
export function splitPages(pages: string[]): { title: string; pages: number[] }[] | null {
  const starts: number[] = [];
  let joined = "";
  for (const p of pages) {
    starts.push(joined.length);
    joined += `${p}\n`;
  }
  const hs = headings(joined);
  if (!hs) return null;
  const out = hs.map((h) => ({ title: h.title, pages: [] as number[] }));
  pages.forEach((p, i) => {
    const middle = starts[i] + Math.floor(p.length / 2);
    let k = 0;
    while (k + 1 < hs.length && hs[k + 1].at <= middle) k++;
    out[k].pages.push(i);
  });
  return out.filter((c) => c.pages.length);
}
