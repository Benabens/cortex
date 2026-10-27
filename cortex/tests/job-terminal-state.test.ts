/**
 * UN JOB TERMINÉ NE SE ROUVRE PAS. Les étapes de progression des générations ne sont
 * pas toujours attendues (lib/program, lib/exam-dna appellent onStep sans await) : en
 * Postgres, un « ADN agrégé : 0 moules » à 98 % arrivait APRÈS « done, 100 % » et
 * l'écrasait — la préparation de HUM-285 semblait finir à 98 % (27/10/2026). Une mise à
 * jour qui ne termine pas le job ne touche plus un job terminé.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

const USER = "usr_job_terminal";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

const inCourse = <T>(fn: () => Promise<T>) => runWithUser(USER, () => runWithCourse("ml", fn));

test("une étape de progression arrivée après « done » n'écrase ni l'état, ni l'avancement, ni l'étape", async () => {
  const jobs = await import("../lib/jobs");
  await inCourse(async () => {
    const id = await jobs.createJob("prepare");
    await jobs.setJob(id, { status: "running", currentStep: "Blueprint : ADN…", progress: 90 });
    await jobs.setJob(id, { status: "done", progress: 100, currentStep: "Cours prêt ✓" });
    await jobs.setJob(id, { currentStep: "Blueprint : ADN agrégé : 0 moules", progress: 98 });
    await jobs.setJob(id, { currentStep: "Format : fini", progress: 100, status: "running" });
    const j = await jobs.getJob(id);
    assert.deepEqual([j?.status, j?.progress, j?.currentStep], ["done", 100, "Cours prêt ✓"]);
  });
});

test("un job annulé ou en échec reste dans cet état ; un état terminal peut toujours s'écrire", async () => {
  const jobs = await import("../lib/jobs");
  await inCourse(async () => {
    const canceled = await jobs.createJob("exam");
    await jobs.setJob(canceled, { status: "canceled" });
    await jobs.setJob(canceled, { status: "running", currentStep: "Architecte…", progress: 10 });
    assert.equal((await jobs.getJob(canceled))?.status, "canceled");

    const failing = await jobs.createJob("exam");
    await jobs.setJob(failing, { status: "running", progress: 40 });
    await jobs.setJob(failing, { status: "error", error: "moteur indisponible" });
    const j = await jobs.getJob(failing);
    assert.deepEqual([j?.status, j?.error], ["error", "moteur indisponible"]);
  });
});
