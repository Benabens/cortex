import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * LES COURS EN BASE — Postgres réel in-process (PGlite), zéro Docker.
 *
 * Deux garanties sont prouvées ici :
 *  1. ÉTAPE 1 — la table `courses` du store GLOBAL est la source de vérité, la
 *     couche d'accès la lit, et un identifiant inconnu ne retombe PLUS sur cs-202.
 *  2. ÉTAPE 2 — la migration est NON DESTRUCTIVE : sur une base qui contient
 *     déjà des données, le propriétaire retrouve APRÈS migration exactement ses
 *     cours ET tout leur contenu (annales, banque de questions, faiblesses,
 *     planning, examens). C'est le critère bloquant du lot.
 */

// Le cours factice n'est migré qu'hors production : le shell de dev peut exporter NODE_ENV=production.
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.CORTEX_OWNER_EMAIL = "proprietaire@exemple.test";

import { runWithCourse } from "../db/client";
import { runWithUser, tenantSchema } from "../db/context";
import { q } from "../db/q";
import { authAll, authRun } from "../db/auth-store";
import { migrateLegacyCourses, readCourses } from "../db/courses-store";
import {
  coursePaths,
  courseExists,
  ensureCoursesLoaded,
  getCourse,
  listCoursesOf,
  ownsCourse,
  reloadCourses,
  resetCoursesCache,
  UnknownCourseError,
} from "../lib/courses";

const OWNER_ID = "usr_ben_2f9c";
const OWNER_EMAIL = "proprietaire@exemple.test";
const STRANGER_ID = "usr_inconnu_7b11";

/** Contenu RÉEL déposé AVANT la migration — c'est lui qui doit survivre. */
const AVANT = {
  annales: [
    { path: "refs/final-2024.pdf", title: "Final 2024", year: 2024 },
    { path: "refs/final-2023.pdf", title: "Final 2023", year: 2023 },
  ],
  faiblesses: [
    { topic: "pagination", severity: 3 },
    { topic: "TCP Reno", severity: 2 },
  ],
  banque: [{ kind: "qcm", topic: "inodes", statement: "Combien de blocs directs ?" }],
  planning: [{ kind: "open", topic: "sockets", statement: "Décris un handshake." }],
  examens: [{ id: 1, status: "done", html_path: "exams/exam-1.html" }],
};

async function seedExistingData(): Promise<void> {
  // Un compte réel, avec son e-mail — c'est lui que CORTEX_OWNER_EMAIL désigne.
  await authRun(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)`,
    OWNER_ID, OWNER_EMAIL, "Propriétaire",
  );
  await runWithUser(OWNER_ID, () =>
    runWithCourse("cs-202", async () => {
      for (const a of AVANT.annales) {
        await q.run(
          `INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?, ?, ?, ?, ?)`,
          a.path, a.title, a.year, "final", 0,
        );
      }
      for (const w of AVANT.faiblesses) {
        await q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, w.topic, w.severity);
      }
      for (const b of AVANT.banque) {
        await q.run(
          `INSERT INTO bank_questions (kind, topic, statement) VALUES (?, ?, ?)`,
          b.kind, b.topic, b.statement,
        );
      }
      for (const p of AVANT.planning) {
        await q.run(
          `INSERT INTO revision_plan (kind, topic, statement) VALUES (?, ?, ?)`,
          p.kind, p.topic, p.statement,
        );
      }
      for (const e of AVANT.examens) {
        await q.run(
          `INSERT INTO exams (id, status, html_path) VALUES (?, ?, ?)`,
          e.id, e.status, e.html_path,
        );
      }
    })
  );
  // Un second cours du même propriétaire, avec ses propres données.
  await runWithUser(OWNER_ID, () =>
    runWithCourse("ml", () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "kernels", 1))
  );
}

before(async () => {
  delete process.env.CORTEX_USER;
  resetCoursesCache();
  await seedExistingData();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
  delete process.env.CORTEX_OWNER_EMAIL;
  resetCoursesCache();
});

// ─────────────────────────── ÉTAPE 1 ───────────────────────────

test("E1 — la table `courses` existe dans le store global et la couche d'accès la lit", async () => {
  const report = await migrateLegacyCourses();
  assert.ok(report.created.includes("cs-202"), "cs-202 doit être matérialisé");
  assert.ok(report.created.includes("ml"), "un cours avec un tenant existant doit être migré");

  const rows = await authAll<{ id: string }>(`SELECT id FROM courses ORDER BY id`);
  assert.ok(rows.length > 0, "la table courses doit contenir des lignes");

  await reloadCourses();
  const cs = getCourse("cs-202");
  assert.equal(cs.name, "Computer Systems");
  assert.equal(cs.examCode, "CS-202");
  assert.equal(cs.university, "EPFL");
});

test("E1 — un identifiant inconnu lève une erreur explicite (plus de repli sur cs-202)", async () => {
  await ensureCoursesLoaded();
  assert.equal(courseExists("matiere-qui-nexiste-pas"), false);
  assert.throws(
    () => getCourse("matiere-qui-nexiste-pas"),
    (e: unknown) => e instanceof UnknownCourseError,
    "getCourse doit refuser, pas servir cs-202",
  );
});

test("E1 — migration idempotente : rejouée, elle ne crée rien et n'écrase rien", async () => {
  const avant = await readCourses();
  const r1 = await migrateLegacyCourses();
  const r2 = await migrateLegacyCourses();
  assert.deepEqual(r1.created, [], "rien à créer au second passage");
  assert.deepEqual(r2.created, []);
  const apres = await readCourses();
  assert.deepEqual(
    apres.map((c) => [c.id, c.owner_user_id, c.name, c.created_at]),
    avant.map((c) => [c.id, c.owner_user_id, c.name, c.created_at]),
    "aucune ligne réécrite",
  );
});

test("E1 — le propriétaire est PARAMÉTRABLE (CORTEX_OWNER_EMAIL), jamais codé en dur", async () => {
  const rows = await authAll<{ id: string; owner_user_id: string }>(`SELECT id, owner_user_id FROM courses`);
  for (const r of rows) {
    assert.equal(r.owner_user_id, OWNER_ID, `${r.id} doit appartenir au compte désigné par l'e-mail`);
  }
});

