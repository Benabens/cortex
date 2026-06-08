import { sqlite } from "@/db/client";

export type SearchHit = {
  itemId: number;
  sourceId: number;
  sourceType: string;
  sourceTitle: string;
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

/** Transforme la saisie libre en requête FTS5 sûre (préfixe sur chaque terme). */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

const stmt = sqlite.prepare(`
  SELECT i.id itemId, s.id sourceId, s.type sourceType, s.title sourceTitle,
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
