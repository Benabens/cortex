/**
 * Un job resté « queued » sans PID (le worker n'a jamais démarré — spawn
 * échoué, ou réservation impossible dont la mise en erreur a elle-même
 * échoué) ne doit PAS être remis en file par la réconciliation : la pompe
 * lancerait alors un worker sans que la réservation soit garantie. Il passe
 * en erreur (remboursé si rien n'a coûté) ; l'utilisateur relance lui-même.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-unstarted-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

test("job queued sans PID depuis 3 min → erreur, pas de remise en file, la pompe ne le lance pas", async () => {
  const jobs = await import("../lib/jobs");
  const { q, nowStr } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, created_at, updated_at) VALUES (?,?,'queued','En file…',0,?,?)`,
      "exam", null, nowStr(-180_000), nowStr(-180_000),
    );
    const fixed = await jobs.reconcileStaleJobs();
    assert.ok(fixed >= 1);
    const row = await q.get<{ status: string; attempts: number | null; pid: number | null }>(`SELECT status, attempts, pid FROM jobs WHERE id = ?`, id);
    assert.equal(row?.status, "error", JSON.stringify(row));
    const started = await jobs.pumpQueuedJobs();
    assert.equal(started, 0);
  });
});
