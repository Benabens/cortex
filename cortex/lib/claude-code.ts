import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Localise le binaire `claude`. Le serveur Node peut ne pas avoir le même PATH
 * que le shell interactif (ou `claude` peut être un alias) → on cherche aussi
 * aux emplacements d'install classiques. Surchargeable via CORTEX_CLAUDE_BIN.
 */
function resolveClaudeBin(): string {
  const fromEnv = process.env.CORTEX_CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "claude"; // dernier recours : laisser le PATH résoudre
}

/**
 * Pont vers Claude Code en mode headless (`claude -p`).
 *
 * But : faire tourner l'IA via l'abonnement **Claude Max** de Ben (gratuit),
 * PAS via l'API payante. Pour ça on retire `ANTHROPIC_API_KEY` de l'environnement
 * du sous-processus → Claude Code retombe sur l'auth OAuth (Max).
 *
 * Marche quand l'app tourne sur une machine où `claude` est installé ET connecté
 * (Ben a lancé `claude` une fois → credentials dans ~/.claude). Sinon → erreur claire.
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
};

/** Lance `claude -p` et renvoie le texte final (champ `result` du JSON). */
export function runClaudeCode(opts: RunOpts): Promise<string> {
  const { prompt, model = "opus", addDirs = [], timeoutMs = 180_000 } = opts;
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--allowedTools", "Read",
    "--model", model,
  ];
  for (const d of addDirs) args.push("--add-dir", d);

  // Force le Max : sans clé API dans l'env enfant, Claude Code utilise l'OAuth (abonnement).
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise<string>((resolve, reject) => {
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

    child.on("error", (e: any) => {
      clearTimeout(timer);
      if (e?.code === "ENOENT") {
        reject(new ClaudeCodeError(
          "Claude Code (CLI `claude`) introuvable. Lance l'app sur ta machine où Claude Code est installé et connecté à ton Max.",
          "UNAVAILABLE"
        ));
      } else {
        reject(new ClaudeCodeError(String(e?.message ?? e)));
      }
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const hint = /api key|credit balance|authentication|oauth|login/i.test(stderr)
          ? " (vérifie que tu es connecté : lance `claude` une fois, puis réessaie)"
          : "";
        return reject(new ClaudeCodeError((stderr.trim() || `claude a quitté (code ${code})`) + hint));
      }
      try {
        const j = JSON.parse(stdout);
        if (j.is_error) return reject(new ClaudeCodeError(String(j.result ?? "Erreur Claude Code")));
        resolve(String(j.result ?? ""));
      } catch {
        reject(new ClaudeCodeError("Sortie de Claude Code illisible (JSON attendu)."));
      }
    });
  });
}

/** Extrait un objet JSON du texte du modèle (retire prose/balises markdown/virgules traînantes). */
export function extractJson<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t) as T;
  } catch {
    // tolère les virgules traînantes (`,]` / `,}`) fréquentes en sortie de modèle
    const cleaned = t.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(cleaned) as T;
  }
}
