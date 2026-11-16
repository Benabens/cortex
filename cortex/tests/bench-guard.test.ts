/**
 * Garde du banc : il ne tourne que sur l'abonnement Codex (provider codex-cli, aucune clé
 * API dans l'environnement) et sur une base locale jetable — jamais l'API payante, jamais la prod.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBenchEnv, judgeEnv } from "../lib/bench/guard";

const ok = { LLM_PROVIDER: "codex-cli", CORTEX_DATA_DIR: "/tmp/banc", DB_DRIVER: "postgres", DATABASE_URL: "postgres://cortex@127.0.0.1:55433/banc" };

test("environnement du banc conforme : accepté", () => {
  assert.doesNotThrow(() => assertBenchEnv(ok));
  assert.doesNotThrow(() => assertBenchEnv({ ...ok, DATABASE_URL: "postgres://cortex@localhost:5432/banc" }));
});

test("tout provider autre que codex-cli ou claude-code, ou non posé : refusé", () => {
  for (const provider of ["anthropic", "openai-compatible", undefined]) {
    assert.throws(() => assertBenchEnv({ ...ok, LLM_PROVIDER: provider }), /LLM_PROVIDER=codex-cli/);
  }
});

test("moteur sur claude-code (abonnement Max, sans clé) : accepté, et le juge reste sur codex-cli", () => {
  // Boucle moteur du 15/11 : Ben mesure le coût sur claude-code (tokens réels, réflexion comprise,
  // convertis au tarif API) ; le juge existant tourne toujours sur l'abonnement Codex.
  const cc = { ...ok, LLM_PROVIDER: "claude-code" };
  assert.doesNotThrow(() => assertBenchEnv(cc));
  assert.throws(() => assertBenchEnv({ ...cc, ANTHROPIC_API_KEY: "sk-ant-xxx" }), /ANTHROPIC_API_KEY/);
  const env = judgeEnv(cc);
  assert.equal(env.LLM_PROVIDER, "codex-cli");
  assert.doesNotThrow(() => assertBenchEnv(env, { judge: true }));
});

test("une clé API chargée dans l'environnement : refusé, même vide de sens pour codex-cli", () => {
  for (const k of ["ANTHROPIC_API_KEY", "LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
    assert.throws(() => assertBenchEnv({ ...ok, [k]: "sk-xxx" }), new RegExp(k));
  }
  assert.doesNotThrow(() => assertBenchEnv({ ...ok, ANTHROPIC_API_KEY: "" }), "une variable vide n'est pas une clé");
});

test("mesure réelle sur l'API : seulement sur opt-in explicite, avec un plafond de dépense par run", () => {
  // Chantier coût du 15/11 : Ben autorise des runs réels limités (15 $ au total). Sans opt-in,
  // la règle du 04/11 tient ; avec, seule la clé Anthropic passe, plafonnée par SPEND_CAP_USD
  // (kill-switch de lib/billing/usage, compté sur la base jetable du run).
  const paid = { ...ok, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-xxx", CORTEX_BENCH_PAID: "anthropic", SPEND_CAP_USD: "4" };
  assert.doesNotThrow(() => assertBenchEnv(paid));
  assert.throws(() => assertBenchEnv({ ...paid, CORTEX_BENCH_PAID: undefined }), /LLM_PROVIDER=codex-cli/);
  for (const cap of [undefined, "", "0", "abc", "16"]) {
    assert.throws(() => assertBenchEnv({ ...paid, SPEND_CAP_USD: cap }), /SPEND_CAP_USD/, `plafond ${cap}`);
  }
  assert.throws(() => assertBenchEnv({ ...paid, LLM_PROVIDER: "openai-compatible" }), /anthropic/);
  assert.throws(() => assertBenchEnv({ ...paid, OPENAI_API_KEY: "sk-xxx" }), /OPENAI_API_KEY/);
  assert.throws(() => assertBenchEnv({ ...paid, DATABASE_URL: "postgres://u:p@db.railway.internal:5432/railway" }), /locale/);
});

test("le juge ne tourne jamais sur l'API : environnement payant refusé, et l'environnement du juge retire la clé", () => {
  // Relecture du 15/11 : un « judge --run » lancé à part, l'environnement payant encore exporté,
  // passait la garde et jugeait sur l'API.
  const paid = { ...ok, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-xxx", LLM_API_KEY: "sk-ant-yyy", CORTEX_BENCH_PAID: "anthropic", SPEND_CAP_USD: "4" };
  assert.throws(() => assertBenchEnv(paid, { judge: true }), /juge/);
  const env = judgeEnv(paid);
  assert.doesNotThrow(() => assertBenchEnv(env, { judge: true }));
  assert.deepEqual([env.LLM_PROVIDER, env.ANTHROPIC_API_KEY, env.LLM_API_KEY, env.CORTEX_BENCH_PAID, env.SPEND_CAP_USD], ["codex-cli", undefined, undefined, undefined, undefined]);
  assert.deepEqual(judgeEnv(ok), ok, "hors mesure payante : rien ne change");
});

test("base distante ou dossier de données absent : refusé", () => {
  assert.throws(() => assertBenchEnv({ ...ok, DATABASE_URL: "postgres://u:p@db.railway.internal:5432/railway" }), /locale/);
  assert.throws(() => assertBenchEnv({ ...ok, DATABASE_URL: undefined }), /DATABASE_URL/);
  assert.throws(() => assertBenchEnv({ ...ok, CORTEX_DATA_DIR: undefined }), /CORTEX_DATA_DIR/);
});
