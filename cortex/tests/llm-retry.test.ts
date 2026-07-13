import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelayMs, isRetryable, withRetry } from "../lib/llm/retry";
import { LlmError } from "../lib/llm/types";

test("withRetry : succès immédiat → un seul essai", async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return "ok"; }, { retries: 3 });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("withRetry : erreur retryable → réessaie puis réussit", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new LlmError("rate limited", "RATE_LIMIT", true);
      return "ok";
    },
    { retries: 3, baseMs: 1, maxMs: 2 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("withRetry : erreur NON retryable → remonte immédiatement (contrat des fallbacks)", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new LlmError("sortie illisible"); }, { retries: 3, baseMs: 1 }),
    (e: unknown) => e instanceof LlmError && e.message === "sortie illisible"
  );
  assert.equal(calls, 1);
});

test("withRetry : retries=0 → un seul essai même si retryable (défaut claude-code)", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new LlmError("overloaded", "OVERLOADED", true); }, { retries: 0 })
  );
  assert.equal(calls, 1);
});

test("withRetry : budget épuisé → remonte la dernière erreur", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new LlmError("boom", undefined, true); }, { retries: 2, baseMs: 1, maxMs: 2 }),
    (e: unknown) => e instanceof LlmError && e.message === "boom"
  );
  assert.equal(calls, 3);
});

test("withRetry : signal déjà annulé → ABORTED sans appel", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; return "x"; }, { retries: 0, signal: ctl.signal }),
    (e: unknown) => e instanceof LlmError && e.code === "ABORTED"
  );
  assert.equal(calls, 0);
});

test("backoffDelayMs : exponentiel, plafonné, jitter borné [cap/2, cap]", () => {
  assert.equal(backoffDelayMs(0, 500, 15_000, () => 0), 250);
  assert.equal(backoffDelayMs(0, 500, 15_000, () => 1), 500);
  assert.equal(backoffDelayMs(2, 500, 15_000, () => 1), 2000);
  assert.equal(backoffDelayMs(10, 500, 15_000, () => 1), 15_000); // plafond
});

test("isRetryable : seul LlmError.retryable=true est retryable", () => {
  assert.equal(isRetryable(new LlmError("x", "RATE_LIMIT", true)), true);
  assert.equal(isRetryable(new LlmError("x", "TIMEOUT")), false);
  assert.equal(isRetryable(new Error("x")), false);
});
