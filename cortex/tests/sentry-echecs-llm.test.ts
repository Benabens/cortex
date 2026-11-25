/**
 * SURVEILLANCE (25/11/2026) — un appel au modèle qui échoue APRÈS les relances remonte à Sentry,
 * une fois, regroupé par fournisseur et code (jamais par message). Dans un job, c'est la fin du
 * job qui le signale (job_failed / exam_incomplete, lib/jobs) : pas un second événement ici. Un
 * refus voulu (plafond, quota, crédits) n'est pas une panne. Faux fournisseur HTTP local : aucun
 * appel payant.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sentry-llm-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "1";
process.env.LLM_RETRY_BASE_MS = "1";

let calls = 0;
let server: http.Server;
type Captured = { e: unknown; tags: Record<string, string>; level?: string; fingerprint?: string[] };
const captured: Captured[] = [];

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.statusCode = 503;
      res.end("Service Unavailable : prompt d'un étudiant renvoyé tel quel");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  const { initErrorTracking } = await import("../lib/observability");
  await initErrorTracking({
    load: async () => ({
      init: () => {},
      captureException: (e: unknown, hint?: Record<string, unknown>) => {
        captured.push({ e, tags: (hint?.tags ?? {}) as Record<string, string>, level: hint?.level as string | undefined, fingerprint: hint?.fingerprint as string[] | undefined });
      },
      flush: async () => true,
    }),
  });
});
beforeEach(() => { captured.length = 0; calls = 0; });
after(async () => {
  await new Promise((r) => server.close(r));
  const { resetErrorTrackingForTests } = await import("../lib/observability");
  resetErrorTrackingForTests();
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_RETRY_BASE_MS", "LLM_BASE_URL", "SENTRY_DSN"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PROMPT = "Explique la preuve du lemme de Zorn vue au cours";

test("fournisseur en panne après les relances, hors job : UN événement llm_failed, sans le prompt", async () => {
  const { complete } = await import("../lib/llm");
  const err = await complete({ prompt: PROMPT }).then(() => null, (e: unknown) => e);
  assert.ok(err, "l'appel échoue (comportement inchangé)");
  assert.equal(calls, 2, "relance faite avant d'abandonner");
  assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
  const [c] = captured;
  assert.equal(c.level, "warning");
  assert.equal(c.tags.failure, "llm_failed");
  assert.equal(c.tags.provider, "openai-compatible");
  assert.ok(c.tags.error_code && c.tags.error_code !== "none", JSON.stringify(c.tags));
  assert.deepEqual(c.fingerprint, ["cortex", "llm_failed", "-", c.tags.error_code]);
  assert.ok(!JSON.stringify(c).includes("Zorn"), "le prompt ne part pas chez Sentry");
  // La route qui relève ensuite la même exception (onRequestError, outil MCP) ne la renvoie pas.
  const { captureError } = await import("../lib/observability");
  captureError(err);
  assert.equal(captured.length, 1, "même exception : un seul événement");
});

test("dans un job : aucun événement ici, c'est la fin du job qui le signale", async () => {
  const { complete } = await import("../lib/llm");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  setCurrentJob(7, "qcm");
  try {
    await complete({ prompt: PROMPT }).catch(() => null);
  } finally {
    clearCurrentJob();
  }
  assert.equal(captured.length, 0, JSON.stringify(captured.map((c) => c.tags)));
});

test("appel annulé (l'étudiant est parti) : pas une panne, aucun événement", async () => {
  const { complete } = await import("../lib/llm");
  const ac = new AbortController();
  ac.abort();
  await complete({ prompt: PROMPT, signal: ac.signal }).catch(() => null);
  assert.equal(captured.length, 0, JSON.stringify(captured.map((c) => c.tags)));
});
