import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

export type PythonWasmResult = {
  ok: boolean;
  reason?: "disabled" | "startup-timeout" | "timeout" | "memory-limit" | "forbidden-capability" | "execution-error";
  stdout: string;
  stderr: string;
  /** Démarrage du worker et du runtime (pandas compris), hors délai d'exécution. */
  startupMs?: number;
  /** Attente d'un créneau (CORTEX_PYTHON_WASM_CONCURRENCY), avant tout délai. */
  queuedMs?: number;
};

export type PythonWasmOptions = {
  stdin?: string;
  args?: string[];
  /** Délai d'exécution du programme, compté à partir du runtime prêt. */
  timeoutMs?: number;
  /** Délai de démarrage du runtime (worker, Pyodide, pandas). */
  startupTimeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
};

export function pythonWasmAvailable(): boolean {
  return process.env.CORTEX_PYTHON_WASM === "1";
}

/** Dossier du paquet npm pyodide, celui que le worker charge (require résolu depuis le cwd). */
export function pyodidePackageDir(): string {
  return path.join(process.cwd(), "node_modules", "pyodide");
}

/**
 * Fichiers des paquets Python demandés, dépendances comprises, absents du disque. Le paquet npm
 * n'embarque que le runtime : loadPackage télécharge le reste depuis le CDN jsDelivr au premier
 * besoin (puis le garde dans ce dossier). En prod ce serait à chaque déploiement, dans le délai
 * d'une vérification ; l'image Docker les précharge donc (scripts/pyodide-prefetch.ts).
 */
export function pyodidePackagesMissing(names: string[], dir = pyodidePackageDir()): string[] {
  let packages: Record<string, { file_name: string; depends: string[] }>;
  try {
    packages = JSON.parse(fs.readFileSync(path.join(dir, "pyodide-lock.json"), "utf8")).packages;
  } catch {
    return ["pyodide-lock.json (illisible)"];
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = packages[name];
    if (!pkg) return void missing.push(`${name} (absent du lockfile)`);
    if (!fs.existsSync(path.join(dir, pkg.file_name))) missing.push(pkg.file_name);
    for (const dep of pkg.depends) visit(dep);
  };
  for (const name of names) visit(name);
  return missing;
}

/**
 * Vérifications simultanées, TOUS processus confondus (CORTEX_PYTHON_WASM_CONCURRENCY, défaut 4).
 * Chaque job est un processus tsx distinct (lib/jobs.ts) : un sémaphore en mémoire ne bornerait
 * qu'un job, et plusieurs examens en parallèle multiplieraient la charge. Mesuré (banc
 * scripts/pyodide-load.ts) : un démarrage pandas occupe ~1,5 cœur ; au-delà de 8 en parallèle, les
 * 8 vCPU du conteneur saturent et l'exécution s'allonge vers le délai de 10 s.
 */
