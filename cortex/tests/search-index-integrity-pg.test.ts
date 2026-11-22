/**
 * Intégrité de l'index de recherche par tenant, en Postgres (PGlite).
 *
 * Bugs de prod (chasse aux bugs du 22/11/2026) :
 *  - tenants migrés par scripts/migrate-to-postgres sans items.text_norm : recherche ET ancrage
 *    des générations vides (CS-202 et CS-250 réparés à la main le 21/11) ;
 *  - vocabulaire gardé en cache à vie par le serveur : la reconstruction faite par l'ingestion
 *    (un autre processus) n'était vue qu'au redémarrage, et le cache était partagé entre comptes ;
 *  - prod-boot : un tenant dont le cours a disparu était migré… sous cs-202, ce qui créait un
 *    schéma cs-202 vide et sa ligne de registre pour ce compte.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
const env = process.env as Record<string, string | undefined>;

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";
import { normalize } from "../lib/text";

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete env[k];
});

const inTenant = <T,>(user: string, course: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse(course, fn));

/** Un passage écrit comme le faisait la migration SQLite → Postgres : sans text_norm. */
async function rawItem(title: string, text: string): Promise<number> {
  const sid = await q.insert(`INSERT INTO sources (type, title, path, recency_weight) VALUES (?,?,?,?)`, "course_pdf", title, `/${title}`, 1);
  return q.insert(`INSERT INTO items (source_id, type, title, text, anchor) VALUES (?,?,?,?,?)`, sid, "course", title, text, `#${title}`);
}

const hits = async (s: string) => (await (await import("../lib/search")).rankedHits(s, 10)).length;

test("repairSearchIndex : un tenant migré sans text_norm redevient cherchable, vocabulaire compris", async () => {
  const { repairSearchIndex } = await import("../lib/search");
  await inTenant("u-migre", "ml", async () => {
    const id = await rawItem("Chapitre 4 — Graphes", "Algorithme de Dijkstra et flots maximaux (max-flow).");
    assert.equal(await hits("dijkstra"), 0, "avant : passage invisible");
    const r = await repairSearchIndex();
    assert.equal(r.textNorm, 1);
    assert.ok(r.vocab && r.vocab > 0, "vocabulaire vide reconstruit");
    assert.equal(await hits("dijkstra"), 1);
    assert.equal(await hits("dijstra"), 1, "la faute est corrigée par le vocabulaire reconstruit");
    const row = await q.get<{ text_norm: string }>(`SELECT text_norm FROM items WHERE id = ?`, id);
    assert.equal(row?.text_norm, normalize("Chapitre 4 — Graphes Algorithme de Dijkstra et flots maximaux (max-flow)."), "même formule qu'à l'écriture");
    assert.deepEqual(await repairSearchIndex(), { textNorm: 0, vocab: null }, "idempotent");
  });
});

test("repairSearchIndex : par lots, sans en sauter", async () => {
  const { repairSearchIndex } = await import("../lib/search");
  await inTenant("u-lots", "ml", async () => {
    for (let i = 0; i < 7; i++) await rawItem(`Page ${i}`, `contenu numéro ${i} lemniscate`);
    assert.equal((await repairSearchIndex({ batch: 3 })).textNorm, 7);
    assert.equal(Number((await q.get<{ n: number }>(`SELECT count(*) n FROM items WHERE text_norm IS NULL`))?.n), 0);
    assert.equal(await hits("lemniscate"), 7);
  });
});

test("vocabulaire : une reconstruction faite ailleurs (worker d'ingestion) est vue sans redémarrage", async () => {
  const { indexItemForSearch } = await import("../lib/search");
  // Relecture de l'empreinte à chaque recherche (30 s par défaut) : le test n'attend pas.
  env.SEARCH_VOCAB_RECHECK_MS = "0";
  after(() => { delete env.SEARCH_VOCAB_RECHECK_MS; });
  await inTenant("u-vocab", "ml", async () => {
    const id = await rawItem("Cours 2", "La méthode de Newton-Raphson converge quadratiquement.");
    await indexItemForSearch(id, 0, "Cours 2", "La méthode de Newton-Raphson converge quadratiquement.");
    assert.equal(await hits("raphsno"), 0, "vocabulaire encore vide : pas de correction");
    // L'ingestion (autre processus) écrit la table vocab directement.
    await q.run(`INSERT INTO vocab (term, df) VALUES (?, ?)`, "raphson", 1);
    assert.equal(await hits("raphsno"), 1, "le vocabulaire relu corrige la faute");
  });
});

