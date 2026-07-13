import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * Cache LLM par hash de contenu + métriques (Phase E). Le provider claude-code
 * est simulé par un FAUX binaire `claude` qui COMPTE ses invocations → on prouve
 * que le 2ᵉ appel identique NE relance PAS le modèle (hit), et que les compteurs
 * de métriques reflètent calls/tokens/cache.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-cache-"));
const realCwd = process.cwd();
const callCounter = path.join(tmp, "calls.txt");
const fakeBin = path.join(tmp, "claude");

let complete: typeof import("../lib/llm").complete;
let snapshot: typeof import("../lib/metrics").snapshot;
let cacheKey: typeof import("../lib/llm/cache").cacheKey;

const ready = (async () => {
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh\nprintf x >> "${callCounter}"\nprintf '%s' '{"result":"réponse déterministe","usage":{"input_tokens":10,"output_tokens":5}}'\n`,
    { mode: 0o755 }
  );
  process.env.CORTEX_CLAUDE_BIN = fakeBin;
  process.env.CACHE_ENABLED = "1";
  process.chdir(tmp); // DB du cache dans un data/ jetable
  ({ complete } = await import("../lib/llm"));
  ({ snapshot } = await import("../lib/metrics"));
  ({ cacheKey } = await import("../lib/llm/cache"));
})();

before(() => ready);

after(() => {
  process.chdir(realCwd);
  delete process.env.CORTEX_CLAUDE_BIN;
  delete process.env.CACHE_ENABLED;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const calls = () => (fs.existsSync(callCounter) ? fs.readFileSync(callCounter, "utf8").length : 0);

test("cache : 2ᵉ appel identique = HIT (0 invocation du modèle)", async () => {
  const req = { prompt: "Question stable pour le cache", model: "opus" as const };
  const r1 = await complete(req);
  assert.equal(r1.text, "réponse déterministe");
  assert.equal(calls(), 1, "1er appel doit invoquer le binaire");

  const r2 = await complete(req);
  assert.equal(r2.text, "réponse déterministe");
  assert.equal(calls(), 1, "2e appel identique NE doit PAS réinvoquer (hit)");

  // un prompt différent = clé différente = nouvel appel
  await complete({ prompt: "Autre question", model: "opus" });
  assert.equal(calls(), 2);
});

test("cacheKey : stable pour une requête identique, différent sinon", () => {
  const a = cacheKey("claude-code", { prompt: "p", model: "opus" });
  const b = cacheKey("claude-code", { prompt: "p", model: "opus" });
  const c = cacheKey("claude-code", { prompt: "p", model: "sonnet" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("métriques : compteurs calls / tokens / cache alimentés", () => {
  const snap = snapshot();
  const calls = snap.counters["cortex_llm_calls_total"] ?? [];
  assert.ok(calls.some((r) => r.labels.includes("provider=claude-code") && r.value >= 1));
  const tokens = snap.counters["cortex_llm_output_tokens_total"] ?? [];
  assert.ok(tokens.some((r) => r.value >= 5));
  const cache = snap.counters["cortex_llm_cache_total"] ?? [];
  assert.ok(cache.some((r) => r.labels.includes("result=hit")));
  const dur = snap.histograms["cortex_llm_duration_ms"] ?? [];
  assert.ok(dur.length >= 1 && dur[0].count >= 1);
});