export function pythonWasmConcurrency(): number {
  const n = Number(process.env.CORTEX_PYTHON_WASM_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}

const slotsDir = () => process.env.CORTEX_PYTHON_WASM_SLOTS_DIR || path.join(os.tmpdir(), "cortex-python-wasm-slots");

/** Le détenteur d'un créneau est-il mort (job tué, conteneur redémarré sur le même /tmp) ? */
function slotHolderDead(file: string): boolean {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    // Créneau sans PID : son créateur est mort entre la création et l'écriture, ou l'écrit à l'instant.
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - fs.statSync(file).mtimeMs > 5_000;
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Prend un créneau (fichier slot-i créé en exclusif, PID dedans) ; renvoie de quoi le rendre. */
async function acquireSlot(): Promise<() => void> {
  const dir = slotsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < pythonWasmConcurrency(); i++) {
      const file = path.join(dir, `slot-${i}`);
      try {
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => fs.rmSync(file, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Repris au tour suivant. Deux preneurs qui constatent le même mort peuvent, rarement,
        // dépasser la borne d'un créneau le temps d'une vérification : jamais bloquer.
        if (slotHolderDead(file)) fs.rmSync(file, { force: true });
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { loadPyodide } = require("pyodide");

const send = (value) => parentPort.postMessage(value);
(async () => {
  const { source, stdin, args, maxOutputBytes, memoryMb } = workerData;
  let stdout = "";
  let stderr = "";
  const append = (target, value) => (target + String(value) + "\n").slice(0, maxOutputBytes);
  // Plafond de la mémoire linéaire WebAssembly, que resourceLimits ne couvre pas : tracemalloc ne
  // voit une allocation C unique (np.ones(250_000_000) : 2 Go) qu'une fois faite. Emscripten grandit
  // le tas par Memory.prototype.grow et traite un refus comme un malloc qui échoue : le programme
  // reçoit un MemoryError. Armé au runtime prêt, le budget s'ajoute au tas du runtime (pandas compris).
  let heapBudget = null;
  let heapBase = 0;
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (pages) {
    if (heapBudget !== null) {
      if (!heapBase) heapBase = this.buffer.byteLength;
      if (this.buffer.byteLength + pages * 65536 > heapBase + heapBudget) throw new RangeError("CORTEX_MEMORY_LIMIT");
    }
    return grow.call(this, pages);
  };
  const pyodide = await loadPyodide({
    // N'expose jamais globalThis (fetch, process, require) au pont Python-JavaScript.
    jsglobals: Object.freeze(Object.create(null)),
    stdout: (value) => { stdout = append(stdout, value); },
    stderr: (value) => { stderr = append(stderr, value); },
  });
  // Le code est ensuite validé par l'AST ; ici un simple indice suffit pour précharger le paquet.
  // La détection par expression régulière dans la source évaluée du worker variait selon
  // l'interprétation des antislashs et pouvait laisser l'import pandas sans paquet chargé.
  if (source.includes("pandas")) {
    await pyodide.loadPackage("pandas");
    // loadPackage ne fait que déposer les fichiers : c'est l'import qui instancie les extensions
    // WebAssembly de numpy et pandas. Fait ici, hors du traçage (settrace + tracemalloc) qui le
    // rendait près de trois fois plus lent (7,5 s → 2,6 s mesurés) et hors du délai d'exécution ;
    // le programme retrouve le module dans sys.modules.
    await pyodide.runPythonAsync("import pandas");
    // Les messages de chargement appartiennent au runtime, pas au programme candidat.
    stdout = "";
    stderr = "";
  }
  heapBudget = memoryMb * 1024 * 1024;
  send({ type: "ready" });
  pyodide.globals.set("_cortex_source", source);
  pyodide.globals.set("_cortex_stdin", stdin);
  pyodide.globals.set("_cortex_args", args);
  pyodide.globals.set("_cortex_memory_bytes", memoryMb * 1024 * 1024);
  try {
    await pyodide.runPythonAsync(String.raw` + "`" + `
import ast, io, sys, tracemalloc

class _CortexGuard(ast.NodeVisitor):
    _imports = {"socket", "urllib", "http", "requests", "aiohttp", "os", "pathlib", "shutil", "subprocess", "multiprocessing", "js", "pyodide", "builtins", "importlib", "ctypes"}
    _calls = {"open", "exec", "eval", "compile", "__import__", "input", "getattr", "setattr", "delattr", "vars", "globals", "locals"}
    _attrs = {"system", "popen", "spawn", "fork", "listdir", "scandir", "walk", "remove", "unlink", "rmdir", "mkdir", "makedirs", "rename", "replace", "connect", "urlopen"}
    def fail(self, capability):
        raise PermissionError("CORTEX_FORBIDDEN:" + capability)
    def visit_Import(self, node):
        for alias in node.names:
            if alias.name.split('.')[0] in self._imports: self.fail(alias.name)
        self.generic_visit(node)
    def visit_ImportFrom(self, node):
        if (node.module or '').split('.')[0] in self._imports: self.fail(node.module or '')
        self.generic_visit(node)
    def visit_Name(self, node):
        if node.id in self._calls or (node.id.startswith('__') and node.id != '__name__'): self.fail(node.id)
    def visit_Attribute(self, node):
        if node.attr in self._attrs or node.attr.startswith('__'): self.fail(node.attr)
        self.generic_visit(node)
    def visit_Call(self, node):
        # Une allocation directe supérieure au budget est rejetée avant que WASM ne grossisse.
        if isinstance(node.func, ast.Name) and node.func.id in {'bytearray', 'bytes', 'list'} and node.args:
            requested = self._integer(node.args[0])
            if requested is not None and requested > _cortex_memory_bytes // 2:
                raise MemoryError("CORTEX_MEMORY_LIMIT")
        self.generic_visit(node)
    def visit_BinOp(self, node):
        if isinstance(node.op, ast.Mult):
            count = self._integer(node.left) or self._integer(node.right)
            collection = node.right if self._integer(node.left) is not None else node.left
            if count is not None and isinstance(collection, (ast.List, ast.Tuple, ast.Bytes)):
                item_count = len(collection.elts) if hasattr(collection, 'elts') else len(collection.value)
                if count * max(1, item_count) * 8 > _cortex_memory_bytes // 2:
                    raise MemoryError("CORTEX_MEMORY_LIMIT")
        self.generic_visit(node)
    def _integer(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, int): return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
            left, right = self._integer(node.left), self._integer(node.right)
            if left is not None and right is not None: return left * right
        return None

tree = ast.parse(_cortex_source, mode='exec')
_CortexGuard().visit(tree)
sys.stdin = io.StringIO(_cortex_stdin)
sys.argv = ['main.py', *_cortex_args.to_py()]
tracemalloc.start()
_cortex_trace_ticks = 0
def _cortex_trace(frame, event, arg):
    global _cortex_trace_ticks
    _cortex_trace_ticks += 1
    if _cortex_trace_ticks % 1000 == 0 and tracemalloc.get_traced_memory()[0] > _cortex_memory_bytes:
        raise MemoryError("CORTEX_MEMORY_LIMIT")
    return _cortex_trace
sys.settrace(_cortex_trace)
try:
    exec(compile(tree, '<candidate>', 'exec'), {'__name__': '__main__'})
finally:
    sys.settrace(None)
    tracemalloc.stop()
` + "`" + `);
    send({ ok: true, stdout, stderr });
  } catch (error) {
    const message = String(error && error.message || error);
    const reason = message.includes("CORTEX_FORBIDDEN") ? "forbidden-capability"
      : message.includes("CORTEX_MEMORY_LIMIT") || message.includes("MemoryError") ? "memory-limit"
      : "execution-error";
    send({ ok: false, reason, stdout, stderr: (stderr + message).slice(0, maxOutputBytes) });
  }
})().catch((error) => send({ ok: false, reason: "execution-error", stdout: "", stderr: String(error).slice(0, workerData.maxOutputBytes) }));
`;

export async function runPythonWasm(source: string, opts: PythonWasmOptions = {}): Promise<PythonWasmResult> {
  if (!pythonWasmAvailable()) return { ok: false, reason: "disabled", stdout: "", stderr: "" };
  const timeoutMs = Math.max(100, opts.timeoutMs ?? 10_000);
  // Charger pandas coûte plusieurs secondes de CPU, bien plus sous charge : compté dans le délai
  // d'exécution, il faisait passer un extrait correct pour une boucle infinie.
  const startupTimeoutMs = Math.max(1, opts.startupTimeoutMs ?? 60_000);
  const memoryMb = Math.max(64, opts.memoryMb ?? 256);
  const maxOutputBytes = Math.max(1_024, opts.maxOutputBytes ?? 64 * 1_024);

  // Les délais courent une fois le créneau obtenu : attendre son tour n'est pas la faute du programme.
  const queuedAt = performance.now();
  let release: () => void;
  try {
    release = await acquireSlot();
  } catch (error) {
    // /tmp en lecture seule ou plein : l'exécution est indisponible, le code n'y est pour rien.
    return { ok: false, reason: "disabled", stdout: "", stderr: `créneaux indisponibles : ${String(error)}`.slice(0, maxOutputBytes) };
  }
  const queuedMs = Math.round(performance.now() - queuedAt);
  return await new Promise<PythonWasmResult>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { source, stdin: opts.stdin ?? "", args: opts.args ?? [], memoryMb, maxOutputBytes },
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(32, memoryMb / 4), stackSizeMb: 4 },
      });
    } catch (error) {
      release();
      return resolve({ ok: false, reason: "execution-error", stdout: "", stderr: String(error).slice(0, maxOutputBytes) });
    }
    let settled = false;
    const started = performance.now();
    let startupMs: number | undefined;
    const finish = (result: PythonWasmResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Le créneau n'est rendu qu'une fois le thread fini : sa mémoire est alors libérée.
      void worker.terminate().finally(release);
      resolve({ ...result, startupMs, queuedMs });
    };
    let timer = setTimeout(() => finish({ ok: false, reason: "startup-timeout", stdout: "", stderr: "" }), startupTimeoutMs);
    worker.on("message", (message: PythonWasmResult | { type: "ready" }) => {
      if (!("type" in message)) return finish(message);
      startupMs = Math.round(performance.now() - started);
      clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, reason: "timeout", stdout: "", stderr: "" }), timeoutMs);
    });
    worker.once("error", (error) => finish({
      ok: false,
      reason: /heap|memory|allocation/i.test(error.message) ? "memory-limit" : "execution-error",
      stdout: "",
      stderr: error.message.slice(0, maxOutputBytes),
    }));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish({ ok: false, reason: "memory-limit", stdout: "", stderr: `worker arrêté (${code})` });
    });
  });
}
