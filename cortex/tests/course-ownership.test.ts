import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * PROPRIÉTÉ DU COURS SUR TOUTES LES ROUTES (B2 + I2) — Postgres réel
 * in-process (PGlite). Un compte B qui vise le cours d'un compte A via
 * `?course=` doit recevoir 404 sur CHAQUE route, avant toute requête au
 * tenant : aucun schéma `t_<B>_<cours>` ne doit apparaître, aucune ligne dans
 * le registre public.tenants. Le mode dev sans auth (user « owner », cours
 * historiques) continue de fonctionner.
 */

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.CORTEX_SANDBOX = "none";

import { NextRequest } from "next/server";
import { authAll } from "../db/auth-store";
import { insertCourse } from "../db/courses-store";
import { userSlug } from "../db/context";
import { pglitePublicQuery } from "../db/driver-postgres";
import { buildCourseRow } from "../lib/course-create";
import { ensureCoursesLoaded, reloadCourses, resetCoursesCache } from "../lib/courses";

const A = "usr_alice_a1b2";
const B = "usr_bob_c3d4";
let courseA = "";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteCase = { name: string; load: () => Promise<Record<string, unknown>>; method: string; params?: Record<string, string> };

/** Routes qui installaient le contexte SANS vérifier la propriété (audit B2). */
const ROUTES: RouteCase[] = [
  { name: "POST refs/upload", load: () => import("../app/api/refs/upload/route"), method: "POST" },
  { name: "POST exams/generate", load: () => import("../app/api/exams/generate/route"), method: "POST" },
  { name: "GET jobs", load: () => import("../app/api/jobs/route"), method: "GET" },
  { name: "GET jobs/[id]", load: () => import("../app/api/jobs/[id]/route"), method: "GET", params: { id: "1" } },
  { name: "POST jobs/[id]", load: () => import("../app/api/jobs/[id]/route"), method: "POST", params: { id: "1" } },
  { name: "POST jobs/[id]/cancel", load: () => import("../app/api/jobs/[id]/cancel/route"), method: "POST", params: { id: "1" } },
  { name: "POST jobs/[id]/retry", load: () => import("../app/api/jobs/[id]/retry/route"), method: "POST", params: { id: "1" } },
  { name: "GET qcm/generate", load: () => import("../app/api/qcm/generate/route"), method: "GET" },
  { name: "POST qcm/generate", load: () => import("../app/api/qcm/generate/route"), method: "POST" },
  { name: "GET qcm/[id]", load: () => import("../app/api/qcm/[id]/route"), method: "GET", params: { id: "1" } },
  { name: "POST qcm/[id]/grade", load: () => import("../app/api/qcm/[id]/grade/route"), method: "POST", params: { id: "1" } },
  { name: "GET drill", load: () => import("../app/api/drill/route"), method: "GET" },
  { name: "POST drill", load: () => import("../app/api/drill/route"), method: "POST" },
  { name: "POST check-solution", load: () => import("../app/api/check-solution/route"), method: "POST" },
  { name: "POST weaknesses/mine", load: () => import("../app/api/weaknesses/mine/route"), method: "POST" },
  { name: "POST weaknesses/analyze", load: () => import("../app/api/weaknesses/analyze/route"), method: "POST" },
  { name: "POST weaknesses/process", load: () => import("../app/api/weaknesses/process/route"), method: "POST" },
  { name: "GET program/analyze", load: () => import("../app/api/program/analyze/route"), method: "GET" },
  { name: "POST program/analyze", load: () => import("../app/api/program/analyze/route"), method: "POST" },
  { name: "POST program/score", load: () => import("../app/api/program/score/route"), method: "POST" },
  { name: "POST program/train", load: () => import("../app/api/program/train/route"), method: "POST" },
  { name: "GET program/exercises", load: () => import("../app/api/program/exercises/route"), method: "GET" },
  { name: "POST prepare", load: () => import("../app/api/prepare/route"), method: "POST" },
  { name: "GET labs/generate", load: () => import("../app/api/labs/generate/route"), method: "GET" },
  { name: "POST labs/generate", load: () => import("../app/api/labs/generate/route"), method: "POST" },
  { name: "GET compose", load: () => import("../app/api/compose/route"), method: "GET" },
  { name: "GET feedback", load: () => import("../app/api/feedback/route"), method: "GET" },
  { name: "POST feedback", load: () => import("../app/api/feedback/route"), method: "POST" },
  { name: "POST exercises/generate", load: () => import("../app/api/exercises/generate/route"), method: "POST" },
  { name: "POST sources/import", load: () => import("../app/api/sources/import/route"), method: "POST" },
  // Déjà gardées avant le lot — on verrouille pour ne pas régresser.
  { name: "GET sources", load: () => import("../app/api/sources/route"), method: "GET" },
  { name: "GET exams", load: () => import("../app/api/exams/route"), method: "GET" },
  { name: "GET dashboard", load: () => import("../app/api/dashboard/route"), method: "GET" },
  { name: "GET weaknesses", load: () => import("../app/api/weaknesses/route"), method: "GET" },
  { name: "GET program", load: () => import("../app/api/program/route"), method: "GET" },
  { name: "GET revision", load: () => import("../app/api/revision/route"), method: "GET" },
  { name: "GET search", load: () => import("../app/api/search/route"), method: "GET" },
];

