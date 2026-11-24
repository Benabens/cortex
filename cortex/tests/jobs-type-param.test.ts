/**
 * GET /api/jobs?type= — le type demandé était collé tel quel dans la requête SQL d'activeJob
 * (`type = '${type}'`) : `?type=x' OR '1'='1` renvoyait le dernier job du cours, annulé compris,
 * comme « actif » (constaté sur le banc local le 24/11/2026), et en Postgres une UNION pouvait lire
 * la table d'un autre schéma. Paramétré, et un type inconnu ne renvoie aucun job.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { runWithCourse } from "../db/client";

const COURSE = "ml";

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

async function activeOf(type: string): Promise<{ id: number; status: string } | null> {
  const route = await import("../app/api/jobs/route");
  const url = new URL(`http://localhost/api/jobs`);
  url.searchParams.set("course", COURSE);
  url.searchParams.set("type", type);
  const res = await route.GET(new NextRequest(url));
  assert.equal(res.status, 200);
  return (await res.json()).active;
}

test("?type= : un type connu rend son job actif, une injection ou un type inconnu ne rend rien", async () => {
  const jobs = await import("../lib/jobs");
  const { canceled, running } = await runWithCourse(COURSE, async () => {
    const canceled = await jobs.createJob("qcm");
    await jobs.setJob(canceled, { status: "canceled" });
    const running = await jobs.createJob("exam");
    await jobs.setJob(running, { status: "running" });
    return { canceled, running };
  });
  assert.equal((await activeOf("exam"))?.id, running);
  assert.equal(await activeOf("qcm"), null);
  assert.equal(await activeOf("x' OR '1'='1"), null);
  assert.equal(await activeOf("qcm' OR status = 'canceled' OR '1'='1"), null);
  assert.equal(await activeOf("examen"), null);
  // Le job annulé existe bien : seul le filtre le cachait.
  assert.equal((await runWithCourse(COURSE, () => jobs.getJob(canceled)))?.status, "canceled");
});
