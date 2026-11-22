/**
 * INTÉGRATION LOOPS (lib/loops.ts) : contact + événements marketing. Seams testés :
 * les 3 fonctions publiques (`loopsConfigured`, `upsertLoopsContact`, `trackLoopsEvent`),
 * observées via `fetch` mocké et les lignes de log JSON — jamais la base ni les routes
 * appelantes. Comportement attendu : silencieux (log, pas d'exception, pas d'appel réseau)
 * sans LOOPS_API_KEY ; requête correcte avec ; jamais d'exception même si Loops répond mal
 * ou que le réseau tombe (ne doit jamais casser l'inscription ou la création d'un cours).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** Lignes de log JSON émises pendant `fn` (même convention que lib/metrics.ts). */
async function logsDuring(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const lines: string[] = [];
  console.log = console.error = console.warn = (s: unknown) => { lines.push(String(s)); };
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((o): o is Record<string, unknown> => !!o);
}

test("loopsConfigured : reflète la seule présence de LOOPS_API_KEY", async () => {
  delete process.env.LOOPS_API_KEY;
  const { loopsConfigured } = await import("../lib/loops");
  assert.equal(loopsConfigured(), false);
  process.env.LOOPS_API_KEY = "test_key";
  assert.equal(loopsConfigured(), true);
  delete process.env.LOOPS_API_KEY;
});

test("upsertLoopsContact : sans clé, aucun appel réseau, un log et jamais d'exception", async (t) => {
  delete process.env.LOOPS_API_KEY;
  const { upsertLoopsContact } = await import("../lib/loops");
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return new Response("{}", { status: 200 }); });
  const logs = await logsDuring(() => upsertLoopsContact({ email: "a@b.test", firstName: "Ana" }));
  assert.equal(called, false);
  assert.ok(logs.some((l) => l.evt === "loops.contact.skipped"));
});

test("upsertLoopsContact : avec clé, envoie le contact à Loops avec les bons champs", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { upsertLoopsContact } = await import("../lib/loops");
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  await upsertLoopsContact({ email: "a@b.test", firstName: "Ana", language: "fr", userId: "u1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /app\.loops\.so\/api\/v1\/contacts\/update/);
  assert.equal(calls[0].headers.authorization, "Bearer test_key");
  assert.equal(calls[0].body.email, "a@b.test");
  assert.equal(calls[0].body.firstName, "Ana");
  assert.equal(calls[0].body.language, "fr");
  assert.equal(calls[0].body.userId, "u1");
  delete process.env.LOOPS_API_KEY;
});

test("upsertLoopsContact : une panne réseau ne lève jamais, juste un log", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { upsertLoopsContact } = await import("../lib/loops");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
  const logs = await logsDuring(() => upsertLoopsContact({ email: "a@b.test" }));
  assert.ok(logs.some((l) => l.evt === "loops.contact.error"));
  delete process.env.LOOPS_API_KEY;
});

test("trackLoopsEvent : sans clé, aucun appel réseau, un log", async (t) => {
  delete process.env.LOOPS_API_KEY;
  const { trackLoopsEvent } = await import("../lib/loops");
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return new Response("{}", { status: 200 }); });
  const logs = await logsDuring(() => trackLoopsEvent({ email: "a@b.test" }, "signup"));
  assert.equal(called, false);
  assert.ok(logs.some((l) => l.evt === "loops.event.skipped" && l.eventName === "signup"));
});

test("trackLoopsEvent : avec clé et un e-mail, envoie l'événement avec ses propriétés", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { trackLoopsEvent } = await import("../lib/loops");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  await trackLoopsEvent({ email: "a@b.test" }, "course_created", { courseId: "c1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /app\.loops\.so\/api\/v1\/events\/send/);
  assert.equal(calls[0].body.email, "a@b.test");
  assert.equal(calls[0].body.eventName, "course_created");
  assert.deepEqual(calls[0].body.eventProperties, { courseId: "c1" });
  delete process.env.LOOPS_API_KEY;
});

test("trackLoopsEvent : identifié par userId seul (pas d'e-mail en main dans la route), ça part aussi", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { trackLoopsEvent } = await import("../lib/loops");
  const calls: Array<{ body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  await trackLoopsEvent({ userId: "u1" }, "mcp_connected");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.userId, "u1");
  assert.equal(calls[0].body.email, undefined);
  delete process.env.LOOPS_API_KEY;
});

test("trackLoopsEvent : ni e-mail ni userId → no-op (rien à identifier chez Loops)", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { trackLoopsEvent } = await import("../lib/loops");
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return new Response("{}", { status: 200 }); });
  const logs = await logsDuring(() => trackLoopsEvent({}, "signup"));
  assert.equal(called, false);
  assert.ok(logs.some((l) => l.evt === "loops.event.skipped"));
  delete process.env.LOOPS_API_KEY;
});

test("trackLoopsEvent : une réponse HTTP d'échec ne lève jamais, juste un log", async (t) => {
  process.env.LOOPS_API_KEY = "test_key";
  const { trackLoopsEvent } = await import("../lib/loops");
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 500 }));
  const logs = await logsDuring(() => trackLoopsEvent({ email: "a@b.test" }, "purchase"));
  assert.ok(logs.some((l) => l.evt === "loops.event.failed" && l.status === 500));
  delete process.env.LOOPS_API_KEY;
});