test("vocabulaire : jamais celui d'un autre compte pour le même identifiant de cours", async () => {
  const { rebuildVocab } = await import("../lib/search");
  await inTenant("u-alice", "algo", async () => {
    await rawItem("Notes", "triangulation de Delaunay");
    await rebuildVocab();
    assert.equal(await hits("delaunya"), 0, "sans text_norm le passage reste invisible, mais le vocabulaire est chargé");
  });
  await inTenant("u-bob", "algo", async () => {
    const id = await rawItem("Notes", "triangulation de Delaunay");
    await q.run(`UPDATE items SET text_norm = ? WHERE id = ?`, normalize("Notes triangulation de Delaunay"), id);
    assert.equal(await hits("delaunya"), 0, "le vocabulaire d'Alice ne corrige pas les recherches de Bob");
  });
});

test("migrateTenants : tenant d'un cours disparu ignoré (aucun schéma cs-202 créé), index des autres réparé", async () => {
  const { authAll, authRun } = await import("../db/auth-store");
  const { migrateTenants } = await import("../lib/tenant-migrations");
  await inTenant("u-boot", "ml", async () => { await rawItem("Annale 2024", "Exercice sur les chaînes de Markov"); });
  await authRun(
    `INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?,?,?,?)`,
    "ancien-compte", "cours-supprime", "t_ancien_compte_cours_supprime", "2026-10-01 00:00:00",
  );
  const logs: string[] = [];
  await migrateTenants((m) => logs.push(m));
  assert.ok(logs.some((l) => /ignoré : tenant ancien-compte × cours-supprime/.test(l)), logs.join("\n"));
  const ghost = await authAll<{ course: string }>(`SELECT course FROM tenants WHERE user_id = ?`, "ancien-compte");
  assert.deepEqual(ghost.map((r) => r.course), ["cours-supprime"], "aucune ligne de registre cs-202 ajoutée");
  const schemas = await authAll<{ s: string }>(`SELECT schema_name s FROM information_schema.schemata WHERE schema_name LIKE 't_ancien%'`);
  assert.deepEqual(schemas, [], "aucun schéma créé pour le tenant orphelin");
  assert.ok(logs.some((l) => /u-boot × ml/.test(l)) && logs.some((l) => /index de recherche réparé : 1 passage/.test(l)), logs.join("\n"));
  await inTenant("u-boot", "ml", async () => { assert.equal(await hits("markov"), 1); });
});

test("diagnoseTenants : signale text_norm manquant, vocabulaire vide, schéma hors registre et registre sans schéma", async () => {
  const { authAll, authRun } = await import("../db/auth-store");
  const { diagnoseTenants } = await import("../lib/tenant-diag");
  const query = (sql: string, params: unknown[] = []) => authAll<Record<string, unknown>>(sql, ...(params as never[]));
  await inTenant("u-diag", "ml", async () => { await rawItem("Série 1", "intégrales de Riemann"); });
  await authRun(`CREATE SCHEMA IF NOT EXISTS t_orphelin_x_ml`);
  const report = await diagnoseTenants(query);
  const codes = (where: RegExp) => report.findings.filter((f) => where.test(f.where)).map((f) => f.code);
  assert.ok(codes(/u-diag × ml/).includes("text_norm_manquant"), JSON.stringify(report.findings, null, 1));
  assert.ok(codes(/u-diag × ml/).includes("vocabulaire_vide"));
  assert.ok(codes(/t_orphelin_x_ml/).includes("schema_hors_registre"));
  assert.ok(codes(/ancien-compte × cours-supprime/).includes("registre_sans_schema"));
  assert.ok(codes(/ancien-compte × cours-supprime/).includes("cours_inconnu"));
  // Un tenant réparé n'a plus de constat d'index.
  const { repairSearchIndex } = await import("../lib/search");
  await inTenant("u-diag", "ml", () => repairSearchIndex());
  const after = await diagnoseTenants(query);
  assert.deepEqual(after.findings.filter((f) => /u-diag × ml/.test(f.where) && f.severity !== "info").map((f) => f.code), []);
});
