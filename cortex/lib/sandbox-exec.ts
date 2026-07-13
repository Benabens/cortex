import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SANDBOX D'EXÉCUTION (Phase D) — pour tout code non fiable (réponses « écris une
 * fonction » à vérifier, checks sympy sur des expressions issues du LLM).
 *
 * MODÈLE DE MENACE : le code exécuté vient d'une sortie de modèle (semi-fiable) ou,
 * demain, d'un utilisateur (non fiable). On veut empêcher : exfiltration/appel
 * réseau, écriture hors du répertoire jetable, consommation illimitée (CPU/temps/
 * sortie). On n'essaie PAS de résister à un exploit kernel (pas de VM).
 *
 * ISOLATION PAR PLATEFORME :
 *  - macOS  : `sandbox-exec` (Seatbelt) — profil : réseau ENTIÈREMENT interdit +
 *             écriture limitée au répertoire de travail jetable et /tmp/private.
 *  - Linux  : `unshare -rn` (namespace réseau vide — CI GitHub ok) ; écriture
 *             bornée par le cwd jetable + ulimit taille fichier.
 *  - Les deux : `ulimit -t` (CPU), `-f` (taille fichier), timeout wall-clock
 *             SIGKILL, stdout/stderr tronqués.
 *
 * RÈGLE ABSOLUE : si AUCUNE isolation n'est disponible → on N'EXÉCUTE PAS
 * (résultat { ok:false, reason:'no-sandbox' }) — jamais d'exécution nue.
 * (Surcharge de test : CORTEX_SANDBOX=none simule l'absence d'isolation.)
 */

export type SandboxResult = {
  ok: boolean;
  /** 'no-sandbox' | 'timeout' | 'exit-<code>' | 'spawn-error' | undefined (ok) */
  reason?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type SandboxOpts = {
  /** Commande à lancer (binaire) + args — exécutée DANS le cwd jetable. */
  cmd: string;
  args?: string[];
  stdin?: string;
  /** Fichiers à matérialiser dans le cwd jetable avant exécution. */
  files?: Record<string, string>;
  /** Wall-clock. Défaut 10 s. */
  timeoutMs?: number;
  /** Secondes CPU (ulimit -t). Défaut 10. */
  cpuSeconds?: number;
  /** Troncature stdout/stderr. Défaut 64 Ko. */
  maxOutputBytes?: number;
};

type Backend = { kind: "seatbelt" | "unshare"; wrap: (shellCmd: string, cwd: string) => { bin: string; args: string[] } };

let _backend: Backend | null | undefined;

function detectBackend(): Backend | null {
  if (_backend !== undefined) return _backend;
  if (process.env.CORTEX_SANDBOX === "none") return (_backend = null);
  try {
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5_000 });
      _backend = {
        kind: "seatbelt",
        wrap: (shellCmd, cwd) => ({
          bin: "/usr/bin/sandbox-exec",
          args: [
            "-p",
            // réseau interdit ; écriture seulement dans le cwd jetable (+ /dev/null & tmp privé du process)
            `(version 1)(allow default)(deny network*)(deny file-write* (subpath "/"))(allow file-write* (subpath "${cwd}") (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null"))`,
            "/bin/sh", "-c", shellCmd,
          ],
        }),
      };
      return _backend;
    }
    // Linux : namespace réseau vide, non privilégié
    execFileSync("unshare", ["-rn", "true"], { timeout: 5_000 });
    _backend = {
      kind: "unshare",
      wrap: (shellCmd) => ({ bin: "unshare", args: ["-rn", "/bin/sh", "-c", shellCmd] }),
    };
    return _backend;
  } catch {
    _backend = null;
    return null;
  }
}

/** L'isolation est-elle disponible sur cette machine ? */
export function sandboxAvailable(): boolean {
  return detectBackend() !== null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Exécute une commande dans le bac à sable. Ne lève jamais : tout échec → ok:false. */
export async function runSandboxed(opts: SandboxOpts): Promise<SandboxResult> {
  const backend = detectBackend();
  if (!backend) return { ok: false, reason: "no-sandbox", stdout: "", stderr: "", exitCode: null };

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cpu = Math.max(1, Math.floor(opts.cpuSeconds ?? 10));
  const maxOut = opts.maxOutputBytes ?? 64 * 1024;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sbx-"));
  try {
    for (const [name, content] of Object.entries(opts.files ?? {})) {
      const p = path.join(cwd, path.basename(name)); // pas de traversée
      fs.writeFileSync(p, content);
    }
    // limites POSIX : CPU, taille de fichier (64 Mo), descripteurs. (-v mémoire virtuelle
    // n'est pas fiable sur macOS → on s'appuie sur CPU+temps+sortie tronquée.)
    const inner = `cd ${shQuote(cwd)} && ulimit -t ${cpu} -f 131072 -n 64 2>/dev/null; exec ${shQuote(opts.cmd)} ${(opts.args ?? []).map(shQuote).join(" ")}`;
    const { bin, args } = backend.wrap(inner, cwd);

    return await new Promise<SandboxResult>((resolve) => {
      const child = execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: maxOut, cwd }, (err, stdout, stderr) => {
        const out = String(stdout ?? "").slice(0, maxOut);
        const errOut = String(stderr ?? "").slice(0, maxOut);
        if (!err) return resolve({ ok: true, stdout: out, stderr: errOut, exitCode: 0 });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string };
        if (e.killed || e.signal === "SIGKILL") return resolve({ ok: false, reason: "timeout", stdout: out, stderr: errOut, exitCode: null });
        if (typeof e.code === "number") return resolve({ ok: false, reason: `exit-${e.code}`, stdout: out, stderr: errOut, exitCode: e.code });
        return resolve({ ok: false, reason: "spawn-error", stdout: out, stderr: String(e.message ?? errOut).slice(0, maxOut), exitCode: null });
      });
      if (opts.stdin !== undefined) {
        child.stdin?.write(opts.stdin);
      }
      child.stdin?.end();
    });
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* nettoyage best-effort */ }
  }
}

