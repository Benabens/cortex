import { sqlite } from "@/db/client";
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

// ----- Vocabulaire en cache (pour la correction de fautes) -----
let _vocab: { sorted: string[]; set: Set<string>; df: Map<string, number> } | null = null;
function vocab() {
  if (!_vocab) {
    let rows: { term: string; df: number }[] = [];
    try {
      rows = sqlite.prepare("SELECT term, df FROM vocab").all() as typeof rows;
    } catch {
      rows = [];
    }
    const sorted = rows.map((r) => r.term).sort();
    const df = new Map(rows.map((r) => [r.term, r.df]));
    _vocab = { sorted, set: new Set(sorted), df };
  }
  return _vocab;
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

/** Saisie libre -> requête FTS5, avec expansion floue uniquement sur les termes inconnus. */
function toFtsQuery(raw: string): string | null {
  const terms = tokenize(raw, 2);
  if (!terms.length) return null;
  const groups = terms.map((t) => {
    const parts = [`"${t}"*`];
    if (!knownPrefixOrExact(t)) {
      for (const c of fuzzyCandidates(t)) parts.push(`"${c}"`);
    }
    return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
  });
  return groups.join(" AND ");
}

const stmt = sqlite.prepare(`
  SELECT i.id itemId, s.id sourceId, s.type sourceType, s.title sourceTitle, s.path sourcePath,
         i.lecture_id lectureId, i.title title, i.anchor anchor,
         snippet(fts_items, 1, '«', '»', ' … ', 12) snippet
  FROM fts_items f
  JOIN items i   ON i.id = f.item_id
  JOIN sources s ON s.id = i.source_id
  WHERE fts_items MATCH ?
  ORDER BY bm25(fts_items) * (1.0 / (0.5 + s.recency_weight)), rank
  LIMIT ?
`);

export function search(raw: string, limit = 60): SearchGroup[] {
  const q = toFtsQuery(raw);
  if (!q) return [];
  let rows: SearchHit[];
  try {
    rows = stmt.all(q, limit) as SearchHit[];
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
