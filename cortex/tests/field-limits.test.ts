/**
 * LOT 2b-2 — l'assistance est à PRIX FIXE (0,1 crédit) mais acceptait jusqu'à
 * 1 Mo de texte par champ : 200 000 tokens facturés au tarif d'un drill.
 * Chaque champ envoyé au modèle a un plafond strict ; au-delà → 413, sans débit.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fields-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "5";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "test";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_ASSIST_QUOTA", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "LLM_PROVIDER", "LLM_API_KEY"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (url: string, body: unknown) => new NextRequest(`http://cortex.test${url}?course=cs-202`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("les plafonds par champ sont explicites et bornés", async () => {
  const { FIELD_LIMITS } = await import("../lib/field-limits");
  assert.equal(FIELD_LIMITS.concept, 500);
  assert.equal(FIELD_LIMITS.statement, 8000);
  assert.equal(FIELD_LIMITS.answer, 8000);
  assert.equal(FIELD_LIMITS.target, 2000);
  assert.ok(FIELD_LIMITS.text <= 8000);
});

test("drill : concept trop long → 413, aucun débit", async () => {
  const { POST } = await import("../app/api/drill/route");
  const credits = await import("../lib/billing/credits");
  const before = await credits.getBalanceCenti("owner");
  const r = await POST(json("/api/drill", { concept: "x".repeat(501) }));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /500/);
  assert.equal(await credits.getBalanceCenti("owner"), before);
});

test("check-solution : énoncé ou réponse trop longs → 413 (JSON et multipart)", async () => {
  const { POST } = await import("../app/api/check-solution/route");
  assert.equal((await POST(json("/api/check-solution", { statement: "s".repeat(8001), answer: "42" }))).status, 413);
  assert.equal((await POST(json("/api/check-solution", { statement: "énoncé", answer: "a".repeat(8001) }))).status, 413);
  const form = new FormData();
  form.set("statement", "énoncé");
  form.set("answer", "a".repeat(8001));
  const encoded = new Response(form);
  const buf = Buffer.from(await encoded.arrayBuffer());
  const r = await POST(new NextRequest("http://cortex.test/api/check-solution?course=cs-202", {
    method: "POST", body: buf, headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(buf.length) },
  }));
  assert.equal(r.status, 413);
});

test("exercises/generate : cible trop longue → 413, aucun job créé", async () => {
  const { POST } = await import("../app/api/exercises/generate/route");
  const r = await POST(json("/api/exercises/generate", { target: "t".repeat(2001) }));
  assert.equal(r.status, 413);
  const { GET } = await import("../app/api/jobs/route");
  const jobs = await (await GET(new NextRequest("http://cortex.test/api/jobs?course=cs-202"))).json();
  const list = Array.isArray(jobs) ? jobs : jobs.jobs ?? [];
  assert.equal(list.length, 0);
});

test("weaknesses/mine : texte trop long → 413", async () => {
  const { POST } = await import("../app/api/weaknesses/mine/route");
  const { FIELD_LIMITS } = await import("../lib/field-limits");
  const r = await POST(json("/api/weaknesses/mine", { text: "m".repeat(FIELD_LIMITS.text + 1) }));
  assert.equal(r.status, 413);
});
