import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { sourceHref } from "@/lib/deeplink";
import { search } from "@/lib/search";

// Colonnes ajoutées au fil de l'eau (idempotent, s'applique à la DB du cours courant) :
// - `analyzed` (suivi IA), `source` (manual|conversation|image), `theme` (regroupement).
export async function ensureSchema(): Promise<void> {
  await q.ensureColumns("weaknesses", ["analyzed", "source", "theme"]);
}

export type RelatedItem = {
  itemId: number;
  title: string | null;
  sourceType: string;
  sourceTitle: string;
  lectureId: string | null;
  href: string;
};

export type Weakness = {
  id: number;
  topic: string;
  description: string | null;
  screenshotPath: string | null;
  screenshotUrl: string | null;
  severity: number;
  analyzed: boolean;
  source: string;
  theme: string | null;
  timesSeen: number;
  loggedAt: string | null;
  lastReviewedAt: string | null;
  related: RelatedItem[];
};

/** Lien clic→source UNIFIÉ (course-aware via lib/deeplink) : cs-202 → viewer/sites ; autres → /csrc. */
function itemHref(anchor: string, sourcePath: string, itemId: number, q: string): string {
  return sourceHref(currentCourse(), sourcePath, anchor, { itemId, q });
}

/** Auto-link : retrouve les items du corpus les plus proches du texte de la faiblesse (matching lâche). */
async function autoLink(text: string, max = 8): Promise<number[]> {
  const groups = await search(text, 40, "or");
  const ids: number[] = [];
  // round-robin léger pour diversifier les types de source
  const queues = groups.map((g) => g.hits.slice());
  let added = true;
  while (added && ids.length < max) {
    added = false;
    for (const queue of queues) {
      const h = queue.shift();
      if (h) {
        ids.push(h.itemId);
        added = true;
        if (ids.length >= max) break;
      }
    }
  }
  return ids;
}

const RESOLVE_ITEM_SQL = `
  SELECT i.id AS "itemId", i.title, i.anchor, i.lecture_id AS "lectureId",
         s.type AS "sourceType", s.title AS "sourceTitle", s.path AS "sourcePath"
  FROM items i JOIN sources s ON s.id = i.source_id
  WHERE i.id = ?
`;

async function relatedFor(idsJson: string | null, query: string): Promise<RelatedItem[]> {
  if (!idsJson) return [];
  let ids: number[] = [];
  try {
    ids = JSON.parse(idsJson);
  } catch {
    return [];
  }
  const out: RelatedItem[] = [];
  for (const id of ids) {
    // statement mis en cache par le driver, lié à la connexion du cours courant
    const r = await q.get<any>(RESOLVE_ITEM_SQL, id);
    if (!r) continue;
    out.push({
      itemId: r.itemId,
      title: r.title,
      sourceType: r.sourceType,
      sourceTitle: r.sourceTitle,
      lectureId: r.lectureId,
      href: itemHref(r.anchor, r.sourcePath, r.itemId, query),
    });
  }
  return out;
}

export async function createWeakness(input: {
  topic: string;
  description?: string;
  severity?: number;
  screenshotPath?: string | null;
  source?: string; // 'manual' | 'conversation' | 'image'
  theme?: string | null;
  analyzed?: boolean;
}): Promise<number> {
  await ensureSchema();
  const related = await autoLink(`${input.topic} ${input.description ?? ""} ${input.theme ?? ""}`);
  const id = await q.insert(
    `INSERT INTO weaknesses (topic, description, screenshot_path, severity, related_item_ids, source, theme, analyzed)
       VALUES (?,?,?,?,?,?,?,?)`,
    input.topic,
    input.description ?? null,
    input.screenshotPath ?? null,
    input.severity ?? 2,
    JSON.stringify(related),
    input.source ?? "manual",
    input.theme ?? null,
    input.analyzed ? 1 : 0
  );
  return id;
}

export async function listWeaknesses(): Promise<Weakness[]> {
  await ensureSchema();
  const rows = await q.all<any>(`SELECT * FROM weaknesses ORDER BY logged_at DESC, id DESC`);
  const out: Weakness[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      topic: r.topic,
      description: r.description,
      screenshotPath: r.screenshot_path,
      screenshotUrl: r.screenshot_path ? `/uploads/${r.screenshot_path}` : null,
      severity: r.severity,
      analyzed: !!r.analyzed,
      source: r.source ?? "manual",
      theme: r.theme ?? null,
      timesSeen: r.times_seen,
      loggedAt: r.logged_at,
      lastReviewedAt: r.last_reviewed_at,
      related: await relatedFor(r.related_item_ids, r.topic),
    });
  }
  return out;
}

/** Tableau de bord : faiblesses regroupées par thème (le « classement des incompréhensions »). */
export async function weaknessesByTheme(): Promise<{ theme: string; count: number; avgSeverity: number; topics: string[] }[]> {
  const list = await listWeaknesses();
  const map = new Map<string, Weakness[]>();
  for (const w of list) {
    const t = w.theme || "(non classé)";
    (map.get(t) ?? map.set(t, []).get(t)!).push(w);
  }
  return [...map.entries()]
    .map(([theme, ws]) => ({
      theme,
      count: ws.length,
      avgSeverity: Math.round((ws.reduce((s, w) => s + w.severity, 0) / ws.length) * 10) / 10,
      topics: ws.map((w) => w.topic),
    }))
    .sort((a, b) => b.count - a.count || b.avgSeverity - a.avgSeverity);
}

export async function getWeakness(id: number): Promise<Weakness | null> {
  const list = await listWeaknesses();
  return list.find((w) => w.id === id) ?? null;
}

export async function deleteWeakness(id: number): Promise<string | null> {
  const row = await q.get<{ screenshot_path: string | null }>(
    `SELECT screenshot_path FROM weaknesses WHERE id = ?`,
    id
  );
  await q.run(`DELETE FROM weaknesses WHERE id = ?`, id);
  return row?.screenshot_path ?? null;
}

/** Met à jour l'analyse (topic/description), recalcule les liens, marque analysé. */
export async function updateWeaknessAnalysis(id: number, topic: string, description: string): Promise<void> {
  await ensureSchema();
  const related = await autoLink(`${topic} ${description}`);
  await q.run(
    `UPDATE weaknesses SET topic = ?, description = ?, related_item_ids = ?, analyzed = 1 WHERE id = ?`,
    topic,
    description,
    JSON.stringify(related),
    id
  );
}

/** Faiblesses pas encore analysées par l'IA (pour le traitement par le LLM). */
export async function listPending(): Promise<{ id: number; topic: string; description: string | null; screenshotPath: string | null }[]> {
  await ensureSchema();
  return q.all<{ id: number; topic: string; description: string | null; screenshotPath: string | null }>(
    `SELECT id, topic, description, screenshot_path AS "screenshotPath" FROM weaknesses WHERE analyzed = 0 ORDER BY id`
  );
}
