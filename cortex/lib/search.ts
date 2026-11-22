import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { q } from "@/db/q";
import { boundedEdit, normalize, tokenize } from "@/lib/text";

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

// ----- Vocabulaire en cache PAR TENANT (pour la correction de fautes) -----
// Le vocabulaire est reconstruit par l'ingestion, dans un AUTRE processus (le worker) : un cache
// gardé à vie servait l'ancien jusqu'au redémarrage du serveur — vide pour un cours cherché avant
// sa première préparation. Une empreinte (nombre de termes, somme des fréquences), relue au plus
// toutes les SEARCH_VOCAB_RECHECK_MS (30 s), dit quand le recharger : un agrégat au lieu des
// milliers de termes, et aucune requête de plus pour les recherches rapprochées d'une génération.
type Vocab = { sorted: string[]; set: Set<string>; df: Map<string, number>; stamp: string; checkedAt: number };
const _vocabByTenant = new Map<string, Vocab>();
const vocabRecheckMs = () => {
  const n = Number(process.env.SEARCH_VOCAB_RECHECK_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
};
async function vocab(): Promise<Vocab> {
  const key = `${currentUser()}\u0000${currentCourse()}`;
  const fresh = _vocabByTenant.get(key);
  if (fresh && Date.now() - fresh.checkedAt < vocabRecheckMs()) return fresh;
  let stamp = "";
  try {
    const s = await q.get<{ n: number | string; s: number | string | null }>("SELECT count(*) n, sum(df) s FROM vocab");
    stamp = `${Number(s?.n ?? 0)}:${Number(s?.s ?? 0)}`;
  } catch {
    stamp = "";
  }
  const cached = _vocabByTenant.get(key);
  if (cached && cached.stamp === stamp) {
    cached.checkedAt = Date.now();
    return cached;
  }
  let rows: { term: string; df: number }[] = [];
  try {
    rows = stamp ? await q.all<{ term: string; df: number }>("SELECT term, df FROM vocab") : [];
  } catch {
    rows = [];
  }
  const sorted = rows.map((r) => r.term).sort();
  const df = new Map(rows.map((r) => [r.term, Number(r.df)]));
  const v = { sorted, set: new Set(sorted), df, stamp, checkedAt: Date.now() };
  _vocabByTenant.set(key, v);
  return v;
}

/**
 * Reconstruit le vocabulaire du tenant courant depuis ses items (termes distincts ≥ 3 lettres,
 * fréquence documentaire). Effacement et réécriture dans UNE transaction : une recherche
 * concurrente voit l'ancien vocabulaire entier ou le nouveau, jamais une table vide.
 */
export async function rebuildVocab(): Promise<number> {
  await q.ensureTable("vocab");
  const df = new Map<string, number>();
  const rows = await q.all<{ text: string }>("SELECT text FROM items");
  for (const { text } of rows) {
    const seen = new Set<string>();
    for (const t of tokenize(text, 3)) {
      if (t.length > 24 || /^\d+$/.test(t)) continue; // pas les très longs / purs nombres
      seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  await q.tx(async () => {
    await q.run("DELETE FROM vocab");
    for (const [term, n] of df)
      await q.run("INSERT INTO vocab (term, df) VALUES (?,?) ON CONFLICT(term) DO UPDATE SET df = excluded.df", term, n);
  });
  // Reconstruit dans CE processus (annale déposée depuis l'app) : vu dès la recherche suivante.
  _vocabByTenant.delete(`${currentUser()}\u0000${currentCourse()}`);
  return df.size;
}

/** Ombre normalisée d'un item : la même formule à l'écriture et à la réparation. */
const searchShadow = (title: string | null | undefined, text: string) => normalize(`${title ?? ""} ${text}`);

export type SearchRepair = { textNorm: number; vocab: number | null };

/**
 * Répare l'index de recherche Postgres du tenant courant, sans rien effacer :
 *  - items sans `text_norm` (tenant migré par scripts/migrate-to-postgres, ou hydraté d'un
 *    tenant de seed qui en manquait) : invisibles à la recherche ET à l'ancrage des
 *    générations (lib/course-grounding) — l'ombre est recalculée depuis le titre et le texte ;
 *  - vocabulaire vide alors que le cours a des items : reconstruit (correction des fautes).
 * Idempotent, par lots ; no-op en SQLite (FTS5 n'a pas d'ombre à réparer).
 */
export async function repairSearchIndex(opts: { batch?: number } = {}): Promise<SearchRepair> {
  if (q.dialect !== "postgres") return { textNorm: 0, vocab: null };
  const batch = Math.max(1, opts.batch ?? 500);
  let textNorm = 0;
  let lastId = 0;
  for (;;) {
    const rows = await q.all<{ id: number; title: string | null; text: string }>(
      `SELECT id, title, text FROM items WHERE text_norm IS NULL AND id > ? ORDER BY id LIMIT ?`, lastId, batch
    );
    if (!rows.length) break;
    await q.tx(async () => {
      for (const r of rows) await q.run(`UPDATE items SET text_norm = ? WHERE id = ?`, searchShadow(r.title, r.text ?? ""), Number(r.id));
    });
    textNorm += rows.length;
    lastId = Number(rows[rows.length - 1].id);
    if (rows.length < batch) break;
  }
  const counts = await q.get<{ i: number | string; v: number | string }>(
    `SELECT (SELECT count(*) FROM items) i, (SELECT count(*) FROM vocab) v`
  );
  const vocabTerms = Number(counts?.i ?? 0) > 0 && Number(counts?.v ?? 0) === 0 ? await rebuildVocab() : null;
  return { textNorm, vocab: vocabTerms };
}

/** Existe-t-il un terme du vocabulaire égal à `t` ou commençant par `t` ? */
function knownPrefixOrExact(t: string, v: Vocab): boolean {
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
function fuzzyCandidates(t: string, v: Vocab, k = 4): string[] {
  const max = t.length <= 4 ? 1 : 2;
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
async function toFtsQuery(raw: string, mode: "and" | "or" = "and"): Promise<string | null> {
  let terms = tokenize(raw, 2);
  if (mode === "or") terms = terms.filter((t) => t.length >= 3 && !STOP.has(t));
  if (!terms.length) return null;
  const v = await vocab();
  const groups = terms.map((t) => {
    const parts = [`"${t}"*`];
    if (!knownPrefixOrExact(t, v)) {
      for (const c of fuzzyCandidates(t, v)) parts.push(`"${c}"`);
    }
    return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
  });
  return groups.join(mode === "and" ? " AND " : " OR ");
}

const SEARCH_SQL = `
  SELECT i.id AS "itemId", s.id AS "sourceId", s.type AS "sourceType", s.title AS "sourceTitle", s.path AS "sourcePath",
         i.lecture_id AS "lectureId", i.title title, i.anchor anchor,
         snippet(fts_items, 1, '«', '»', ' … ', 12) snippet
  FROM fts_items f
  JOIN items i   ON i.id = f.item_id
  JOIN sources s ON s.id = i.source_id
  WHERE fts_items MATCH ?
  ORDER BY bm25(fts_items) * (1.0 / (0.5 + s.recency_weight)), rank
  LIMIT ?
`;

/**
 * Équivalent Postgres : tsquery 'simple' sur items.text_norm (ombre normalisée,
 * accent-insensible comme le tokenizer FTS5) + ts_rank pondéré par la récence.
 * Divergence assumée : le classement ts_rank ≠ bm25 (mêmes features, scores
 * différents) et ts_headline surligne moins bien les termes accentués (le
 * snippet est pris sur le texte ORIGINAL pour rester lisible).
 */
function toPgTsQuery(terms: string[], mode: "and" | "or", v: Vocab): string {
  const groups = terms.map((t) => {
    const parts = [`${t}:*`];
    if (!knownPrefixOrExact(t, v)) {
      for (const c of fuzzyCandidates(t, v)) parts.push(c);
    }
    return parts.length > 1 ? `(${parts.join(" | ")})` : parts[0];
  });
  return groups.join(mode === "and" ? " & " : " | ");
}

const PG_SEARCH_SQL = `
  SELECT i.id "itemId", s.id "sourceId", s.type "sourceType", s.title "sourceTitle", s.path "sourcePath",
         i.lecture_id "lectureId", i.title title, i.anchor anchor,
         ts_headline('simple', i.text, to_tsquery('simple', ?),
                     'StartSel=«, StopSel=», MaxWords=12, MinWords=4, MaxFragments=2, FragmentDelimiter=" … "') snippet
  FROM items i
  JOIN sources s ON s.id = i.source_id
  WHERE to_tsvector('simple', coalesce(i.text_norm, '')) @@ to_tsquery('simple', ?)
  ORDER BY ts_rank(to_tsvector('simple', coalesce(i.text_norm, '')), to_tsquery('simple', ?)) * (0.5 + s.recency_weight) DESC
  LIMIT ?
`;

/**
 * Indexe un item pour la recherche — le pendant ÉCRITURE des deux moteurs :
 * SQLite → ligne fts_items (tokenizer remove_diacritics) ;
 * Postgres → ombre normalisée items.text_norm (index GIN tsvector 'simple').
 */
export async function indexItemForSearch(
  itemId: number | string,
  sourceId: number | string,
  title: string | null,
  text: string,
  lectureId?: string | null
): Promise<void> {
  if (q.dialect === "postgres") {
    await q.run(`UPDATE items SET text_norm = ? WHERE id = ?`, searchShadow(title, text), Number(itemId));
    return;
  }
  await q.run(
    `INSERT INTO fts_items (title, text, lecture_id, item_id, source_id) VALUES (?,?,?,?,?)`,
    title ?? "", text, lectureId ?? "", String(itemId), String(sourceId)
  );
}

/** Désindexe tous les items d'une source (avant leur suppression). */
export async function unindexSource(sourceId: number): Promise<void> {
  if (q.dialect === "postgres") return; // text_norm part avec la ligne items
  await q.run(`DELETE FROM fts_items WHERE source_id = ?`, sourceId);
}

/** Les résultats dans l'ordre de pertinence (bm25 pondéré par la récence), sans regroupement par type. */
export async function rankedHits(raw: string, limit = 60, mode: "and" | "or" = "and"): Promise<SearchHit[]> {
  try {
    if (q.dialect === "postgres") {
      let terms = tokenize(raw, 2);
      if (mode === "or") terms = terms.filter((t) => t.length >= 3 && !STOP.has(t));
      if (!terms.length) return [];
      const tsq = toPgTsQuery(terms, mode, await vocab());
      return await q.all<SearchHit>(PG_SEARCH_SQL, tsq, tsq, tsq, limit);
    } else {
      const ftsQuery = await toFtsQuery(raw, mode);
      if (!ftsQuery) return [];
      // exécuté à l'appel → lié à la connexion du cours courant (façade `q`)
      return await q.all<SearchHit>(SEARCH_SQL, ftsQuery, limit);
    }
  } catch {
    return [];
  }
}

export async function search(raw: string, limit = 60, mode: "and" | "or" = "and"): Promise<SearchGroup[]> {
  const rows = await rankedHits(raw, limit, mode);
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
