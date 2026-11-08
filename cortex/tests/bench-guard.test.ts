/**
 * Garde du banc : il ne tourne que sur l'abonnement Codex (provider codex-cli, aucune clé
 * API dans l'environnement) et sur une base locale jetable — jamais l'API payante, jamais la prod.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBenchEnv } from "../lib/bench/guard";

const ok = { LLM_PROVIDER: "codex-cli", CORTEX_DATA_DIR: "/tmp/banc", DB_DRIVER: "postgres", DATABASE_URL: "postgres://cortex@127.0.0.1:55433/banc" };

test("environnement du banc conforme : accepté", () => {
  assert.doesNotThrow(() => assertBenchEnv(ok));
  assert.doesNotThrow(() => assertBenchEnv({ ...ok, DATABASE_URL: "postgres://cortex@localhost:5432/banc" }));
});

test("tout provider autre que codex-cli, ou non posé : refusé", () => {
  for (const provider of ["claude-code", "anthropic", "openai-compatible", undefined]) {
    assert.throws(() => assertBenchEnv({ ...ok, LLM_PROVIDER: provider }), /LLM_PROVIDER=codex-cli/);
  }
});

test("une clé API chargée dans l'environnement : refusé, même vide de sens pour codex-cli", () => {
  for (const k of ["ANTHROPIC_API_KEY", "LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
    assert.throws(() => assertBenchEnv({ ...ok, [k]: "sk-xxx" }), new RegExp(k));
  }
  assert.doesNotThrow(() => assertBenchEnv({ ...ok, ANTHROPIC_API_KEY: "" }), "une variable vide n'est pas une clé");
});

test("base distante ou dossier de données absent : refusé", () => {
  assert.throws(() => assertBenchEnv({ ...ok, DATABASE_URL: "postgres://u:p@db.railway.internal:5432/railway" }), /locale/);
  assert.throws(() => assertBenchEnv({ ...ok, DATABASE_URL: undefined }), /DATABASE_URL/);
  assert.throws(() => assertBenchEnv({ ...ok, CORTEX_DATA_DIR: undefined }), /CORTEX_DATA_DIR/);
});
