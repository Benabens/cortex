/**
 * LIENS « VOIR » MORTS (chasse aux bugs, 22/11/2026). En production : 73/73 sources du cours
 * cs-202 menaient à /voir ou /sites (404 du proxy), et 32/60 d'algo, 58/66 de ml à un /csrc dont
 * l'original n'a jamais été copié (« Not found » en texte brut). Ce qu'on garde :
 *  - plus aucun lien /voir ni /sites, y compris ceux déjà écrits en base ;
 *  - la liste des sources ne propose « Voir » que si le fichier existe (ou reste sur l'ordinateur) ;
 *  - un « Voir » ouvert dans un onglet sur un original absent reçoit une page qui explique.
 * Seams : lib/deeplink, lib/ux/search, listCorpusSources, GET /csrc. PGlite, aucun réseau.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-liens-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
const env = process.env as Record<string, string | undefined>;

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  const { insertCourse } = await import("../db/courses-store");
  await ensureCoursesLoaded();
  await insertCourse({
    id: "monsys", owner_user_id: "alice", name: "Systèmes", short: "SYS", code: "SYS-101", exam_name: "Systèmes",
    exam_kind: "Final", university: null, university_lines: "[]", faculty: null, teachers: "[]", language: "fr",
    profile_id: null, duration_min: 180, exam_date: null, db_file: null, refs_rel: null, exams_rel: null,
    uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const cp = runWithUser("alice", () => coursePaths("monsys"));
  fs.mkdirSync(path.join(cp.contentRoot, "slides"), { recursive: true });
  fs.writeFileSync(path.join(cp.contentRoot, "slides", "lecture_1.pdf"), "PDF");
  fs.mkdirSync(cp.refsDir, { recursive: true });
  fs.writeFileSync(path.join(cp.refsDir, "final-2023.pdf"), "PDF");
  await runWithUser("alice", () => runWithCourse("monsys", async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const add = (type: string, title: string, p: string) =>
      q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, p, null, 1);
    await add("course_pdf", "Lecture 1", "slides/lecture_1.pdf"); // présent
    await add("course_pdf", "Lecture 2", "lectures/lecture_1.pdf"); // préfixe périmé : retrouvé par son nom
    await add("final", "Final 2023", "refs/final-2023.pdf"); // présent (refs/)
    await add("exercise", "Final 2021 (énoncé)", "exercices/final2021_enonce.html"); // jamais copié
    await add("course_pdf", "Lecture 9", "slides/lecture_9.pdf"); // jamais copié, mais resté sur l'ordinateur
    const { recordLocal } = await import("../lib/originals/registry");
    await recordLocal({ path: "slides/lecture_9.pdf", name: "lecture_9.pdf", sha256: "c".repeat(64), size: 3, origin: "upload" });
  }));
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://cortex.test${url}`, { headers: { "x-cortex-user": "alice", "x-cortex-course": "monsys", ...headers } });

test("cs-202 : les liens de source passent par /csrc, jamais par /voir ni /sites (404 en production)", async () => {
  const { sourceHref } = await import("../lib/deeplink");
  const { hitHref } = await import("../lib/ux/search");
  assert.equal(sourceHref("cs-202", "exercices/final2021_enonce.html", "exercices/final2021_enonce.html"),
    "/csrc?course=cs-202&p=exercices%2Ffinal2021_enonce.html");
  assert.equal(sourceHref("cs-202", "cours/Part1.pdf", "cours/Part1.pdf#page=4"), "/csrc?course=cs-202&p=cours%2FPart1.pdf#page=4");
  const hit = { sourcePath: "exercices/final2021_enonce.html", anchor: "exercices/final2021_enonce.html", itemId: 7 };
  assert.equal(hitHref("cs-202", hit as Parameters<typeof hitHref>[1]), "/csrc?course=cs-202&p=exercices%2Ffinal2021_enonce.html");
});

test("liens déjà en base : /voir et /sites relus vers /csrc, le reste intact", async () => {
  const { liveSourceHref } = await import("../lib/deeplink");
  assert.equal(liveSourceHref("cs-202", "/voir?src=exercices%2Ffinal2022_table.html&item=12&q=tcp"),
    "/csrc?course=cs-202&p=exercices%2Ffinal2022_table.html");
  assert.equal(liveSourceHref("cs-202", "/sites/cours/CS202_Lectures_Part2_OS_L11-L18.pdf#page=7"),
    "/csrc?course=cs-202&p=cours%2FCS202_Lectures_Part2_OS_L11-L18.pdf#page=7");
  assert.equal(liveSourceHref("algo", "/csrc?course=algo&p=x.pdf#page=2"), "/csrc?course=algo&p=x.pdf#page=2");
  assert.equal(liveSourceHref("algo", null), null);
});

test("liste des sources : « Voir » seulement si le fichier existe ou reste sur l'ordinateur", async () => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { listCorpusSources } = await import("../lib/sources");
  const rows = await runWithUser("alice", () => runWithCourse("monsys", () => listCorpusSources()));
  const href = Object.fromEntries(rows.map((r) => [r.path, r.href]));
  assert.equal(href["slides/lecture_1.pdf"], "/csrc?course=monsys&p=slides%2Flecture_1.pdf");
  assert.ok(href["lectures/lecture_1.pdf"], "retrouvé par son nom, comme /csrc le sert");
  assert.ok(href["refs/final-2023.pdf"]);
  assert.ok(href["slides/lecture_9.pdf"], "original resté sur l'ordinateur : /csrc mène à la page locale");
  assert.equal(href["exercices/final2021_enonce.html"], null, "original jamais copié : pas de lien mort");
});

test("/csrc : original absent → page qui explique pour une navigation, 404 court pour un script", async () => {
  const { GET } = await import("../app/csrc/route");
  const page = await GET(req("/csrc?p=exercices/final2021_enonce.html", { accept: "text/html,application/xhtml+xml", "accept-language": "fr" }));
  assert.equal(page.status, 404);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /sandbox/);
  const html = await page.text();
  assert.match(html, /Original indisponible/);
  assert.match(html, /href="\/sources\?course=monsys"/);
  const api = await GET(req("/csrc?p=exercices/final2021_enonce.html"));
  assert.equal(api.status, 404);
  assert.equal(await api.text(), "Not found");
  const served = await GET(req("/csrc?p=slides/lecture_1.pdf"));
  assert.equal(served.status, 200);
  const renamed = await GET(req("/csrc?p=lectures/lecture_1.pdf"));
  assert.equal(renamed.status, 200, "repli par basename conservé");
});
