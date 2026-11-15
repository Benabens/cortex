import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { claudeCodeProvider } from "../lib/llm/providers/claude-code";
import { LlmError } from "../lib/llm/types";

/**
 * Teste le provider claude-code de bout en bout contre un FAUX binaire `claude`
 * (CORTEX_CLAUDE_BIN) : args CLI exacts, strip des clés API dans l'env enfant,
 * sanitization des octets de contrôle, timeout SIGKILL, usage rapporté.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fake-claude-"));
const argsFile = path.join(tmp, "args.txt");
const fakeBin = path.join(tmp, "claude");

function installFakeBin(script: string) {
  fs.writeFileSync(fakeBin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.CORTEX_CLAUDE_BIN = fakeBin;
}

after(() => {
  delete process.env.CORTEX_CLAUDE_BIN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("provider claude-code : args CLI exacts + addDirs + usage + strip des clés API", async () => {
  installFakeBin(
    [
      `: > "${argsFile}"`,
      `for a in "$@"; do printf '%s\\036' "$a" >> "${argsFile}"; done`,
      `[ -n "$ANTHROPIC_API_KEY" ] && printf 'LEAK_API_KEY\\036' >> "${argsFile}"`,
      `[ -n "$ANTHROPIC_AUTH_TOKEN" ] && printf 'LEAK_AUTH_TOKEN\\036' >> "${argsFile}"`,
      `printf '%s' '{"result":"réponse du modèle","usage":{"input_tokens":42,"output_tokens":7}}'`,
    ].join("\n")
  );
  process.env.ANTHROPIC_API_KEY = "sk-ant-fuite-test";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-fuite-test";
  try {
    const res = await claudeCodeProvider.complete({
      prompt: "Question\x00avec\x07octets de contrôle\net saut de ligne",
      model: "opus",
      addDirs: ["/tmp/dirA", "/tmp/dirB"],
      timeoutMs: 10_000,
    });
    assert.equal(res.text, "réponse du modèle");
    assert.deepEqual(res.usage, { inputTokens: 42, outputTokens: 7 });
    assert.equal(res.provider, "claude-code");

    const argv = fs.readFileSync(argsFile, "utf8").split("").filter(Boolean);
    // Sanitization historique : \x00-\x08 etc. remplacés par des ESPACES, \n préservé.
    assert.deepEqual(argv, [
      "-p", "Question avec octets de contrôle\net saut de ligne",
      "--output-format", "json",
      "--allowedTools", "Read",
      "--model", "opus",
      "--add-dir", "/tmp/dirA",
      "--add-dir", "/tmp/dirB",
    ]);
    // Le strip des clés API (contrat dev €0) : le faux binaire n'a rien vu.
    assert.ok(!argv.includes("LEAK_API_KEY") && !argv.includes("LEAK_AUTH_TOKEN"));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("provider claude-code : timeout → LlmError code TIMEOUT", async () => {
  installFakeBin(`sleep 5\nprintf '%s' '{"result":"trop tard"}'`);
  await assert.rejects(
    claudeCodeProvider.complete({ prompt: "ping", timeoutMs: 200 }),
    (e: unknown) => e instanceof LlmError && e.code === "TIMEOUT"
  );
});

test("provider claude-code : is_error du CLI → LlmError avec le message", async () => {
  installFakeBin(`printf '%s' '{"is_error":true,"result":"quota dépassé"}'`);
  await assert.rejects(
    claudeCodeProvider.complete({ prompt: "ping" }),
    (e: unknown) => e instanceof LlmError && e.message === "quota dépassé"
  );
});

test("provider claude-code : exit≠0 avec stderr auth → hint de reconnexion", async () => {
  installFakeBin(`echo "OAuth authentication failed" >&2\nexit 1`);
  await assert.rejects(
    claudeCodeProvider.complete({ prompt: "ping" }),
    (e: unknown) => e instanceof LlmError && /reconnecté|connecté/.test(e.message)
  );
});

test("provider claude-code : images base64 → UNSUPPORTED (échec bruyant)", async () => {
  installFakeBin(`printf '%s' '{"result":"jamais atteint"}'`);
  await assert.rejects(
    claudeCodeProvider.complete({ prompt: "p", images: [{ mediaType: "image/png", base64: "AAAA" }] }),
    (e: unknown) => e instanceof LlmError && e.code === "UNSUPPORTED"
  );
});

test("provider claude-code : abort → LlmError code ABORTED", async () => {
  installFakeBin(`sleep 5\nprintf '%s' '{"result":"trop tard"}'`);
  const ctl = new AbortController();
  const p = claudeCodeProvider.complete({ prompt: "ping", timeoutMs: 10_000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(p, (e: unknown) => e instanceof LlmError && e.code === "ABORTED");
});

test("provider claude-code en mode banc (CORTEX_CLAUDE_CODE_LEAN=1) : harnais minimal, système à part, effort, usage cache compris", async () => {
  // Banc du 15/11 : sans ce mode, `claude -p` ajoute ≈ 87 k tokens d'entrée par appel (prompt de
  // Claude Code, CLAUDE.md, MCP), soit 0,28 $ au tarif API pour un « OK » : le coût mesuré ne disait
  // plus rien du moteur. Le système du moteur passe à part (mis en cache comme en prod), l'effort
  // du site aussi (défaut de l'API : high).
  installFakeBin(
    [
      `: > "${argsFile}"`,
      `for a in "$@"; do printf '%s\\036' "$a" >> "${argsFile}"; done`,
      `printf '%s' '{"result":"ok","usage":{"input_tokens":5,"cache_creation_input_tokens":1200,"cache_read_input_tokens":3000,"output_tokens":900}}'`,
    ].join("\n")
  );
  process.env.CORTEX_CLAUDE_CODE_LEAN = "1";
  try {
    const res = await claudeCodeProvider.complete({ system: "Contexte du cours", prompt: "Question", model: "opus", effort: "medium", addDirs: ["/tmp/dirA"] });
    assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 900, cacheReadTokens: 3000, cacheWriteTokens: 1200 });
    const argv = fs.readFileSync(argsFile, "utf8").split("\u001e").filter(Boolean);
    assert.deepEqual(argv, [
      "-p", "Question",
      "--output-format", "json",
      "--allowedTools", "Read",
      "--model", "opus",
      "--tools", "Read",
      "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--system-prompt", "Contexte du cours",
      "--effort", "medium",
      "--add-dir", "/tmp/dirA",
    ]);

    await claudeCodeProvider.complete({ prompt: "Question" });
    const bare = fs.readFileSync(argsFile, "utf8").split("\u001e").filter(Boolean);
    assert.equal(bare[bare.indexOf("--effort") + 1], "high", "effort absent : défaut de l'API");
    assert.ok(bare[bare.indexOf("--system-prompt") + 1].length > 0, "système absent : un système minimal remplace celui de Claude Code");
  } finally {
    delete process.env.CORTEX_CLAUDE_CODE_LEAN;
  }
});
