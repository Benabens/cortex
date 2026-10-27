import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.CORTEX_MIGRATE_LEGACY_COURSES = "0";

import { authAll, authRun } from "../db/auth-store";
import {
  CourseCreationLimitError,
  deleteCourseRow,
  insertCourse,
  type CourseRow,
} from "../db/courses-store";
import type { ToolCtx } from "../lib/mcp/tool";
import { ToolError } from "../lib/mcp/tool";

const USER = "usr_limite";
const OWNER = "usr_proprietaire";

function row(id: string, ownerUserId = USER, createdAt = new Date().toISOString()): CourseRow {
  return {
    id,
    owner_user_id: ownerUserId,
    name: `Cours ${id}`,
    short: id,
    code: null,
    exam_name: null,
    exam_kind: null,
    university: null,
    university_lines: null,
    faculty: null,
    teachers: null,
    language: "fr",
    profile_id: null,
    duration_min: null,
    exam_date: null,
    db_file: null,
    refs_rel: null,
    exams_rel: null,
    uploads_rel: null,
    content_rel: null,
    created_at: createdAt,
  };
}

before(async () => {
  await authRun(`INSERT INTO users (id, email) VALUES (?, ?)`, OWNER, "ben@cortex.test");
});

beforeEach(async () => {
  await authRun(`DELETE FROM courses`);
  await authRun(`DELETE FROM course_creation_events`);
  process.env.MAX_COURSES_PER_USER = "20";
  process.env.MAX_COURSES_CREATED_PER_HOUR = "10";
  process.env.CORTEX_OWNER_EMAIL = "ben@cortex.test";
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const key of [
    "DB_DRIVER",
    "DATABASE_URL",
    "CORTEX_MIGRATE_LEGACY_COURSES",
    "MAX_COURSES_PER_USER",
    "MAX_COURSES_CREATED_PER_HOUR",
    "CORTEX_OWNER_EMAIL",
  ]) delete process.env[key];
});

test("refuse le cours qui dépasserait la limite du compte avec une erreur 409 claire", async () => {
  process.env.MAX_COURSES_PER_USER = "2";
  await insertCourse(row("cours-1"));
  await insertCourse(row("cours-2"));

  await assert.rejects(insertCourse(row("cours-3")), (error: unknown) => {
    assert.ok(error instanceof CourseCreationLimitError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Tu as atteint la limite de 2 cours. Supprime un cours pour en créer un nouveau.");
    return true;
  });
});

test("deux créations simultanées ne peuvent pas dépasser la dernière place", async () => {
  process.env.MAX_COURSES_PER_USER = "1";
  const results = await Promise.allSettled([
    insertCourse(row("concurrent-a")),
    insertCourse(row("concurrent-b")),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await authAll(`SELECT id FROM courses WHERE owner_user_id = ?`, USER)).length, 1);
});

test("supprimer un cours libère immédiatement une place", async () => {
  process.env.MAX_COURSES_PER_USER = "1";
  await insertCourse(row("ancien"));
  await deleteCourseRow("ancien", USER);
  await insertCourse(row("nouveau"));

  assert.deepEqual((await authAll<{ id: string }>(`SELECT id FROM courses`)).map((course) => course.id), ["nouveau"]);
});

test("le compte propriétaire n'est bloqué ni par le plafond ni par l'historique horaire", async () => {
  process.env.MAX_COURSES_PER_USER = "1";
  process.env.MAX_COURSES_CREATED_PER_HOUR = "1";
  await insertCourse(row("owner-1", OWNER));
  await insertCourse(row("owner-2", OWNER));

  assert.equal((await authAll(`SELECT id FROM courses WHERE owner_user_id = ?`, OWNER)).length, 2);
});

test("off et unlimited désactivent le plafond de cours", async () => {
  process.env.MAX_COURSES_PER_USER = "off";
  process.env.MAX_COURSES_CREATED_PER_HOUR = "off";
  await insertCourse(row("off-1"));
  await insertCourse(row("off-2"));
  process.env.MAX_COURSES_PER_USER = "unlimited";
  await insertCourse(row("off-3"));

  assert.equal((await authAll(`SELECT id FROM courses WHERE owner_user_id = ?`, USER)).length, 3);
});

test("refuse plus de créations que le débit horaire même après suppression", async () => {
  process.env.MAX_COURSES_PER_USER = "off";
  process.env.MAX_COURSES_CREATED_PER_HOUR = "2";
  await insertCourse(row("heure-1"));
  await insertCourse(row("heure-2"));
  await deleteCourseRow("heure-1", USER);
  await deleteCourseRow("heure-2", USER);

  await assert.rejects(insertCourse(row("heure-3")), (error: unknown) => {
    assert.ok(error instanceof CourseCreationLimitError);
    assert.equal(error.status, 409);
    assert.match(error.message, /2 cours par heure/);
    return true;
  });
});

test("l'API renvoie le refus en 409 avec le message affichable par le formulaire", async () => {
  process.env.MAX_COURSES_PER_USER = "0";
  const { POST } = await import("../app/api/courses/route");
  const request = new NextRequest("http://cortex.test/api/courses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cortex-user": USER },
    body: JSON.stringify({ name: "Cours refusé" }),
  });

  const response = await POST(request);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Tu as atteint la limite de 0 cours. Supprime un cours pour en créer un nouveau.",
  });
});

test("l'outil MCP transforme le refus commun en conflit lisible", async () => {
  process.env.MAX_COURSES_PER_USER = "0";
  const tool = (await import("../lib/mcp/tools/create-course")).default;
  const ctx = { principal: { userId: USER } } as unknown as ToolCtx;

  await assert.rejects(tool.run({ name: "Cours MCP" }, ctx), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "conflict");
    assert.equal(error.message, "Tu as atteint la limite de 0 cours. Supprime un cours pour en créer un nouveau.");
    return true;
  });
});
