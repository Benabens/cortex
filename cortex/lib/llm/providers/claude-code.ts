import { claudeBinPath, codexBinPath, ClaudeCodeError, runClaudeCodeRaw } from "../../claude-code";
import { mapModel } from "../config";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider } from "../types";

/**
 * Provider par défaut (développement local, sans clé API) : CLI `claude -p` en mode headless.
 * Délègue à lib/claude-code.ts (inchangé) → spawn, strip des clés API dans
 * l'env enfant, sanitize des octets de contrôle, --allowedTools Read, --add-dir,
 * timeout SIGKILL : comportement byte-identique à l'historique.
 */
export const claudeCodeProvider: LlmProvider = {
  name: "claude-code",

  available(): boolean {
    return process.env.CORTEX_LLM_BACKEND === "codex" ? codexBinPath() !== null : claudeBinPath() !== null;
  },

  unavailableReason(): string | null {
    if (this.available()) return null;
    return process.env.CORTEX_LLM_BACKEND === "codex"
      ? "CLI « codex » introuvable. Installe-le et authentifie-le, puis réessaie (ou pose CORTEX_CODEX_BIN)."
      : "CLI « claude » introuvable. Installe-le et lance « claude » une fois pour t'authentifier, puis réessaie (ou pose CORTEX_CLAUDE_BIN, ou configure un autre LLM_PROVIDER).";
  },

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (req.images?.length) {
      throw new LlmError(
        "Le provider claude-code ne prend pas d'images base64 — passe des chemins de fichiers dans le prompt (+ addDirs si hors cwd).",
        "UNSUPPORTED"
      );
    }
    const model = mapModel(req.model ?? "opus", "claude-code");
    const prompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
    try {
      const r = await runClaudeCodeRaw({
        prompt,
        model,
        addDirs: req.addDirs,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        jsonSchema: req.json?.schema,
      });
      return { text: r.text, usage: r.usage, provider: this.name, model };
    } catch (e) {
      if (e instanceof ClaudeCodeError) {
        // Codes préservés (TIMEOUT / UNAVAILABLE / ABORTED) — mapping HTTP des routes inchangé.
        throw new LlmError(e.message, e.code);
      }
      throw new LlmError(e instanceof Error ? e.message : String(e));
    }
  },
};
