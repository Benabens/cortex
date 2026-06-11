import { currentCourse, sqlite } from "@/db/client";
import { boundedEdit, tokenize } from "@/lib/text";

export type SearchHit = {
  itemId: number;
  sourceId: number;
  sourceType: string;
  sourceTitle: string;
  sourcePath: string;
  lectureId: string | null;
  title: string | null;
  anchor: string;
  snippet: string;
};

export type SearchGroup = {
  sourceType: string;
  label: string;
  hits: SearchHit[];
};

const TYPE_LABELS: Record<string, string> = {
  review: "Reviews de cours / labs",
  course_pdf: "Cours (slides PDF)",
  final: "Finals",
  midterm: "Midterms",
  serie: "Séries d'exercices",
  exercise: "Exercices",
  cheatsheet: "Cheat sheets",
};

const TYPE_ORDER = ["review", "final", "midterm", "serie", "exercise", "cheatsheet", "course_pdf"];

// ----- Vocabulaire en cache PAR COURS (pour la correction de fautes) -----
type Vocab = { sorted: string[]; set: Set<string>; df: Map<string, number> };
const _vocabByCourse = new Map<string, Vocab>();
function vocab(): Vocab {
  const course = currentCourse();
  let v = _vocabByCourse.get(course);
  if (!v) {
    let rows: { term: string; df: number }[] = [];
    try {
      rows = sqlite.prepare("SELECT term, df FROM vocab").all() as typeof rows;
    } catch {
      rows = [];
    }
    const sorted = rows.map((r) => r.term).sort();
    const df = new Map(rows.map((r) => [r.term, r.df]));
    v = { sorted, set: new Set(sorted), df };
    _vocabByCourse.set(course, v);
  }
  return v;
}

/** Existe-t-il un terme du vocabulaire égal à `t` ou commençant par `t` ? */
function knownPrefixOrExact(t: string): boolean {
  const v = vocab();
  if (v.set.has(t)) return true;
  const a = v.sorted;
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo < a.length && a[lo].startsWith(t);
}

/** Candidats proches d'un terme mal orthographié, classés (distance, fréquence). */
function fuzzyCandidates(t: string, k = 4): string[] {
  const max = t.length <= 4 ? 1 : 2;
  const v = vocab();
  const out: { term: string; d: number; df: number }[] = [];
  for (const term of v.sorted) {
    if (Math.abs(term.length - t.length) > max) continue;
    if (term[0] !== t[0] && term[1] !== t[1]) continue; // prefiltre rapide
    const d = boundedEdit(t, term, max);
    if (d <= max && term !== t) out.push({ term, d, df: v.df.get(term) ?? 0 });
  }
  out.sort((a, b) => a.d - b.d || b.df - a.df);
  return out.slice(0, k).map((o) => o.term);
}

// Mots vides FR/EN à ignorer pour le matching « lâche » (lien de faiblesse).
const STOP = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "que", "qui", "quoi",
  "je", "tu", "il", "on", "ce", "ça", "se", "sa", "son", "ses", "mon", "ma", "mes",
  "au", "aux", "en", "dans", "sur", "pour", "par", "avec", "sans", "est", "sont", "pas",
  "ne", "plus", "moins", "comme", "quand", "ou", "ai", "the", "and", "for", "with", "you",
  "confonds", "comprends", "compris", "sais", "fait", "faire",
]);

/**
 * Saisie libre -> requête FTS5.
 * mode 'and' (défaut, recherche précise) : tous les termes requis.
 * mode 'or'  (lien de faiblesse)        : OU sur les termes significatifs (mots vides retirés).
 */
function toFtsQuery(raw: string, mode: "and" | "or" = "and"): string | null {
  let terms = tokenize(raw, 2);
  if (mode === "or") terms = terms.filter((t) => t.length >= 3 && !STOP.has(t));
  if (!terms.length) return null;
  const groups = terms.map((t) => {
    const parts = [`"${t}"*`];
    if (!knownPrefixOrExact(t)) {
      for (const c of fuzzyCandidates(t)) parts.push(`"${c}"`);
    }
    return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
  });
  return groups.join(mode === "and" ? " AND " : " OR ");
}

const SEARCH_SQL = `
  SELECT i.id itemId, s.id sourceId, s.type sourceType, s.title sourceTitle, s.path sourcePath,
         i.lecture_id lectureId, i.title title, i.anchor anchor,
         snippet(fts_items, 1, '«', '»', ' … ', 12) snippet
  FROM fts_items f
  JOIN items i   ON i.id = f.item_id
  JOIN sources s ON s.id = i.source_id
  WHERE fts_items MATCH ?
  ORDER BY bm25(fts_items) * (1.0 / (0.5 + s.recency_weight)), rank
  LIMIT ?
`;

export function search(raw: string, limit = 60, mode: "and" | "or" = "and"): SearchGroup[] {
  const q = toFtsQuery(raw, mode);
  if (!q) return [];
  let rows: SearchHit[];
  try {
    // préparé à l'appel → lié à la connexion du cours courant (proxy `sqlite`)
    rows = sqlite.prepare(SEARCH_SQL).all(q, limit) as SearchHit[];
  } catch {
    return [];
  }
  const byType = new Map<string, SearchHit[]>();
  for (const r of rows) {
    if (!byType.has(r.sourceType)) byType.set(r.sourceType, []);
    byType.get(r.sourceType)!.push(r);
  }
  return [...byType.entries()]
    .sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
    .map(([sourceType, hits]) => ({
      sourceType,
      label: TYPE_LABELS[sourceType] ?? sourceType,
      hits,
    }));
}
