import { currentCourse, sqlite } from "@/db/client";
import { sourceHref } from "@/lib/deeplink";
import { search } from "@/lib/search";

// Colonnes ajoutées au fil de l'eau (idempotent, s'applique à la DB du cours courant) :
// - `analyzed` (suivi IA), `source` (manual|conversation|image), `theme` (regroupement).
export function ensureSchema() {
  const cols = (sqlite.prepare(`PRAGMA table_info(weaknesses)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("analyzed")) sqlite.exec(`ALTER TABLE weaknesses ADD COLUMN analyzed INTEGER NOT NULL DEFAULT 0`);
  if (!cols.includes("source")) sqlite.exec(`ALTER TABLE weaknesses ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  if (!cols.includes("theme")) sqlite.exec(`ALTER TABLE weaknesses ADD COLUMN theme TEXT`);
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
function autoLink(text: string, max = 8): number[] {
  const groups = search(text, 40, "or");
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
  SELECT i.id itemId, i.title, i.anchor, i.lecture_id lectureId,
         s.type sourceType, s.title sourceTitle, s.path sourcePath
  FROM items i JOIN sources s ON s.id = i.source_id
  WHERE i.id = ?
`;

function relatedFor(idsJson: string | null, q: string): RelatedItem[] {
  if (!idsJson) return [];
  let ids: number[] = [];
  try {
    ids = JSON.parse(idsJson);
  } catch {
    return [];
  }
  const resolveItems = sqlite.prepare(RESOLVE_ITEM_SQL); // lié à la connexion du cours courant
  const out: RelatedItem[] = [];
  for (const id of ids) {
    const r = resolveItems.get(id) as any;
    if (!r) continue;
    out.push({
      itemId: r.itemId,
      title: r.title,
      sourceType: r.sourceType,
      sourceTitle: r.sourceTitle,
      lectureId: r.lectureId,
      href: itemHref(r.anchor, r.sourcePath, r.itemId, q),
    });
  }
  return out;
}

export function createWeakness(input: {
  topic: string;
  description?: string;
  severity?: number;
  screenshotPath?: string | null;
  source?: string; // 'manual' | 'conversation' | 'image'
  theme?: string | null;
  analyzed?: boolean;
}): number {
  ensureSchema();
  const related = autoLink(`${input.topic} ${input.description ?? ""} ${input.theme ?? ""}`);
  const id = sqlite
    .prepare(
      `INSERT INTO weaknesses (topic, description, screenshot_path, severity, related_item_ids, source, theme, analyzed)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      input.topic,
      input.description ?? null,
      input.screenshotPath ?? null,
      input.severity ?? 2,
      JSON.stringify(related),
      input.source ?? "manual",
      input.theme ?? null,
      input.analyzed ? 1 : 0
    ).lastInsertRowid as number;
  return id;
}

export function listWeaknesses(): Weakness[] {
  ensureSchema();
  const rows = sqlite
    .prepare(`SELECT * FROM weaknesses ORDER BY datetime(logged_at) DESC, id DESC`)
    .all() as any[];
  return rows.map((r) => ({
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
    related: relatedFor(r.related_item_ids, r.topic),
  }));
}

/** Tableau de bord : faiblesses regroupées par thème (le « classement des incompréhensions »). */
export function weaknessesByTheme(): { theme: string; count: number; avgSeverity: number; topics: string[] }[] {
  const list = listWeaknesses();
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

export function getWeakness(id: number): Weakness | null {
  const list = listWeaknesses();
  return list.find((w) => w.id === id) ?? null;
}

export function deleteWeakness(id: number): string | null {
  const row = sqlite.prepare(`SELECT screenshot_path FROM weaknesses WHERE id = ?`).get(id) as
    | { screenshot_path: string | null }
    | undefined;
  sqlite.prepare(`DELETE FROM weaknesses WHERE id = ?`).run(id);
  return row?.screenshot_path ?? null;
}

/** Met à jour l'analyse (topic/description), recalcule les liens, marque analysé. */
export function updateWeaknessAnalysis(id: number, topic: string, description: string) {
  ensureSchema();
  const related = autoLink(`${topic} ${description}`);
  sqlite
    .prepare(`UPDATE weaknesses SET topic = ?, description = ?, related_item_ids = ?, analyzed = 1 WHERE id = ?`)
    .run(topic, description, JSON.stringify(related), id);
}

/** Faiblesses pas encore analysées par l'IA (pour le traitement par Claude Code). */
export function listPending(): { id: number; topic: string; description: string | null; screenshotPath: string | null }[] {
  ensureSchema();
  return sqlite
    .prepare(`SELECT id, topic, description, screenshot_path AS screenshotPath FROM weaknesses WHERE analyzed = 0 ORDER BY id`)
    .all() as any[];
}
