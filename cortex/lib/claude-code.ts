import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Localise le binaire `claude`. Le serveur Node peut ne pas avoir le même PATH
 * que le shell interactif (ou `claude` peut être un alias) → on cherche aussi
 * aux emplacements d'install classiques. Surchargeable via CORTEX_CLAUDE_BIN.
 */
/** Chemin du binaire `claude` s'il existe (env, emplacements connus, ou PATH), sinon null. */
export function claudeBinPath(): string | null {
  const fromEnv = process.env.CORTEX_CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    "/opt/node22/bin/claude",
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    try { const p = path.join(d, "claude"); if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** Chemin du binaire `codex` (surchargeable dans les tests et scripts locaux). */
export function codexBinPath(): string | null {
  const fromEnv = process.env.CORTEX_CODEX_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    try { const p = path.join(d, "codex"); if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function resolveClaudeBin(): string {
  return claudeBinPath() ?? "claude"; // dernier recours : laisser le PATH résoudre
}

/**
 * Pont vers le CLI `claude` en mode headless (`claude -p`).
 *
 * Provider de développement local : utilise la session du CLI, sans clé API.
 * Pour ça on retire `ANTHROPIC_API_KEY` de l'environnement
 * du sous-processus → le CLI retombe sur son auth OAuth locale.
 *
 * Marche quand l'app tourne sur une machine où `claude` est installé ET connecté
 * (`claude` lancé une fois → credentials dans ~/.claude). Sinon → erreur claire.
 */

export class ClaudeCodeError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}

export type RunOpts = {
  prompt: string;
  /** 'opus' | 'sonnet' | 'haiku' | id complet. Défaut opus (meilleure vision). */
  model?: string;
  /** Dossiers supplémentaires que l'outil Read peut lire (au-delà du cwd). */
  addDirs?: string[];
  timeoutMs?: number;
  /** Annulation coopérative (kill du sous-processus). */
  signal?: AbortSignal;
  /** Schéma de la réponse finale, transmis à Codex via --output-schema. */
  jsonSchema?: object;
};

export type RunResult = {
  /** Texte final (champ `result` du JSON du CLI). */
  text: string;
  /** Tokens consommés si le CLI les rapporte (métriques/cache). */
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** Lance `claude -p` et renvoie le texte final (champ `result` du JSON). */
export async function runClaudeCode(opts: RunOpts): Promise<string> {
  return (await runClaudeCodeRaw(opts)).text;
}

/** Comme runClaudeCode, mais renvoie aussi l'usage rapporté par le CLI. */
export function runClaudeCodeRaw(opts: RunOpts): Promise<RunResult> {
  if (process.env.CORTEX_LLM_BACKEND === "codex") return runCodexRaw(opts);
  const { model = "opus", addDirs = [], timeoutMs = 180_000, signal } = opts;
  // Le texte extrait des PDF (cours génériques) contient parfois des OCTETS NULS / contrôles que
  // spawn refuse en argument (« must be a string without null bytes ») → on les retire du prompt.
  const prompt = opts.prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--allowedTools", "Read",
    "--model", model,
  ];
  for (const d of addDirs) args.push("--add-dir", d);

  // Sans clé API dans l'env enfant, le CLI utilise sa session OAuth locale.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new ClaudeCodeError("Appel Claude Code annulé.", "ABORTED"));
    }
    let child;
    try {
      child = spawn(resolveClaudeBin(), args, { env, cwd: process.cwd() });
    } catch (e: any) {
      return reject(new ClaudeCodeError(String(e?.message ?? e)));
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ClaudeCodeError("Claude Code a mis trop de temps (timeout).", "TIMEOUT"));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new ClaudeCodeError("Appel Claude Code annulé.", "ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (e: any) => {
      if (e?.code === "ENOENT") {
        done(() => reject(new ClaudeCodeError(
          "CLI `claude` introuvable. Installe-le et authentifie-le (lance `claude` une fois), ou configure un autre fournisseur LLM.",
          "UNAVAILABLE"
        )));
      } else {
        done(() => reject(new ClaudeCodeError(String(e?.message ?? e))));
      }
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) {
        const hint = /api key|credit balance|authentication|oauth|login/i.test(stderr)
          ? " (vérifie que tu es connecté : lance `claude` une fois, puis réessaie)"
          : "";
        return done(() => reject(new ClaudeCodeError((stderr.trim() || `claude a quitté (code ${code})`) + hint)));
      }
      try {
        const j = JSON.parse(stdout);
        if (j.is_error) return done(() => reject(new ClaudeCodeError(String(j.result ?? "Erreur Claude Code"))));
        const usage = j.usage && typeof j.usage === "object"
          ? { inputTokens: numberOrUndef(j.usage.input_tokens), outputTokens: numberOrUndef(j.usage.output_tokens) }
          : undefined;
        done(() => resolve({ text: String(j.result ?? ""), usage }));
      } catch {
        done(() => reject(new ClaudeCodeError("Sortie de Claude Code illisible (JSON attendu).")));
      }
    });
  });
}

