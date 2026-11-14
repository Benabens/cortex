import { Worker } from "node:worker_threads";

export type PythonWasmResult = {
  ok: boolean;
  reason?: "disabled" | "timeout" | "memory-limit" | "forbidden-capability" | "execution-error";
  stdout: string;
  stderr: string;
};

export type PythonWasmOptions = {
  stdin?: string;
  args?: string[];
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
};

export function pythonWasmAvailable(): boolean {
  return process.env.CORTEX_PYTHON_WASM === "1";
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
    // Les messages de chargement appartiennent au runtime, pas au programme candidat.
    stdout = "";
    stderr = "";
  }
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
  const memoryMb = Math.max(64, opts.memoryMb ?? 256);
  const maxOutputBytes = Math.max(1_024, opts.maxOutputBytes ?? 64 * 1_024);

  return await new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, stdin: opts.stdin ?? "", args: opts.args ?? [], memoryMb, maxOutputBytes },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(32, memoryMb / 4), stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result: PythonWasmResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout", stdout: "", stderr: "" }), timeoutMs);
    worker.once("message", (message: PythonWasmResult) => finish(message));
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
