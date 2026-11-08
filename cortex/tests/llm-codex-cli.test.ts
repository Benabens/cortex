import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { codexCliProvider } from "../lib/llm/providers/codex-cli";
import { LlmError } from "../lib/llm/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fake-codex-"));
const fakeBin = path.join(tmp, "codex");
const capture = path.join(tmp, "capture.json");

function installFakeBin(body: string): void {
  fs.writeFileSync(fakeBin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.CORTEX_CODEX_BIN = fakeBin;
}

afterEach(() => {
  for (const key of ["CORTEX_CODEX_BIN", "CORTEX_CODEX_MODEL", "LLM_MODEL_OPUS", "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LLM_API_KEY", "RAILWAY_ENVIRONMENT"]) delete process.env[key];
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  fs.rmSync(capture, { force: true });
  fs.rmSync(`${capture}.args`, { force: true });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("provider codex-cli : exécution isolée, modèle/effort, usage et clés retirées", async () => {
  installFakeBin([
    `stdin=$(cat)`,
    `out=""; prev=""; for arg in "$@"; do [ "$prev" = "-o" ] && out="$arg"; prev="$arg"; done`,
    `STDIN="$stdin" node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),stdin:process.env.STDIN,cwd:process.cwd(),files:fs.readdirSync("."),leaks:Object.keys(process.env).filter(k=>/API_KEY$|ANTHROPIC_AUTH_TOKEN/.test(k))}))' "${capture}" "$@"`,
    `printf '%s' 'réponse finale' > "$out"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":42,"cached_input_tokens":10,"output_tokens":7}}'`,
  ].join("\n"));
  process.env.OPENAI_API_KEY = "secret";
  process.env.CODEX_API_KEY = "secret";
  process.env.ANTHROPIC_API_KEY = "secret";
  process.env.ANTHROPIC_AUTH_TOKEN = "secret";
  process.env.LLM_API_KEY = "secret";
  process.env.LLM_MODEL_OPUS = "sonnet";

  const res = await codexCliProvider.complete({ prompt: "question", system: "système", model: "opus" });
  assert.deepEqual(res, { text: "réponse finale", usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 10 }, provider: "codex-cli", model: "gpt-5.6-sol" });
  const got = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual(got.args, ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", got.args[5], "--json", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"high\"", "-"]);
  assert.equal(got.stdin, "système\n\nquestion");
  assert.equal(got.leaks.length, 0);
  assert.deepEqual(got.files, []);
  assert.match(got.cwd, /cortex-codex-cli-/);
});

test("provider codex-cli : schéma structuré et image par chemin", async () => {
  const image = path.join(tmp, "figure.png");
  fs.writeFileSync(image, "x");
  installFakeBin([
    `cat >/dev/null`,
    `out=""; schema=""; prev=""; for arg in "$@"; do [ "$prev" = "-o" ] && out="$arg"; [ "$prev" = "--output-schema" ] && schema="$arg"; prev="$arg"; done`,
    `cp "$schema" "${capture}"`,
    `printf '%s\\036' "$@" > "${capture}.args"`,
    `printf '{}' > "$out"`,
  ].join("\n"));
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const res = await codexCliProvider.complete({ prompt: "p", model: "haiku", json: { schema }, images: [{ path: image }] });
  assert.equal(res.text, "{}");
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), schema);
  const args = fs.readFileSync(`${capture}.args`, "utf8").split("\u001e").filter(Boolean);
  assert.ok(args.includes("--output-schema") && args.includes("-i") && args.includes(image));
  assert.ok(args.includes('model_reasoning_effort="low"'));
});

test("provider codex-cli : image base64 non supportée", async () => {
  installFakeBin("exit 0");
  await assert.rejects(codexCliProvider.complete({ prompt: "p", images: [{ mediaType: "image/png", base64: "AAAA" }] }), (e: unknown) => e instanceof LlmError && e.code === "UNSUPPORTED");
});

test("provider codex-cli : timeout et annulation", async () => {
  installFakeBin("cat >/dev/null; sleep 5");
  await assert.rejects(codexCliProvider.complete({ prompt: "p", timeoutMs: 100 }), (e: unknown) => e instanceof LlmError && e.code === "TIMEOUT");
  const ctl = new AbortController();
  const call = codexCliProvider.complete({ prompt: "p", signal: ctl.signal });
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(call, (e: unknown) => e instanceof LlmError && e.code === "ABORTED");
});

test("provider codex-cli : binaire absent et interdiction production", async () => {
  process.env.CORTEX_CODEX_BIN = path.join(tmp, "absent");
  assert.equal(codexCliProvider.available(), false);
  await assert.rejects(codexCliProvider.complete({ prompt: "p" }), (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE");
  installFakeBin("exit 0");
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  assert.equal(codexCliProvider.available(), false);
  await assert.rejects(codexCliProvider.complete({ prompt: "p" }), (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE" && /production/.test(e.message));
});

test("provider codex-cli : conserve l'erreur JSONL quand stderr est vide", async () => {
  installFakeBin(`cat >/dev/null; printf '%s\n' '{"type":"error","message":"schéma refusé"}'; exit 1`);
  await assert.rejects(
    codexCliProvider.complete({ prompt: "p" }),
    (e: unknown) => e instanceof LlmError && /schéma refusé/.test(e.message),
  );
});
