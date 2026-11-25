/**
 * RÉVISIONS : l'intervalle d'une notion testée par un examen est multiplié par son facteur (SM-2
 * simplifié, lib/schedule markTested). Sans plafond, une notion testée une vingtaine de fois
 * dépassait la plus grande date de JavaScript : « Invalid time value », et l'examen suivant qui
 * la testait échouait juste après son PDF (banc du 25/11/2026, intervalle à 18 673 833 jours).
 * Une notion citée deux fois par le même examen (question + révision due) avançait deux fois.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-schedule-plafond-"));
const ENV: Record<string, string> = { CORTEX_DATA_DIR: tmp, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory" };
Object.assign(process.env, ENV);

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function inCourse<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse("cs-202", fn);
}

async function intervalOf(concept: string): Promise<number> {
  const { q } = await import("../db/q");
  return Number((await q.get<{ interval_days: number }>(`SELECT interval_days FROM schedule WHERE concept = ?`, concept))!.interval_days);
}

test("une notion testée 40 fois : jamais d'échec, l'intervalle s'arrête au plafond (un an)", async () => {
  const { markTested, MAX_INTERVAL_DAYS } = await import("../lib/schedule");
  assert.equal(MAX_INTERVAL_DAYS, 365);
  await inCourse(async () => {
    for (let i = 0; i < 40; i++) await markTested(["Ordonnancement : round-robin"]);
    assert.equal(await intervalOf("Ordonnancement : round-robin"), MAX_INTERVAL_DAYS);
    const { q } = await import("../db/q");
    const due = (await q.get<{ next_due_at: string }>(`SELECT next_due_at FROM schedule WHERE concept = ?`, "Ordonnancement : round-robin"))!.next_due_at;
    assert.match(due, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "une date lisible, pas « +053154-… »");
  });
});

test("une ligne déjà emballée (intervalle de millions de jours) revient au plafond au prochain examen", async () => {
  const { markTested, MAX_INTERVAL_DAYS } = await import("../lib/schedule");
  await inCourse(async () => {
    const { q } = await import("../db/q");
    await markTested(["Pagination : TLB"]);
    await q.run(`UPDATE schedule SET interval_days = ?, ease = ? WHERE concept = ?`, 18_673_833, 2.5, "Pagination : TLB");
    await markTested(["Pagination : TLB"]);
    assert.equal(await intervalOf("Pagination : TLB"), MAX_INTERVAL_DAYS);
  });
});

test("une notion citée deux fois par le même examen n'avance qu'une fois", async () => {
  const { markTested } = await import("../lib/schedule");
  await inCourse(async () => {
    await markTested(["Sockets : listen et accept"]);
    await markTested(["Sockets : listen et accept"]);
    const once = await intervalOf("Sockets : listen et accept");
    await markTested(["Fichiers : inode"]);
    await markTested(["Fichiers : inode", "Fichiers : inode"]);
    assert.equal(await intervalOf("Fichiers : inode"), once);
  });
});
