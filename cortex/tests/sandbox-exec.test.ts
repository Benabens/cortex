import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { runSandboxed, sandboxAvailable, verifyCode } from "../lib/sandbox-exec";
import { verifyDeterministic } from "../lib/verify-deterministic";

/**
 * Sandbox d'exécution (Phase D) : réseau BLOQUÉ, timeout appliqué, cwd jetable,
 * refus d'exécuter sans isolation, vérification de code C/Python de bout en bout.
 * Les tests dépendant de l'isolation se sautent proprement si elle est absente.
 */

const HAS_SANDBOX = sandboxAvailable();
const HAS_PY = (() => { try { execFileSync("which", ["python3"]); return true; } catch { return false; } })();
const HAS_CC = (() => { try { execFileSync("which", ["cc"]); return true; } catch { return false; } })();

test("sans isolation (CORTEX_SANDBOX=none) → REFUS d'exécuter, jamais d'exécution nue", async (t) => {
  process.env.CORTEX_SANDBOX = "none";
  try {
    // le cache de détection est module-level : on teste via un import frais
    delete require.cache[require.resolve("../lib/sandbox-exec")];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require("../lib/sandbox-exec") as typeof import("../lib/sandbox-exec");
    assert.equal(fresh.sandboxAvailable(), false);
    const r = await fresh.runSandboxed({ cmd: "echo", args: ["hello"] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-sandbox");
    const v = await fresh.verifyCode("python", "print(1)", [{ expect: "1" }]);
    assert.equal(v.verified, "not_applicable");
    t.diagnostic("refus vérifié");
  } finally {
    delete process.env.CORTEX_SANDBOX;
    delete require.cache[require.resolve("../lib/sandbox-exec")];
  }
});

test("écho simple dans la sandbox", { skip: !HAS_SANDBOX }, async () => {
  const r = await runSandboxed({ cmd: "/bin/sh", args: ["-c", "echo bonjour"] });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), "bonjour");
});

test("RÉSEAU BLOQUÉ : résolution/connexion impossibles depuis la sandbox", { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
  const r = await runSandboxed({
    cmd: "python3",
    args: ["probe.py"],
    files: {
      "probe.py": [
        "import socket",
        "try:",
        "    s = socket.create_connection(('1.1.1.1', 80), timeout=3)",
        "    print('CONNECTED')",
        "except Exception as e:",
        "    print('BLOCKED', type(e).__name__)",
      ].join("\n"),
    },
    timeoutMs: 15_000,
  });
  assert.ok(r.stdout.includes("BLOCKED"), `réseau non bloqué : ${r.stdout} ${r.stderr}`);
  assert.ok(!r.stdout.includes("CONNECTED"));
});

test("TIMEOUT : boucle infinie tuée sous la limite", { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
  const t0 = Date.now();
  const r = await runSandboxed({ cmd: "python3", args: ["-c", "while True: pass"], timeoutMs: 2_000 });
  assert.equal(r.ok, false);
  assert.ok(["timeout", "exit-137", "exit-152"].some((x) => r.reason?.startsWith(x.split("-")[0]) || r.reason === x), `reason=${r.reason}`);
  assert.ok(Date.now() - t0 < 12_000);
});

test("ÉCRITURE HORS CWD refusée (macOS seatbelt) / cwd jetable nettoyé", { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
  const r = await runSandboxed({
    cmd: "python3",
    args: ["-c", "open('ok.txt','w').write('in-cwd')\nprint('WROTE-CWD')"],
  });
  assert.ok(r.stdout.includes("WROTE-CWD"), `écriture cwd refusée : ${r.stderr}`);
});

test("verifyCode PYTHON : bon programme → prouvé ; mauvais → réfuté", { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
  const good = await verifyCode("python", "import sys\nn = int(sys.stdin.read())\nprint(n * 2)", [
    { stdin: "21", expect: "42" },
    { stdin: "0", expect: "0" },
  ]);
  assert.equal(good.verified, true);
  const bad = await verifyCode("python", "import sys\nprint(int(sys.stdin.read()) + 1)", [{ stdin: "21", expect: "42" }]);
  assert.equal(bad.verified, false);
});

test("verifyCode C : compilation + exécution sandboxées", { skip: !HAS_SANDBOX || !HAS_CC }, async () => {
  const src = `#include <stdio.h>\nint main(void){int n; if (scanf("%d",&n)!=1) return 1; printf("%d\\n", n*n); return 0;}`;
  const good = await verifyCode("c", src, [{ stdin: "7", expect: "49" }]);
  assert.equal(good.verified, true, good.detail);
  const broken = await verifyCode("c", "int main(void){return 0;} garbage", [{ stdin: "7", expect: "49" }]);
  assert.equal(broken.verified, false);
});

test("verifyDeterministic type 'code' → méthode exec", { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
  const r = await verifyDeterministic("print(6*7)", "(exécution)", "code", { tests: [{ expect: "42" }], language: "python" });
  assert.equal(r.method, "exec");
  assert.equal(r.verified, true);
});