export type CodeTest = { stdin?: string; expect: string; args?: string[] };
export type CodeRunReport = { verified: true | false | "not_applicable"; detail: string };

function findBin(cands: string[]): string | null {
  for (const c of cands) {
    try { execFileSync("which", [c], { timeout: 3_000 }); return c; } catch { /* absent */ }
  }
  return null;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

/**
 * Vérifie un code candidat (C ou Python) contre des cas de test stdin→stdout,
 * ENTIÈREMENT en sandbox (compilation comprise). Doute/environnement manquant
 * → 'not_applicable' (jamais de faux prouvé).
 */
export async function verifyCode(language: "c" | "python", source: string, tests: CodeTest[]): Promise<CodeRunReport> {
  if (!tests.length) return { verified: "not_applicable", detail: "aucun cas de test" };
  if (!sandboxAvailable()) return { verified: "not_applicable", detail: "sandbox indisponible — exécution refusée" };

  if (language === "c") {
    const cc = findBin([process.env.CORTEX_CC ?? "", "cc", "gcc", "clang"].filter(Boolean));
    if (!cc) return { verified: "not_applicable", detail: "aucun compilateur C" };
    // compile PUIS exécute dans le MÊME cwd jetable (un runSandboxed par test, binaire recompilé —
    // simple et hermétique ; le coût gcc ~100 ms est négligeable devant un appel LLM)
    for (const [i, t] of tests.entries()) {
      const r = await runSandboxed({
        cmd: "/bin/sh",
        args: ["-c", `${cc} -O0 -w main.c -o prog 2>compile.err && ./prog ${(t.args ?? []).map(shQuote).join(" ")} || { cat compile.err >&2; exit 41; }`],
        files: { "main.c": source },
        stdin: t.stdin,
        timeoutMs: 15_000,
      });
      if (!r.ok && r.reason === "no-sandbox") return { verified: "not_applicable", detail: "sandbox indisponible" };
      if (!r.ok && r.reason === "timeout") return { verified: false, detail: `test ${i + 1} : timeout` };
      if (!r.ok) return { verified: false, detail: `test ${i + 1} : ${r.stderr.slice(0, 200) || r.reason}` };
      if (norm(r.stdout) !== norm(t.expect)) {
        return { verified: false, detail: `test ${i + 1} : sortie « ${norm(r.stdout).slice(0, 80)} » ≠ attendu « ${norm(t.expect).slice(0, 80)} »` };
      }
    }
    return { verified: true, detail: `${tests.length} test(s) C passés en sandbox` };
  }

  const py = findBin([process.env.CORTEX_PYTHON ?? "", "python3", "python"].filter(Boolean));
  if (!py) return { verified: "not_applicable", detail: "python indisponible" };
  for (const [i, t] of tests.entries()) {
    const r = await runSandboxed({
      cmd: py,
      args: ["main.py", ...(t.args ?? [])],
      files: { "main.py": source },
      stdin: t.stdin,
      timeoutMs: 10_000,
    });
    if (!r.ok && r.reason === "no-sandbox") return { verified: "not_applicable", detail: "sandbox indisponible" };
    if (!r.ok && r.reason === "timeout") return { verified: false, detail: `test ${i + 1} : timeout` };
    if (!r.ok) return { verified: false, detail: `test ${i + 1} : ${r.stderr.slice(0, 200) || r.reason}` };
    if (norm(r.stdout) !== norm(t.expect)) {
      return { verified: false, detail: `test ${i + 1} : sortie « ${norm(r.stdout).slice(0, 80)} » ≠ attendu « ${norm(t.expect).slice(0, 80)} »` };
    }
  }
  return { verified: true, detail: `${tests.length} test(s) Python passés en sandbox` };
}
