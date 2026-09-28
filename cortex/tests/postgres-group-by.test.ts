/**
 * CORRECTIFS PROD — requêtes valides en sqlite mais REFUSÉES par Postgres
 * (« column "s.title" must appear in the GROUP BY clause… », sum(booléen),
 * alias dans une expression ORDER BY). Chaque fonction concernée s'exécute ici
 * sur un vrai moteur Postgres (PGlite) avec des données qui exercent le cas
 * (doublons de chemin, banque de questions) et renvoie le résultat attendu.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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
    // Deux lignes pour le MÊME chemin (ré-ingestion) : la dédoublonnage par path est ce que GROUP BY path visait.
    await q.run(`INSERT INTO sources (type, title, path, year) VALUES (?,?,?,?)`, "final", "Final 2024", "refs/final-2024.pdf", 2024);
    await q.run(`INSERT INTO sources (type, title, path, year) VALUES (?,?,?,?)`, "final", "Final 2024 (bis)", "refs/final-2024.pdf", 2024);
    await q.run(`INSERT INTO sources (type, title, path, year) VALUES (?,?,?,?)`, "midterm", "Midterm 2023", "refs/midterm-2023.pdf", 2023);
    await q.run(`INSERT INTO sources (type, title, path, year) VALUES (?,?,?,?)`, "lecture", "Cours 1", "content/c1.html", null);
    const s = await q.get<{ id: number }>(`SELECT id FROM sources WHERE title = ?`, "Final 2024");
    await q.run(`INSERT INTO items (source_id, type, text, anchor) VALUES (?,?,?,?)`, s!.id, "exercise", "Ex 1", "p1");
    await q.run(`INSERT INTO items (source_id, type, text, anchor) VALUES (?,?,?,?)`, s!.id, "exercise", "Ex 2", "p2");
  });
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("sources : examens dédoublonnés par chemin, corpus, résumé par type", async () => {
  const sources = await import("../lib/sources");
  const exams = await inCourse(() => sources.listExamSources());
  assert.deepEqual(exams.map((e) => e.path), ["refs/final-2024.pdf", "refs/midterm-2023.pdf"]);
  assert.equal(exams[0].items, 2);
  const corpus = await inCourse(() => sources.listCorpusSources());
  assert.deepEqual(corpus.map((c) => c.path).sort(), ["content/c1.html", "refs/final-2024.pdf", "refs/midterm-2023.pdf"]);
  const summary = await inCourse(() => sources.corpusSummary());
  assert.equal(summary.find((s) => s.type === "final")?.items, 2);
  const refs = await inCourse(() => sources.listExamSourceRows());
  assert.deepEqual(refs.map((r) => r.path), ["refs/midterm-2023.pdf", "refs/final-2024.pdf"], "un chemin une fois, triés par année");
});

test("banque de questions : statistiques par sujet (sum de booléens, tri sur alias)", async () => {
  const revision = await import("../lib/revision");
  await inCourse(async () => {
    const { q } = await import("../db/q");
    await revision.bankStats(); // crée le schéma
    await q.run(`INSERT INTO bank_questions (kind, topic, lecture_rank, statement, official_answer) VALUES (?,?,?,?,?)`, "qcm", "Régression", 2, "Q1", "A");
    await q.run(`INSERT INTO bank_questions (kind, topic, lecture_rank, statement, official_answer) VALUES (?,?,?,?,?)`, "open", "Régression", 2, "Q2", "B");
    await q.run(`INSERT INTO bank_questions (kind, topic, lecture_rank, statement, official_answer) VALUES (?,?,?,?,?)`, "qcm", "Divers", null, "Q3", "C");
  });
  const stats = await inCourse(() => revision.bankStats());
  assert.equal(stats.qcm, 2);
  assert.equal(stats.open, 1);
  assert.deepEqual(stats.byTopic.map((t) => [t.topic, Number(t.qcm), Number(t.open)]), [["Régression", 1, 1], ["Divers", 1, 0]], "sujets classés puis sans rang");
});

test("plus aucun GROUP BY path nu sur sources dans le code", async () => {
  const fs = await import("node:fs");
  for (const f of ["lib/eval.ts", "lib/exam-dna.ts", "lib/revision.ts", "lib/exam-index.ts", "lib/sources.ts"]) {
    // Le sous-select de dédoublonnage (`(SELECT min(id) … GROUP BY path)`) est conforme : retiré avant contrôle.
    const src = fs.readFileSync(f, "utf8").replace(/\(SELECT min\(id\)[^)]*\)/g, "");
    // Colonnes non agrégées (title, year…) + GROUP BY path : refusé par Postgres. (Le sous-select `min(id) … GROUP BY path` est, lui, conforme.)
    assert.ok(!/SELECT (s\.)?(path|type), (s\.)?title[^;`]*GROUP BY (s\.)?path/.test(src), `${f} : GROUP BY path non conforme Postgres`);
  }
});
