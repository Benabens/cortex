import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapModel } from "../config";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider, type LlmUsage } from "../types";

const DEFAULT_TIMEOUT_MS = 180_000;

function productionReason(): string | null {
  return process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT !== undefined
    ? "Le provider codex-cli est interdit en production ; utilise le provider anthropic."
    : null;
}

function binPath(): string | null {
  const configured = process.env.CORTEX_CODEX_BIN;
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates = [
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex",
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "codex");
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function effort(model: string): "high" | "medium" | "low" {
  if (model === "haiku") return "low";
  if (model === "sonnet") return "medium";
  return "high";
}

function parseUsage(stdout: string): LlmUsage | undefined {
  let usage: LlmUsage | undefined;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { usage?: Record<string, unknown> };
      if (!event.usage) continue;
      const number = (key: string) => typeof event.usage?.[key] === "number" ? event.usage[key] as number : undefined;
      usage = { inputTokens: number("input_tokens"), outputTokens: number("output_tokens"), cacheReadTokens: number("cached_input_tokens") };
      if (Object.values(usage).every((value) => value === undefined)) usage = undefined;
    } catch { /* les diagnostics non JSON ne portent pas l'usage */ }
  }
  return usage;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY$/i.test(key) || key === "ANTHROPIC_AUTH_TOKEN") delete env[key];
  }
  return env;
}

export const codexCliProvider: LlmProvider = {
  name: "codex-cli",

  available(): boolean {
    return productionReason() === null && binPath() !== null;
  },

  unavailableReason(): string | null {
    return productionReason() ?? (binPath() ? null : "CLI « codex » introuvable. Installe-le et authentifie-le, ou pose CORTEX_CODEX_BIN.");
  },

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const unavailable = this.unavailableReason();
    if (unavailable) throw new LlmError(unavailable, "UNAVAILABLE");
    const images = req.images ?? [];
    if (images.some((image) => !image.path)) {
      throw new LlmError("codex-cli accepte uniquement des images fournies par chemin de fichier local.", "UNSUPPORTED");
    }
    if (req.addDirs?.length) throw new LlmError("codex-cli ne prend pas en charge addDirs.", "UNSUPPORTED");

    const alias = req.model ?? "opus";
    const model = mapModel(alias, "codex-cli");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-codex-cli-"));
    const output = path.join(cwd, "final.txt");
    const schema = req.json ? path.join(cwd, "schema.json") : null;
    if (schema) fs.writeFileSync(schema, JSON.stringify(req.json!.schema));
    const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", output, "--json", "--model", model, "-c", `model_reasoning_effort=\"${effort(alias)}\"`];
    if (schema) args.push("--output-schema", schema);
    for (const image of images) args.push("-i", image.path!);
    args.push("-");
    const prompt = (req.system ? `${req.system}\n\n${req.prompt}` : req.prompt).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");

    return new Promise<CompleteResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        try { fn(); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
      };
      if (req.signal?.aborted) {
        fs.rmSync(cwd, { recursive: true, force: true });
        return reject(new LlmError("Appel Codex annulé.", "ABORTED"));
      }
      const child = spawn(binPath()!, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (!settled && error.code !== "EPIPE") finish(() => reject(new LlmError(error.message)));
      });
      child.stdin.end(prompt);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new LlmError("Codex CLI a mis trop de temps (timeout).", "TIMEOUT")));
      }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(() => reject(new LlmError("Appel Codex annulé.", "ABORTED")));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(new LlmError(
        error.code === "ENOENT" ? "CLI « codex » introuvable." : error.message,
        error.code === "ENOENT" ? "UNAVAILABLE" : undefined,
      ))));
      child.on("close", (code) => {
        if (code !== 0) return finish(() => reject(new LlmError(stderr.trim() || `codex a quitté (code ${code})`)));
        if (!fs.existsSync(output)) return finish(() => reject(new LlmError("Codex CLI n'a produit aucune réponse finale.")));
        const text = fs.readFileSync(output, "utf8");
        finish(() => resolve({ text, usage: parseUsage(stdout), provider: "codex-cli", model }));
      });
    });
  },
};
