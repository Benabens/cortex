/**
 * PRÉ-LANCEMENT 11 — coût SQL des chemins de lecture. Deux gaspillages mesurés
 * par l'audit :
 *  - `listWeaknesses` résolvait les items liés une requête à la fois, sans borne
 *    (une faiblesse avec 5 items = 5 requêtes, 200 faiblesses = 1000) ;
 *  - `ensureTable`/`ensureColumns` rejouaient la DDL et une lecture du catalogue
 *    à CHAQUE appel de fonction de bibliothèque, alors que le schéma du tenant
 *    est déjà créé — des dizaines d'aller-retours par requête HTTP.
 * Ce test compte les requêtes réellement exécutées (compteur du pilote).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

const inCourse = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser("owner", () => runWithCourse("ml", fn));
};

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  await inCourse(async () => {
    const { q } = await import("../db/q");

    const src = await q.insert(`INSERT INTO sources (type, title, path) VALUES (?,?,?)`, "final", "Final 2025", "refs/f25.pdf");
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await q.insert(`INSERT INTO items (source_id, type, text, anchor) VALUES (?,?,?,?)`, src, "exercise", `Ex ${i}`, `p${i}`));
    }
    // 12 faiblesses, chacune liée aux 5 items : les 60 résolutions doivent coûter une requête.
    for (let i = 0; i < 12; i++) {
      await q.run(
        `INSERT INTO weaknesses (topic, description, severity, related_item_ids, logged_at) VALUES (?,?,?,?,?)`,
        `Sujet ${i}`, null, 2, JSON.stringify(ids), "2026-09-28 10:00:00",
      );
    }
  });
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("listWeaknesses : coût constant en requêtes, quel que soit le nombre d'items liés", async () => {
  const { queryCountForTests, resetQueryCountForTests } = await import("../db/q");
  const { listWeaknesses } = await import("../lib/weaknesses");
  const rows = await inCourse(async () => {
    resetQueryCountForTests();
    return listWeaknesses();
  });
  const used = queryCountForTests();
  assert.equal(rows.length, 12);
  assert.equal(rows[0].related.length, 5, "les items liés sont toujours résolus");
  assert.ok(used <= 4, `12 faiblesses × 5 items liés doivent coûter quelques requêtes, pas une par item (mesuré : ${used})`);
});

test("listWeaknesses : liste bornée (pagination), la borne est respectée", async () => {
  const { listWeaknesses } = await import("../lib/weaknesses");
  const page = await inCourse(() => listWeaknesses({ limit: 5 }));
  assert.equal(page.length, 5);
  const defaultPage = await inCourse(() => listWeaknesses());
  assert.ok(defaultPage.length <= 200, "un défaut existe, la réponse ne croît pas sans fin");
});

test("schéma du tenant : la DDL de rattrapage ne se rejoue pas à chaque requête", async () => {
  const { q, queryCountForTests, resetQueryCountForTests } = await import("../db/q");
  await inCourse(async () => {
    await q.ensureTable("weaknesses");
    await q.ensureColumns("weaknesses", ["theme"]);
    resetQueryCountForTests();
    for (let i = 0; i < 10; i++) {
      await q.ensureTable("weaknesses");
      await q.ensureColumns("weaknesses", ["theme"]);
    }
  });
  assert.equal(queryCountForTests(), 0, "dix rappels après le premier ne doivent coûter aucune requête");
});

test("accueil : le nombre de requêtes pour /api/dashboard reste raisonnable", async () => {
  const { queryCountForTests, resetQueryCountForTests } = await import("../db/q");
  const { GET } = await import("../app/api/dashboard/route");
  const req = new NextRequest("http://cortex.test/api/dashboard?course=ml", { headers: { "x-cortex-user": "owner" } });
  await GET(req); // premier appel : création paresseuse des schémas
  resetQueryCountForTests();
  const r = await GET(req);
  assert.equal(r.status, 200, await r.clone().text());
  const used = queryCountForTests();
  console.log(`[budget] /api/dashboard : ${used} requêtes SQL (hors premier appel)`);
  assert.ok(used <= 40, `l'accueil doit tenir sous 40 requêtes (mesuré : ${used})`);
});

test("mémo du schéma : une DDL annulée avec sa transaction n'est pas mémorisée", async () => {
  const { q, queryCountForTests, resetQueryCountForTests } = await import("../db/q");
  // La DDL mémoïsée dans une transaction qui échoue est ANNULÉE avec elle : garder
  // la mémo ferait croire à la table pour tout le reste du process, et chaque
  // lecture suivante échouerait sur « relation inexistante ».
  await inCourse(async () => {
    await assert.rejects(
      q.tx(async () => {
        await q.ensureTable("feedback");
        throw new Error("échec après la DDL");
      }),
      /échec après la DDL/,
    );
    resetQueryCountForTests();
    await q.ensureTable("feedback");
  });
  assert.ok(queryCountForTests() > 0, "la DDL doit être rejouée après l'annulation");
});
