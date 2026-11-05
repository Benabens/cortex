import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { claudeCodeProvider } from "../lib/llm/providers/claude-code";
import { LlmError } from "../lib/llm/types";

/** Aucun vrai CLI n'est appelé : chaque test impose ce faux binaire. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fake-codex-"));
const fakeBin = path.join(tmp, "codex");
const argsFile = path.join(tmp, "args.txt");
const promptFile = path.join(tmp, "prompt.txt");
const schemaCopy = path.join(tmp, "schema.json");
const invokedFile = path.join(tmp, "invoked");
const env = process.env as Record<string, string | undefined>;

function installFakeBin(body: string) {
  fs.writeFileSync(fakeBin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.CORTEX_CODEX_BIN = fakeBin;
}

beforeEach(() => {
  process.env.CORTEX_LLM_BACKEND = "codex";
  delete env.NODE_ENV;
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
  delete process.env.CORTEX_CODEX_MODEL;
  for (const file of [argsFile, promptFile, schemaCopy, invokedFile]) fs.rmSync(file, { force: true });
});

after(() => {
  for (const key of ["CORTEX_LLM_BACKEND", "CORTEX_CODEX_BIN", "CORTEX_CODEX_MODEL", "NODE_ENV", "DB_DRIVER", "DATABASE_URL"]) delete process.env[key];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("backend codex : prompt sur stdin, JSONL, texte final, schéma et arguments headless", async () => {
  installFakeBin([
    `: > "${argsFile}"`,
    `for a in "$@"; do printf '%s\\036' "$a" >> "${argsFile}"; done`,
    `cat > "${promptFile}"`,
    `answer=""; schema=""; previous=""`,
    `for a in "$@"; do [ "$previous" = "--output-last-message" ] && answer="$a"; [ "$previous" = "--output-schema" ] && schema="$a"; previous="$a"; done`,
    `[ -n "$schema" ] && cp "$schema" "${schemaCopy}"`,
    `printf '%s\\n' '{"type":"thread.started","thread_id":"fake"}'`,
    `printf '%s' '{"items":[{"ok":true}]}' > "$answer"`,
  ].join("\n"));
  process.env.CORTEX_CODEX_MODEL = "gpt-test";

  const schema = { type: "object", properties: { items: { type: "array" } }, required: ["items"] };
  const res = await claudeCodeProvider.complete({
    prompt: "Question\x00avec contrôle",
    model: "opus",
    addDirs: ["/tmp/cours"],
    json: { schema },
    timeoutMs: 10_000,
  });

  assert.equal(res.text, '{"items":[{"ok":true}]}');
  assert.equal(res.provider, "claude-code");
  assert.equal(fs.readFileSync(promptFile, "utf8"), "Question avec contrôle");
  assert.deepEqual(JSON.parse(fs.readFileSync(schemaCopy, "utf8")), schema);
  const argv = fs.readFileSync(argsFile, "utf8").split("\x1e").filter(Boolean);
  assert.deepEqual(argv.filter((a) => !a.includes("cortex-codex-") || (!a.endsWith("answer.txt") && !a.endsWith("schema.json"))), [
    "exec", "--json", "--sandbox", "read-only",
    "--output-last-message", "--output-schema", "--model", "gpt-test", "--add-dir", "/tmp/cours", "-",
  ]);
});

test("backend codex : sans schéma, le texte final libre garde le contrat RunResult", async () => {
  installFakeBin([
    `cat > "${promptFile}"`,
    `answer=""; previous=""`,
    `for a in "$@"; do [ "$previous" = "--output-last-message" ] && answer="$a"; previous="$a"; done`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}'`,
    `printf '%s' 'réponse finale' > "$answer"`,
  ].join("\n"));
  const res = await claudeCodeProvider.complete({ prompt: "ping" });
  assert.equal(res.text, "réponse finale");
});

test("backend codex : timeout du faux binaire → TIMEOUT", async () => {
  installFakeBin(`cat >/dev/null\nsleep 5`);
  await assert.rejects(
    claudeCodeProvider.complete({ prompt: "ping", timeoutMs: 150 }),
    (e: unknown) => e instanceof LlmError && e.code === "TIMEOUT"
  );
});

test("backend codex : production et bases non locales sont refusées avant le spawn", async () => {
  installFakeBin(`touch "${invokedFile}"\nexit 0`);
  env.NODE_ENV = "production";
  await assert.rejects(claudeCodeProvider.complete({ prompt: "ping" }), /refusé en production/i);
  delete env.NODE_ENV;
  process.env.DB_DRIVER = "postgres";
  process.env.DATABASE_URL = "postgres://db.example/cortex";
  await assert.rejects(claudeCodeProvider.complete({ prompt: "ping" }), /SQLite locale/i);
  assert.equal(fs.existsSync(invokedFile), false, "la garde agit avant tout lancement du CLI");
});

test("backend codex : stdout non JSONL est refusé", async () => {
  installFakeBin([
    `cat >/dev/null`,
    `answer=""; previous=""`,
    `for a in "$@"; do [ "$previous" = "--output-last-message" ] && answer="$a"; previous="$a"; done`,
    `printf '%s' 'pas du json'`,
    `printf '%s' 'texte' > "$answer"`,
  ].join("\n"));
  await assert.rejects(claudeCodeProvider.complete({ prompt: "ping" }), /JSONL/i);
});
