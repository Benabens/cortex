import { q } from "@/db/q";
import { localOriginals } from "@/lib/originals/registry";
import { indexItemForSearch } from "@/lib/search";

/**
 * SOURCES « INDEX SEUL » : l'original est resté sur l'ordinateur d'un compte gratuit, Cortex n'en
 * garde que l'index. L'ingestion reconstruit le corpus depuis le disque (scripts/ingest.ts) : sans
 * ce module, chaque ré-ingestion ou re-préparation effaçait ces sources pour de bon. Elles sont lues
 * dans l'index AVANT l'effacement, puis réécrites telles quelles dans la même transaction (mêmes
 * textes, ancres et types ; seuls les identifiants changent, comme pour toutes les sources).
 */

type ItemRow = { type: string; lecture_id: string | null; title: string | null; text: string; html: string | null; images: string | null; tags: string | null; anchor: string | null };
export type KeptSource = { type: string; title: string; path: string; year: number | null; recency_weight: number; items: ItemRow[] };

/** Chemins du cours dont l'original n'est plus sur le serveur : il est resté sur l'ordinateur. */
export async function pathsOnComputer(): Promise<Set<string>> {
  return new Set((await localOriginals("local")).map((o) => o.path));
}

/** Sources inscrites au registre des originaux que cette ingestion n'a pas relues sur le disque. */
export async function readIndexOnlySources(readPaths: Set<string>): Promise<KeptSource[]> {
  const paths = (await localOriginals()).map((o) => o.path).filter((p) => !readPaths.has(p));
  if (!paths.length) return [];
  await q.ensureTable("sources");
  await q.ensureTable("items");
  const kept: KeptSource[] = [];
  for (const p of paths) {
    const sources = await q.all<{ id: number; type: string; title: string; path: string; year: number | null; recency_weight: number }>(
      `SELECT id, type, title, path, year, recency_weight FROM sources WHERE path = ? ORDER BY id`, p,
    );
    for (const s of sources) {
      const items = await q.all<ItemRow>(
        `SELECT type, lecture_id, title, text, html, images, tags, anchor FROM items WHERE source_id = ? ORDER BY id`, s.id,
      );
      kept.push({ type: s.type, title: s.title, path: s.path, year: s.year, recency_weight: Number(s.recency_weight), items });
    }
  }
  return kept;
}

/** Réécrit les sources lues par readIndexOnlySources (à appeler dans la transaction de l'ingestion). */
export async function writeIndexOnlySources(kept: KeptSource[]): Promise<number> {
  let items = 0;
  for (const s of kept) {
    const sid = await q.insert(
      `INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`,
      s.type, s.title, s.path, s.year, s.recency_weight,
    );
    for (const it of s.items) {
      const itemId = await q.insert(
        `INSERT INTO items (source_id, type, lecture_id, title, text, html, images, tags, anchor) VALUES (?,?,?,?,?,?,?,?,?)`,
        sid, it.type, it.lecture_id, it.title, it.text, it.html, it.images, it.tags, it.anchor,
      );
      await indexItemForSearch(itemId, sid, it.title ?? "", it.text, it.lecture_id ?? "");
      items++;
    }
  }
  return items;
}
