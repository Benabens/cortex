import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Recherche plein-texte en mode Postgres (PGlite) : ombre normalisée
 * items.text_norm + tsquery 'simple' — parité fonctionnelle avec FTS5
 * (accent-insensible, préfixes, groupes AND/OR), classement pondéré récence.
 */

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";
import { indexItemForSearch, search, unindexSource } from "../lib/search";

const inCtx = <T,>(fn: () => Promise<T>) => runWithUser("owner", () => runWithCourse("ml", fn));

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
});

async function seed(type: string, title: string, text: string, recency = 1): Promise<{ sid: number; itemId: number }> {
  const sid = await q.insert(`INSERT INTO sources (type, title, path, recency_weight) VALUES (?,?,?,?)`, type, title, `/${title}`, recency);
  const itemId = await q.insert(
    `INSERT INTO items (source_id, type, title, text, anchor) VALUES (?,?,?,?,?)`,
    sid, type, title, text, `#${title}`
  );
  await indexItemForSearch(itemId, sid, title, text);
  return { sid, itemId };
}

test("recherche PG : accent-insensible (« memoire » trouve « mémoire »)", async () => {
  await inCtx(async () => {
    await seed("review", "L14 mémoire virtuelle", "La mémoire virtuelle et la pagination des processus.");
    await seed("review", "L02 réseaux", "Couches réseau et encapsulation des paquets.");
    const groups = await search("memoire", 10);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hits[0].sourceTitle, "L14 mémoire virtuelle");
  });
});

test("recherche PG : préfixe (« virt » trouve « virtuelle »)", async () => {
  await inCtx(async () => {
    const groups = await search("virt", 10);
    assert.ok(groups.some((g) => g.hits.some((h) => h.sourceTitle.includes("mémoire"))));
  });
});

test("recherche PG : mode 'and' exige tous les termes", async () => {
  await inCtx(async () => {
    const hit = await search("mémoire pagination", 10, "and");
    assert.equal(hit.length, 1);
    const miss = await search("mémoire paquets", 10, "and");
    assert.equal(miss.length, 0);
    const both = await search("mémoire paquets", 10, "or");
    assert.equal(both.reduce((n, g) => n + g.hits.length, 0), 2);
  });
});

test("recherche PG : unindexSource → l'item sort des résultats après suppression", async () => {
  await inCtx(async () => {
    const { sid } = await seed("review", "L99 temporaire", "Contenu éphémère unique zorglub.");
    assert.equal((await search("zorglub", 10)).length, 1);
    await unindexSource(sid);
    await q.run(`DELETE FROM items WHERE source_id = ?`, sid);
    await q.run(`DELETE FROM sources WHERE id = ?`, sid);
    assert.equal((await search("zorglub", 10)).length, 0);
  });
});
