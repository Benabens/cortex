/**
 * FILE DES AIDES — vu en prod le 22/11/2026 : un check_answer lancé pendant un drill du même compte
 * attendait avec « the server is at full capacity » et « About 10 min once started », puis démarrait
 * 15 s plus tard et finissait en une minute. Une place par compte dans la file des aides : il attend
 * SON drill, pas la charge du serveur ; et une correction dure une minute, pas les 10 min par défaut.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.MAX_GLOBAL_ASSIST_JOBS = "4";
process.env.MAX_ACTIVE_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "MAX_GLOBAL_ASSIST_JOBS", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

test("file des aides : attendre son propre drill est dit comme tel ; la charge du serveur reste dite comme avant", async () => {
  const { admitJob } = await import("../lib/job-queue");
  assert.deepEqual(await admitJob("ana", "algo", 1, "assist"), { admitted: true });
  assert.deepEqual(await admitJob("ana", "algo", 2, "assist"), { admitted: false, position: 1, own: true }, "places libres : c'est son drill qui bloque");
  process.env.MAX_GLOBAL_ASSIST_JOBS = "1";
  try {
    assert.deepEqual(await admitJob("ben", "algo", 1, "assist"), { admitted: false, position: 2 }, "plus de place : la charge, pas son propre job");
  } finally {
    process.env.MAX_GLOBAL_ASSIST_JOBS = "4";
  }
});

test("une correction derrière un drill du compte : étape « ton autre aide », ≈ 1 min une fois lancée", async () => {
  const user = "usr_file_aides";
  const jobs = await import("../lib/jobs");
  const { localizeJob } = await import("../lib/i18n/job-text");
  const { admitJob } = await import("../lib/job-queue");
  await runWithUser(user, () => runWithCourse("ml", async () => {
    await jobs.ensureJobsSchema();
    const drill = await jobs.insertReservedJob("drill", JSON.stringify({ concept: "Max-flow" }), "job:t:drill");
    assert.deepEqual(await admitJob(user, "ml", drill.id, "assist"), { admitted: true }, "le drill tient la place du compte");
    const check = await jobs.insertReservedJob("check", JSON.stringify({ statement: "Q", answer: "R" }), "job:t:check");
    await jobs.startWorker(check.id);
    const job = (await jobs.getJob(check.id))!;
    assert.equal(job.status, "queued");
    const eta = await jobs.jobEta(job);
    assert.equal(eta?.minutes, 1, "une correction, pas un examen blanc (10 min)");
    const en = localizeJob(job, eta, "en");
    assert.doesNotMatch(en.currentStep ?? "", /full capacity/);
    assert.match(en.currentStep ?? "", /your other practice question or grading/);
    assert.match(localizeJob(job, eta, "fr").currentStep ?? "", /ton autre aide/);
  }));
});
