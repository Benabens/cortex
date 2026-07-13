import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * Driver SQLite de la façade q : bootstrap complet des DB de cours neuves
 * (db/tables.ts), transactions atomiques (rollback), aplatissement des tx
 * imbriquées, sérialisation FIFO — dans un répertoire temporaire (cwd déplacé
 * AVANT l'import du client, qui résout data/ depuis process.cwd()).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sqlite-driver-"));
const realCwd = process.cwd();

// le client résout data/ depuis process.cwd() AU CHARGEMENT → chdir puis import dynamique
let runWithCourse: typeof import("../db/client").runWithCourse;
let q: typeof import("../db/q").q;
let nowStr: typeof import("../db/q").nowStr;
let nowPlusDays: typeof import("../db/q").nowPlusDays;

const ready = (async () => {
  process.chdir(tmp);
  ({ runWithCourse } = await import("../db/client"));
  ({ q, nowStr, nowPlusDays } = await import("../db/q"));
})();

import { before } from "node:test";
before(() => ready);

after(() => {
  process.chdir(realCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("bootstrap : une DB de cours neuve reçoit le schéma COMPLET (ex-tables lazy incluses)", async () => {
  await runWithCourse("ml", async () => {
    for (const t of ["sources", "items", "weaknesses", "schedule", "exams", "exam_questions", "jobs", "topics", "bank_questions", "vocab"]) {
      const cols = await q.columns(t);
      assert.ok(cols.length > 0, `table ${t} absente du bootstrap`);
    }
    // les colonnes ex-ALTER sont là dès la création
    assert.ok((await q.columns("exams")).includes("verify_summary"));
    assert.ok((await q.columns("topics")).includes("exo_type"));
    assert.ok((await q.columns("weaknesses")).includes("analyzed"));
  });
  assert.ok(fs.existsSync(path.join(tmp, "data", "ml", "ml.db")));
});

test("q.run/q.get/q.insert : aller-retour + lastInsertRowid", async () => {
  await runWithCourse("ml", async () => {
    const id = await q.insert(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "fork", 3);
    assert.ok(id >= 1);
    const row = await q.get<{ topic: string; severity: number }>(`SELECT topic, severity FROM weaknesses WHERE id = ?`, id);
    assert.deepEqual(row, { topic: "fork", severity: 3 });
  });
});

test("q.tx : rollback atomique sur erreur", async () => {
  await runWithCourse("ml", async () => {
    const before = (await q.get<{ n: number }>(`SELECT count(*) n FROM topics`))!.n;
    await assert.rejects(
      q.tx(async () => {
        await q.run(`INSERT INTO topics (label) VALUES (?)`, "t1");
        await q.run(`INSERT INTO topics (label) VALUES (?)`, "t2");
        throw new Error("boom");
      })
    );
    assert.equal((await q.get<{ n: number }>(`SELECT count(*) n FROM topics`))!.n, before);
  });
});

test("q.tx : tx imbriquée aplatie (pas de BEGIN dans BEGIN)", async () => {
  await runWithCourse("ml", async () => {
    await q.tx(async () => {
      await q.run(`INSERT INTO topics (label) VALUES (?)`, "outer");
      await q.tx(async () => {
        await q.run(`INSERT INTO topics (label) VALUES (?)`, "inner");
      });
    });
    const n = (await q.get<{ n: number }>(`SELECT count(*) n FROM topics WHERE label IN ('outer','inner')`))!.n;
    assert.equal(n, 2);
  });
});

test("mutex : une tx ouverte n'est pas interleavée par une chaîne concurrente", async () => {
  await runWithCourse("ml", async () => {
    const order: string[] = [];
    const tx = q.tx(async () => {
      order.push("tx-start");
      await q.run(`INSERT INTO topics (label) VALUES (?)`, "mtx-1");
      await new Promise((r) => setTimeout(r, 30)); // laisse la chaîne B tenter de s'immiscer
      await q.run(`INSERT INTO topics (label) VALUES (?)`, "mtx-2");
      order.push("tx-end");
    });
    const other = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      await q.run(`INSERT INTO topics (label) VALUES (?)`, "outside");
      order.push("outside-done");
    })();
    await Promise.all([tx, other]);
    assert.deepEqual(order, ["tx-start", "tx-end", "outside-done"]);
  });
});

test("nowStr/nowPlusDays : format canonique SQLite datetime('now')", () => {
  assert.match(nowStr(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const d0 = new Date(nowStr().replace(" ", "T") + "Z").getTime();
  const d3 = new Date(nowPlusDays(3).replace(" ", "T") + "Z").getTime();
  assert.equal(Math.round((d3 - d0) / 86_400_000), 3);
});

test("INSERT ... ON CONFLICT DO NOTHING (ex-OR IGNORE) fonctionne en SQLite", async () => {
  await runWithCourse("ml", async () => {
    await q.run(`INSERT INTO schedule (concept) VALUES (?) ON CONFLICT DO NOTHING`, "c1");
    await q.run(`INSERT INTO schedule (concept) VALUES (?) ON CONFLICT DO NOTHING`, "c1");
    assert.equal((await q.get<{ n: number }>(`SELECT count(*) n FROM schedule WHERE concept = 'c1'`))!.n, 1);
  });
});
