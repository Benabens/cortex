/**
 * Une page HTML enregistrée (Moodle, Canvas, site du cours) était indexée avec tout son corps :
 * menus, bandeau, pied de page, « Connexion » entraient dans le corpus et les prompts — audit
 * ingestion du 16/11/2026, P2. Le vrai script d'ingestion, sur un cours et une page fictifs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ingest, newCourse } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ingest-html-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LESSON = "The Orvelle transform maps every bounded wave to its spectrum. ".repeat(6);

/** Page d'une plateforme fictive : la leçon est dans <main>, entourée de la navigation du site. */
const platformPage = (content: string) => `<!doctype html><html><head><title>Week 3: Orvelle transform</title></head><body>
<header id="page-header"><a href="/login">Log in</a> Platform home</header>
<nav class="navbar"><ul><li>Dashboard</li><li>My courses</li><li>Calendar</li></ul></nav>
<aside role="complementary">Upcoming events: none</aside>
${content}
<footer>You are not logged in. Data retention summary. Get the mobile app.</footer>
</body></html>`;

async function itemTexts(course: string, rel: string): Promise<string> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  return runWithCourse(course, async () =>
    (await q.all<{ text: string }>(`SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.path = ?`, rel)).map((r) => r.text).join("\n"));
}

test("page de plateforme : seul le contenu principal entre dans le corpus", async () => {
  const c = await newCourse("Orvelle pages");
  fs.mkdirSync(path.join(c.contentRoot, "sites"), { recursive: true });
  fs.writeFileSync(path.join(c.contentRoot, "sites", "week3.html"), platformPage(`<main><div role="main"><h2>Orvelle transform</h2><p>${LESSON}</p></div></main>`));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const text = await itemTexts(c.id, "sites/week3.html");
  assert.match(text, /Orvelle transform maps every bounded wave/);
  for (const noise of ["Log in", "Dashboard", "My courses", "Upcoming events", "You are not logged in", "mobile app"]) {
    assert.ok(!text.includes(noise), `« ${noise} » ne devrait pas être indexé : ${text}`);
  }
});

test("page sans zone principale balisée : le corps reste lu, sans la navigation", async () => {
  const c = await newCourse("Orvelle page simple");
  fs.mkdirSync(path.join(c.contentRoot, "sites"), { recursive: true });
  fs.writeFileSync(path.join(c.contentRoot, "sites", "notes.html"), platformPage(`<div class="content"><h2>Orvelle transform</h2><p>${LESSON}</p></div>`));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const text = await itemTexts(c.id, "sites/notes.html");
  assert.match(text, /Orvelle transform maps every bounded wave/);
  assert.ok(!text.includes("My courses"), text);
});