function request(user: string | null, course: string, method: string): NextRequest {
  const headers = new Headers();
  if (user) headers.set("x-cortex-user", user);
  let body: string | undefined;
  if (method === "POST") {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ concept: "x", topicId: 1, answers: {}, verdict: "good", path: "x", target: "x" });
  }
  return new NextRequest(`http://cortex.test/api/x?course=${encodeURIComponent(course)}&q=inode&topic=1`, { method, headers, body });
}

async function call(rc: RouteCase, user: string | null, course: string): Promise<Response> {
  const mod = await rc.load();
  const h = mod[rc.method] as Handler;
  assert.equal(typeof h, "function", `${rc.name} : handler ${rc.method} absent`);
  // Une route qui laisse passer B peut lancer un job ou un appel LLM et ne
  // jamais répondre : un délai borné la compte comme fuite au lieu de bloquer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve(new Response("délai dépassé (la route a commencé à travailler)", { status: 599 })), 15_000);
  });
  try {
    return await Promise.race([h(request(user, course, rc.method), { params: Promise.resolve(rc.params ?? {}) }), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function tenantSchemas(): Promise<string[]> {
  const rows = await pglitePublicQuery(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't\\_%' ORDER BY 1`, []
  );
  return rows.map((r) => String((r as { schema_name: string }).schema_name));
}

before(async () => {
  delete process.env.CORTEX_USER;
  resetCoursesCache();
  await ensureCoursesLoaded(); // migre le catalogue historique vers « owner »
  const row = buildCourseRow({ name: "Analyse III", code: "MATH-203" }, A);
  await insertCourse(row);
  await reloadCourses();
  courseA = row.id;
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
  delete process.env.CORTEX_SANDBOX;
  resetCoursesCache();
});

test("B2 — un compte B obtient 404 sur CHAQUE route avec le cours de A", async () => {
  const failures: string[] = [];
  for (const rc of ROUTES) {
    const res = await call(rc, B, courseA);
    const body = await res.text();
    // Le statut seul ne suffit pas (« job introuvable » est aussi un 404) : c'est
    // le message de la garde qui prouve que la route n'a pas travaillé.
    if (res.status !== 404 || !body.includes("Cours inconnu")) failures.push(`${rc.name} → ${res.status} ${body.slice(0, 60)}`);
  }
  assert.deepEqual(failures, [], `routes qui laissent passer B :\n  ${failures.join("\n  ")}`);
});

test("B2 — un cours inexistant répond 404 aussi (pas de repli sur cs-202)", async () => {
  const res = await call(ROUTES[2], A, "cours-fantome");
  assert.equal(res.status, 404);
});

test("I2 — aucun schéma ni tenant n'a été créé pour B", async () => {
  const slugB = userSlug(B);
  const schemas = await tenantSchemas();
  assert.deepEqual(schemas.filter((s) => s.includes(slugB)), [], `schémas créés pour B : ${schemas.join(", ")}`);
  const reg = await authAll<{ user_id: string }>(`SELECT user_id FROM tenants WHERE user_id = ?`, B);
  assert.equal(reg.length, 0, "B enregistré dans public.tenants");
});

test("B2 — le propriétaire A passe (le tenant est créé pour lui, et pour lui seul)", async () => {
  const res = await call(ROUTES[2], A, courseA); // GET jobs
  assert.equal(res.status, 200, await res.text());
  const schemas = await tenantSchemas();
  assert.ok(schemas.some((s) => s.includes(userSlug(A))), `tenant de A absent : ${schemas.join(", ")}`);
});

test("B2 — mode dev sans auth : « owner » accède aux cours historiques", async () => {
  for (const c of ["cs-202", "ml", "algo"]) {
    const res = await call(ROUTES[2], null, c); // pas de header → owner
    assert.equal(res.status, 200, `${c} : ${res.status} ${await res.text()}`);
  }
});

test("B2 — les routes de facturation ne dépendent pas d'un cours (compte neuf sans matière)", async () => {
  const mod = await import("../app/api/billing/route");
  const res = await mod.GET(request(B, "", "GET"));
  assert.equal(res.status, 200, await res.text());
});
