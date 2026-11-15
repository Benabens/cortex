import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runPythonWasm, pythonWasmAvailable, pyodidePackagesMissing } from "../lib/pyodide-sandbox";

test("Pyodide reste désactivé sans flag", async () => {
  delete process.env.CORTEX_PYTHON_WASM;
  assert.equal(pythonWasmAvailable(), false);
  const r = await runPythonWasm("print(42)", { timeoutMs: 2_000 });
  assert.equal(r.reason, "disabled");
});

test("Pyodide exécute Python et pandas quand le flag est actif", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    // Le premier chargement de pandas en WebAssembly est sensiblement plus lent sur le runner CI
    // sans cache chaud ; ce test valide le résultat, les tests suivants valident les bornes courtes.
    const r = await runPythonWasm("import pandas as pd\nprint(pd.Series([20, 22]).sum())", { timeoutMs: 60_000 });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.stdout.trim(), "42");
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Le délai d'exécution ne compte pas le démarrage du runtime, pandas compris", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    // Charger et importer pandas prend plusieurs secondes (2,5 s seul sur un Mac de développement,
    // 11 s à 32 en parallèle) : un délai de 10 s qui l'inclut prend un extrait correct pour une
    // boucle infinie.
    const r = await runPythonWasm("import pandas as pd\nprint(pd.Series([20, 22]).sum())", { timeoutMs: 1_000 });
    assert.equal(r.ok, true, `${r.reason} ${r.stderr}`);
    assert.equal(r.stdout.trim(), "42");
    assert.ok((r.startupMs ?? 0) > 1_000, `démarrage de ${r.startupMs} ms : le test ne prouve rien s'il tient dans le délai`);
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

test("Un runtime qui ne démarre pas dans son propre délai est signalé comme tel, pas comme un timeout du code", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    const r = await runPythonWasm("print(1)", { startupTimeoutMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "startup-timeout");
  } finally {
    delete process.env.CORTEX_PYTHON_WASM;
  }
});

/** Créneaux de vérification dans un dossier propre au test (les fichiers de test tournent en parallèle). */
async function withSlots(concurrency: number, fn: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pywasm-slots-"));
  process.env.CORTEX_PYTHON_WASM = "1";
  process.env.CORTEX_PYTHON_WASM_CONCURRENCY = String(concurrency);
  process.env.CORTEX_PYTHON_WASM_SLOTS_DIR = dir;
  try {
    await fn(dir);
  } finally {
    for (const k of ["CORTEX_PYTHON_WASM", "CORTEX_PYTHON_WASM_CONCURRENCY", "CORTEX_PYTHON_WASM_SLOTS_DIR"]) delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Au-delà de CORTEX_PYTHON_WASM_CONCURRENCY, une vérification attend son tour sans entamer son délai", async () => {
  await withSlots(1, async () => {
    const start = Date.now();
    const [a, b] = await Promise.all([1, 2].map(() => runPythonWasm("while True:\n    pass", { timeoutMs: 1_500 })));
    const elapsed = Date.now() - start;
    assert.deepEqual([a.reason, b.reason], ["timeout", "timeout"]);
    // En série : deux démarrages et deux délais pleins. En parallèle, le tout tiendrait en un seul.
    assert.ok(elapsed >= (a.startupMs ?? 0) + (b.startupMs ?? 0) + 2 * 1_500 - 50, `${elapsed} ms : les deux workers ont tourné ensemble`);
  });
});

test("La borne vaut pour tous les processus : un créneau tenu par un autre job fait attendre", async () => {
  await withSlots(1, async (dir) => {
    // Chaque job est un processus distinct : le créneau est un fichier, ici tenu par un processus vivant.
    fs.writeFileSync(path.join(dir, "slot-0"), String(process.ppid));
    setTimeout(() => fs.rmSync(path.join(dir, "slot-0"), { force: true }), 1_000);
    const start = Date.now();
    const r = await runPythonWasm("print(42)");
    assert.equal(r.stdout.trim(), "42", r.stderr);
    assert.ok(Date.now() - start >= 1_000, "la vérification n'a pas attendu le créneau");
  });
});

test("Le créneau d'un job tué (processus mort) est repris, il ne bloque pas les vérifications", async () => {
  await withSlots(1, async (dir) => {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    fs.writeFileSync(path.join(dir, "slot-0"), dead);
    const r = await runPythonWasm("print(42)", { timeoutMs: 5_000 });
    assert.equal(r.stdout.trim(), "42", `${r.reason} ${r.stderr}`);
    // Rendu à la fin du thread, juste après le résultat.
    for (let i = 0; i < 40 && fs.existsSync(path.join(dir, "slot-0")); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(fs.existsSync(path.join(dir, "slot-0")), false, "le créneau est rendu après la vérification");
  });
});

test("Une allocation numpy unique au-delà du budget mémoire est refusée, pas seulement constatée", async () => {
  process.env.CORTEX_PYTHON_WASM = "1";
  try {
    // 800 Mo en un seul appel C : aucun événement de traçage entre deux, tracemalloc ne voit rien.
    const r = await runPythonWasm("import pandas as pd\nimport numpy as np\na = np.ones(100_000_000)\nprint(a.sum())", { timeoutMs: 20_000, memoryMb: 256 });
    assert.deepEqual([r.ok, r.reason], [false, "memory-limit"], r.stdout + r.stderr.slice(-300));
    const fits = await runPythonWasm("import pandas as pd\nimport numpy as np\nprint(np.ones(10_000_000).sum())", { timeoutMs: 20_000, memoryMb: 256 });
    assert.equal(fits.stdout.trim(), "10000000.0", "80 Mo restent permis");
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
    // Le délai court à partir du runtime prêt.
    assert.ok(Date.now() - start - (r.startupMs ?? 0) < 3_000);
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
      assert.ok(r.reason === "memory-limit" || r.reason === "timeout", `arrêt inattendu : ${r.reason}`);
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

test("Les paquets Pyodide absents du disque sont listés, dépendances comprises", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pyodide-pkg-"));
  try {
    const pkg = (file_name: string, depends: string[]) => ({ file_name, depends });
    fs.writeFileSync(path.join(dir, "pyodide-lock.json"), JSON.stringify({ packages: {
      pandas: pkg("pandas.whl", ["numpy", "python-dateutil"]),
      numpy: pkg("numpy.whl", []),
      "python-dateutil": pkg("dateutil.whl", ["six"]),
      six: pkg("six.whl", []),
    } }));
    for (const f of ["pandas.whl", "numpy.whl"]) fs.writeFileSync(path.join(dir, f), "");
    assert.deepEqual(pyodidePackagesMissing(["pandas"], dir).sort(), ["dateutil.whl", "six.whl"]);
    for (const f of ["dateutil.whl", "six.whl"]) fs.writeFileSync(path.join(dir, f), "");
    assert.deepEqual(pyodidePackagesMissing(["pandas"], dir), []);
    assert.deepEqual(pyodidePackagesMissing(["inconnu"], dir), ["inconnu (absent du lockfile)"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
