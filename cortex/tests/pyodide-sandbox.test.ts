import assert from "node:assert/strict";
import { test } from "node:test";
import { runPythonWasm, pythonWasmAvailable } from "../lib/pyodide-sandbox";

test("Pyodide reste désactivé sans flag", async () => {
  delete process.env.CORTEX_PYTHON_WASM;
  assert.equal(pythonWasmAvailable(), false);
  const r = await runPythonWasm("print(42)", { timeoutMs: 2_000 });
  assert.equal(r.reason, "disabled");
});

test("Pyodide exécute Python et pandas quand le flag est actif", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    const r = await runPythonWasm("import pandas as pd\nprint(pd.Series([20, 22]).sum())", { timeoutMs: 20_000 });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.stdout.trim(), "42");
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Pyodide interdit le réseau", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    for (const source of [
      "import socket\nsocket.create_connection(('1.1.1.1', 80))",
      "import urllib.request\nurllib.request.urlopen('https://example.com')",
      "import js\njs.fetch('https://example.com')",
    ]) {
      const r = await runPythonWasm(source, { timeoutMs: 10_000 });
      assert.equal(r.ok, false, `accès réseau permis : ${source}`);
      assert.equal(r.reason, "forbidden-capability");
    }
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Pyodide interdit tout accès au système de fichiers Python", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    for (const source of [
      "open('/etc/passwd').read()",
      "import os\nprint(os.listdir('/'))",
      "from pathlib import Path\nPath('/tmp/escape').write_text('x')",
      "import builtins as b\nb.open('/etc/passwd').read()",
      "__builtins__['open']('/etc/passwd').read()",
      "getattr(__builtins__, 'open')('/etc/passwd').read()",
    ]) {
      const r = await runPythonWasm(source, { timeoutMs: 10_000 });
      assert.equal(r.ok, false, `accès fichier permis : ${source}`);
      assert.equal(r.reason, "forbidden-capability");
    }
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Pyodide tue une boucle infinie au timeout", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    const start = Date.now();
    const r = await runPythonWasm("while True: pass", { timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "timeout");
    assert.ok(Date.now() - start < 5_000);
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Pyodide borne la mémoire du worker", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    for (const source of [
      "x = bytearray(512 * 1024 * 1024)\nprint(len(x))",
      "x = [0] * (128 * 1024 * 1024)\nprint(len(x))",
      "x = []\nwhile True:\n x.extend(range(10000))",
    ]) {
      const r = await runPythonWasm(source, { timeoutMs: 10_000, memoryMb: 128 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "memory-limit");
    }
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("verifyCode utilise Pyodide sans isolation noyau", async () => {
  process.env.CORTEX_SANDBOX = "none";
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    delete require.cache[require.resolve("../lib/sandbox-exec")];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require("../lib/sandbox-exec") as typeof import("../lib/sandbox-exec");
    assert.equal(fresh.sandboxAvailable(), false);
    const r = await fresh.verifyCode("python", "import sys\nprint(int(sys.stdin.read()) * 2)", [{ stdin: "21", expect: "42" }]);
    assert.equal(r.verified, true, r.detail);
    assert.match(r.detail, /WebAssembly/);
  } finally {
    delete process.env.CORTEX_SANDBOX;
    delete process.env.CORTEX_PYTHON_WASM;
    delete require.cache[require.resolve("../lib/sandbox-exec")];
  }
});