// ─────────────────────────── ÉTAPE 2 ───────────────────────────

test("E2 — APRÈS migration, le propriétaire retrouve EXACTEMENT ses cours", async () => {
  await ensureCoursesLoaded();
  const mine = listCoursesOf(OWNER_ID).map((c) => c.id).sort();
  // Tout le catalogue historique est rattaché au propriétaire désigné — c'est la
  // consigne « ne rien perdre » : mieux vaut une fiche en trop qu'un cours orphelin.
  assert.deepEqual(mine, ["algo", "cs-202", "fictif", "ml"], `cours du propriétaire : ${mine.join(", ")}`);
  assert.equal(listCoursesOf(STRANGER_ID).length, 0, "un inconnu n'hérite d'aucun cours");
  assert.equal(ownsCourse(STRANGER_ID, "cs-202"), false);
  assert.equal(ownsCourse(OWNER_ID, "cs-202"), true);
});

test("E2 — le lien avec les tenants existants est PRÉSERVÉ (t_<user>_<cours> inchangé)", () => {
  const avant = runWithUser(OWNER_ID, () => runWithCourse("cs-202", () => tenantSchema()));
  // Le nom du tenant ne dépend que du couple (utilisateur, cours) : mettre le
  // cours en base ne doit RIEN y changer — sinon les données seraient orphelines.
  assert.match(avant, /^t_usr_ben_2f9c_[0-9a-f]{8}_cs_202$/, avant);
});

test("E2 — CRITIQUE : tout le contenu existant est intact après migration", async () => {
  await ensureCoursesLoaded();
  await runWithUser(OWNER_ID, () =>
    runWithCourse("cs-202", async () => {
      const annales = await q.all<{ path: string; title: string; year: number }>(
        `SELECT path, title, year FROM exam_refs ORDER BY year DESC`
      );
      assert.deepEqual(
        annales.map((a) => [a.path, a.title, a.year]),
        AVANT.annales.map((a) => [a.path, a.title, a.year]),
        "annales perdues ou altérées",
      );

      const faiblesses = await q.all<{ topic: string; severity: number }>(
        `SELECT topic, severity FROM weaknesses ORDER BY topic`
      );
      // Comparaison par ENSEMBLE : l'ordre de tri dépend de la collation SQL,
      // ce qui n'a rien à voir avec ce qu'on prouve ici (rien n'a été perdu).
      assert.deepEqual(
        new Set(faiblesses.map((w) => `${w.topic}:${w.severity}`)),
        new Set(AVANT.faiblesses.map((w) => `${w.topic}:${w.severity}`)),
        "faiblesses perdues",
      );

      const banque = await q.all<{ topic: string; statement: string }>(
        `SELECT topic, statement FROM bank_questions ORDER BY topic`
      );
      assert.deepEqual(banque.map((b) => b.statement), AVANT.banque.map((b) => b.statement), "banque de questions perdue");

      const planning = await q.all<{ topic: string }>(`SELECT topic FROM revision_plan ORDER BY topic`);
      assert.deepEqual(planning.map((p) => p.topic), AVANT.planning.map((p) => p.topic), "planning perdu");

      const examens = await q.all<{ id: number; html_path: string }>(`SELECT id, html_path FROM exams ORDER BY id`);
      assert.deepEqual(
        examens.map((e) => [e.id, e.html_path]),
        AVANT.examens.map((e) => [e.id, e.html_path]),
        "examens générés perdus",
      );
    })
  );

  // Le second cours du propriétaire aussi.
  await runWithUser(OWNER_ID, () =>
    runWithCourse("ml", async () => {
      const rows = await q.all<{ topic: string }>(`SELECT topic FROM weaknesses`);
      assert.deepEqual(rows.map((r) => r.topic), ["kernels"]);
    })
  );
});

test("E2 — les CHEMINS historiques sont recopiés tels quels (aucun fichier à déplacer)", async () => {
  await ensureCoursesLoaded();
  const cs = getCourse("cs-202");
  assert.deepEqual(cs.paths, {
    dbFile: "cortex.db",
    refsRel: "refs",
    examsRel: "exams",
    uploadsRel: "uploads",
    contentRel: "..",
  });
  const p = coursePaths("cs-202");
  assert.ok(p.dbPath.endsWith("/cortex.db"), p.dbPath);
  assert.ok(p.refsDir.endsWith("/refs"), p.refsDir);
});

test("E2 — la migration se désactive pour une installation vraiment neuve", async () => {
  // Une base tierce qui ne veut aucune matière préfabriquée pose l'opt-out.
  process.env.CORTEX_MIGRATE_LEGACY_COURSES = "0";
  try {
    const { migrateLegacyCourses: again } = await import("../db/courses-store");
    const r = await again();
    assert.deepEqual(r.created, []);
    assert.ok(r.skipped.length > 0, "tout le catalogue doit être annoncé comme ignoré");
  } finally {
    delete process.env.CORTEX_MIGRATE_LEGACY_COURSES;
  }
});