/** Le backend abonnement ChatGPT est strictement réservé aux bancs sur une base SQLite locale. */
export function assertCodexBackendAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new ClaudeCodeError("Backend Codex refusé en production.", "UNSUPPORTED");
  }
  if (env.DATABASE_URL || (env.DB_DRIVER ?? "sqlite") !== "sqlite") {
    throw new ClaudeCodeError("Backend Codex refusé : il ne fonctionne que sur une base SQLite locale.", "UNSUPPORTED");
  }
}

/** `codex exec` headless : JSONL sur stdout, réponse finale dans un fichier dédié. */
function runCodexRaw(opts: RunOpts): Promise<RunResult> {
  assertCodexBackendAllowed();
  const { addDirs = [], timeoutMs = 180_000, signal } = opts;
  const prompt = opts.prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
  const bin = codexBinPath() ?? "codex";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-codex-"));
  const answerFile = path.join(temp, "answer.txt");
  const schemaFile = path.join(temp, "schema.json");
  if (opts.jsonSchema) fs.writeFileSync(schemaFile, JSON.stringify(opts.jsonSchema));
  const args = [
    "exec",
    "--json",
    "--sandbox", "read-only",
    "--output-last-message", answerFile,
  ];
  if (opts.jsonSchema) args.push("--output-schema", schemaFile);
  const codexModel = process.env.CORTEX_CODEX_MODEL?.trim();
  if (codexModel) args.push("--model", codexModel);
  for (const d of addDirs) args.push("--add-dir", d);
  args.push("-");

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    let settled = false;
    const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      fn();
    };
    if (signal?.aborted) {
      cleanup();
      return reject(new ClaudeCodeError("Appel Codex annulé.", "ABORTED"));
    }
    try {
      child = spawn(bin, args, { env: { ...process.env }, cwd: process.cwd() });
    } catch (e: any) {
      cleanup();
      return reject(new ClaudeCodeError(String(e?.message ?? e)));
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ClaudeCodeError("Codex a mis trop de temps (timeout).", "TIMEOUT")));
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new ClaudeCodeError("Appel Codex annulé.", "ABORTED")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.on("error", (e: any) => finish(() => reject(new ClaudeCodeError(
      e?.code === "ENOENT" ? "CLI `codex` introuvable. Installe-le et authentifie-le, ou retire CORTEX_LLM_BACKEND=codex." : String(e?.message ?? e),
      e?.code === "ENOENT" ? "UNAVAILABLE" : undefined
    ))));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(() => reject(new ClaudeCodeError(stderr.trim() || `codex a quitté (code ${code})`)));
      try {
        for (const line of stdout.split("\n").map((x) => x.trim()).filter(Boolean)) JSON.parse(line);
        const text = fs.readFileSync(answerFile, "utf8");
        finish(() => resolve({ text }));
      } catch {
        finish(() => reject(new ClaudeCodeError("Sortie de Codex illisible (JSONL et message final attendus).")));
      }
    });
    child.stdin.end(prompt);
  });
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
