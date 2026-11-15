/**
 * BANC DE CHARGE — vérification Python en WebAssembly (lib/pyodide-sandbox, CORTEX_PYTHON_WASM=1).
 *
 * Lance N vérifications simultanées via runPythonWasm, avec du code réaliste de questions de
 * lecture de code (boucles, listes, pandas sur un DataFrame moyen), et mesure par palier :
 * RSS max du processus (échantillonné), mémoire par worker, durée p50/p95, échecs, CPU.
 * Mesure aussi le démarrage à froid (runtime seul, puis runtime + pandas) et, sur plusieurs
 * vagues successives contenant chacune une boucle infinie tuée au vrai timeout, que la
 * mémoire des workers tués est bien rendue (pas de croissance d'une vague à l'autre).
 *
 * Banc LOCAL : il pousse la machine à plusieurs Go de mémoire, il refuse de tourner sur Railway.
 * Aucun appel LLM, aucune base.
 *
 *   CORTEX_CLAUDE_BIN=/usr/bin/false npm run pyodide:load
 *   CORTEX_CLAUDE_BIN=/usr/bin/false npm run pyodide:load -- --paliers 1,4,8 --vagues 3 --vague-taille 8 --json /tmp/pyodide.json
 *
 * Options : --paliers (défaut 1,4,8,16,32) · --timeout ms (défaut 10000, celui de la prod)
 * · --vagues (défaut 3) · --vague-taille (défaut 8) · --borne n (CORTEX_PYTHON_WASM_CONCURRENCY ; défaut : aucune)
 * · --sans-bombe (saute le pire cas mémoire)
 * · --json chemin (résultats bruts).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pyodidePackagesMissing, runPythonWasm, type PythonWasmResult } from "../lib/pyodide-sandbox";

if (process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME) {
  console.error("pyodide-load : banc local, refusé sur Railway (il occupe plusieurs Go de mémoire).");
  process.exit(2);
}
process.env.CORTEX_PYTHON_WASM = "1";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PALIERS = arg("paliers", "1,4,8,16,32").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const TIMEOUT_MS = Number(arg("timeout", "10000"));
const VAGUES = Number(arg("vagues", "3"));
const VAGUE_TAILLE = Number(arg("vague-taille", "8"));
const JSON_OUT = arg("json", "");
// Sans --borne, aucune borne : on mesure la charge brute. Créneaux dans un dossier privé.
const BORNE = arg("borne", "");
process.env.CORTEX_PYTHON_WASM_CONCURRENCY = BORNE || "100000";
process.env.CORTEX_PYTHON_WASM_SLOTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pyodide-load-"));

// ── Programmes : ce qu'une question de lecture de code fait réellement exécuter ──
const BOUCLES = `
def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True

total = 0
for n in range(20000):
    if is_prime(n):
        total += n
print(total)
`;

const LISTES = `
words = ["alpha", "beta", "gamma", "delta", "epsilon"] * 2000
counts = {}
for w in words:
    counts[w] = counts.get(w, 0) + 1
squares = [x * x for x in range(50000) if x % 3 == 0]
matrix = [[i * j for j in range(60)] for i in range(60)]
transposed = list(zip(*matrix))
print(sorted(counts.items()), sum(squares) % 1000003, transposed[5][7])
`;

// DataFrame « moyen » : 20 000 lignes, 4 colonnes, groupby, pondération, pivot.
const PANDAS = `
import pandas as pd
n = 20000
df = pd.DataFrame({
    "etudiant": [f"e{i % 500}" for i in range(n)],
    "cours": [["CS-101", "MATH-111", "PHYS-101", "CS-202"][i % 4] for i in range(n)],
    "note": [(i * 37) % 60 / 10 for i in range(n)],
    "credits": [(i % 6) + 1 for i in range(n)],
})
moy = df.groupby("cours")["note"].mean().round(3)
pond = (df["note"] * df["credits"]).groupby(df["etudiant"]).sum() / df.groupby("etudiant")["credits"].sum()
top = pond.sort_values(ascending=False).head(3)
pivot = df.pivot_table(index="cours", values="note", aggfunc=["min", "max", "count"])
print(moy.to_string())
print(top.round(3).to_string())
print(pivot.shape)
`;

const INFINIE = "while True:\n    pass\n";
// Pire cas mémoire : une seule allocation C de 2 Go (le maximum que numpy accepte en wasm32).
// tracemalloc ne la voit qu'après coup ; seul le plafond de croissance du tas l'empêche.
const BOMBE = "import pandas as pd\nimport numpy as np\na = np.ones(250_000_000)\nprint(a.sum())\n";
// pandas en premier : le palier N=1 mesure le cas le plus lourd.
const MIX = [{ name: "pandas", src: PANDAS }, { name: "boucles", src: BOUCLES }, { name: "listes", src: LISTES }];

// ── Mesures ──
const MB = 1024 * 1024;
const rss = () => process.memoryUsage.rss();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Threads du processus : chaque worker vivant en ajoute ; revenus à la base = workers terminés. */
function threads(): number {
  try {
    if (process.platform === "linux") return fs.readdirSync("/proc/self/task").length;
    if (process.platform === "darwin") return execFileSync("ps", ["-M", String(process.pid)]).toString().trim().split("\n").length - 1;
  } catch { /* indisponible */ }
  return NaN;
}

/** Échantillonne le RSS toutes les 25 ms pendant fn ; renvoie le pic. */
async function withPeakRss<T>(fn: () => Promise<T>): Promise<{ value: T; peak: number }> {
  let peak = rss();
  const timer = setInterval(() => { peak = Math.max(peak, rss()); }, 25);
  try {
    const value = await fn();
    return { value, peak: Math.max(peak, rss()) };
  } finally {
    clearInterval(timer);
  }
}

/**
 * RSS « au repos » : attend que les workers terminés aient rendu leur mémoire. terminate() n'est
 * pas attendu par runPythonWasm et le système récupère les pages avec retard : on attend que le RSS
 * ne bouge plus de 8 Mo sur 3 relevés consécutifs (500 ms d'écart), 30 s au plus.
 */
async function settle(): Promise<number> {
  let last = rss();
  let stable = 0;
  for (let waited = 0; waited < 30_000 && stable < 3; waited += 500) {
    (globalThis as { gc?: () => void }).gc?.();
    await sleep(500);
    const now = rss();
    stable = Math.abs(now - last) < 8 * MB ? stable + 1 : 0;
    last = now;
  }
  return last;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const median = (v: number[]) => percentile(v, 50);

type Run = { name: string; ms: number; result: PythonWasmResult };

async function timed(name: string, src: string, timeoutMs = TIMEOUT_MS): Promise<Run> {
  const t = performance.now();
  const result = await runPythonWasm(src, { timeoutMs });
  return { name, ms: performance.now() - t, result };
}

const failures = (runs: Run[]) => {
  const by: Record<string, number> = {};
  for (const r of runs) if (!r.result.ok) by[`${r.name}:${r.result.reason}`] = (by[`${r.name}:${r.result.reason}`] ?? 0) + 1;
  return by;
};
const fmtFail = (by: Record<string, number>) => Object.entries(by).map(([k, n]) => `${n}× ${k}`).join(", ") || "0";
const mb = (b: number) => Math.round(b / MB);
const s = (ms: number) => (ms / 1000).toFixed(1);
const opt = (ms: number) => (Number.isNaN(ms) ? "—" : `${s(ms)} s`);

async function main() {
  const missing = pyodidePackagesMissing(["pandas"]);
  console.log(`# Banc Pyodide — ${new Date().toISOString()}`);
  console.log(`machine : ${os.cpus().length} cœurs, ${mb(os.totalmem())} Mo · node ${process.version} · timeout ${TIMEOUT_MS} ms · borne ${BORNE || "aucune"}`);
  console.log(`paquets pandas : ${missing.length ? `ABSENTS en local (${missing.join(", ")}) → téléchargés depuis le CDN au premier chargement` : "présents en local"}`);

  // Préchauffe : le premier chargement peut télécharger pandas ; il ne doit pas fausser le palier 1.
  const warm = await timed("préchauffe", PANDAS, 120_000);
  console.log(`préchauffe (pandas${missing.length ? ", CDN" : ""}) : ${s(warm.ms)} s, ${warm.result.ok ? "ok" : warm.result.reason}`);

  // ── Démarrage à froid : chaque vérification démarre un worker et un runtime neufs ──
  // Durée jusqu'au runtime prêt quand runPythonWasm la rapporte, sinon durée totale.
  const until = (r: Run) => r.result.startupMs ?? r.ms;
  const base: number[] = [];
  const withPandas: number[] = [];
  for (let i = 0; i < 3; i++) {
    base.push(until(await timed("froid", "print(1)", 120_000)));
    withPandas.push(until(await timed("froid", "import pandas\nprint(1)", 120_000)));
  }
  const cold = { runtimeMs: median(base), pandasMs: median(withPandas), pandasOnlyMs: median(withPandas) - median(base) };
  console.log(`\n## Démarrage à froid (médiane de 3, séquentiel)\n`);
  console.log(`| worker + loadPyodide | + pandas (loadPackage et import) | total avec pandas |`);
  console.log(`|---|---|---|`);
  console.log(`| ${s(cold.runtimeMs)} s | ${s(cold.pandasOnlyMs)} s | ${s(cold.pandasMs)} s |`);

  // ── Vagues avec une boucle infinie au milieu : les workers tués rendent-ils leur mémoire ? ──
  type Vague = { i: number; ok: number; fail: Record<string, number>; loopReason: string; loopMs: number; rssPeak: number; rssAfter: number; threadsAfter: number };
  const vagues: Vague[] = [];
  const rssBeforeWaves = await settle();
  const threadsBeforeWaves = threads();
  console.log(`\n## ${VAGUES} vagues de ${VAGUE_TAILLE}, une boucle infinie au milieu (timeout ${TIMEOUT_MS} ms)\n`);
  console.log(`| vague | ok (hors boucle) | échecs (hors boucle) | boucle infinie | RSS pic | RSS après | threads après |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (let v = 1; v <= VAGUES; v++) {
    const mid = Math.floor(VAGUE_TAILLE / 2);
    const { value: runs, peak } = await withPeakRss(() => Promise.all(Array.from({ length: VAGUE_TAILLE }, (_, i) =>
      i === mid ? timed("infinie", INFINIE) : timed(MIX[i % MIX.length].name, MIX[i % MIX.length].src))));
    const loop = runs[mid];
    const others = runs.filter((_, i) => i !== mid);
    const rssAfter = await settle();
    const w: Vague = { i: v, ok: others.filter((r) => r.result.ok).length, fail: failures(others), loopReason: loop.result.reason ?? "ok", loopMs: loop.ms, rssPeak: peak, rssAfter, threadsAfter: threads() };
    vagues.push(w);
    console.log(`| ${v} | ${w.ok}/${others.length} | ${fmtFail(w.fail)} | ${w.loopReason} en ${s(w.loopMs)} s | ${mb(peak)} Mo | ${mb(rssAfter)} Mo | ${w.threadsAfter} |`);
  }
  // Preuve directe : un worker tué qui ne finirait pas laisserait son thread (et son tas) derrière
  // lui. Le RSS, lui, ne revient pas forcément à la base : le processus garde le code wasm compilé
  // et l'allocateur ses pages ; une fuite se voit à une croissance qui ne plafonne pas (--vagues 8).
  const lastWave = vagues[vagues.length - 1];
  const threadsLeft = lastWave ? lastWave.threadsAfter - threadsBeforeWaves : NaN;
  const growth = lastWave ? lastWave.rssAfter - rssBeforeWaves : NaN;
  const leak = threadsLeft > 0;
  console.log(`\nAvant les vagues : ${threadsBeforeWaves} threads, RSS stabilisé ${mb(rssBeforeWaves)} Mo · après la vague ${vagues.length} : ${lastWave?.threadsAfter} threads (${threadsLeft >= 0 ? "+" : ""}${threadsLeft}), RSS ${mb(rssBeforeWaves + growth)} Mo (${growth >= 0 ? "+" : ""}${mb(growth)} Mo) → ${leak ? "WORKERS NON TERMINÉS" : "tous les workers tués sont terminés"}`);


  // ── Paliers de concurrence ──
  type Palier = { n: number; ok: number; fail: Record<string, number>; p50: number; p95: number; max: number; p95Pandas: number; p95Queued: number; p95Startup: number; p95Exec: number; wallMs: number; rssBase: number; rssPeak: number; perWorker: number; cpuS: number; cores: number; rssAfter: number };
  const paliers: Palier[] = [];
  console.log(`\n## Paliers (mélange boucles / listes / pandas, timeout ${TIMEOUT_MS} ms)\n`);
  console.log(`| N | ok | échecs | p50 | p95 | max | p95 pandas | p95 attente créneau | p95 démarrage | p95 exécution | RSS repos | RSS pic | Δ par worker | CPU | cœurs moy. | RSS après |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const n of PALIERS) {
    const rssBase = await settle();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const { value: runs, peak } = await withPeakRss(() => Promise.all(Array.from({ length: n }, (_, i) => timed(MIX[i % MIX.length].name, MIX[i % MIX.length].src))));
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuS = (cpu.user + cpu.system) / 1e6;
    const rssAfter = await settle();
    const ms = runs.map((r) => r.ms);
    const pandasMs = runs.filter((r) => r.name === "pandas").map((r) => r.ms);
    // startupMs n'existe que depuis la séparation des délais (démarrage, puis exécution).
    const startup = runs.flatMap((r) => (r.result.startupMs === undefined ? [] : [r.result.startupMs]));
    const queued = runs.map((r) => r.result.queuedMs ?? 0);
    const exec = runs.flatMap((r) => (r.result.startupMs === undefined ? [] : [r.ms - (r.result.queuedMs ?? 0) - r.result.startupMs]));
    const p: Palier = {
      n, ok: runs.filter((r) => r.result.ok).length, fail: failures(runs),
      p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms), p95Pandas: percentile(pandasMs, 95), p95Queued: percentile(queued, 95), p95Startup: percentile(startup, 95), p95Exec: percentile(exec, 95),
      wallMs, rssBase, rssPeak: peak, perWorker: (peak - rssBase) / n, cpuS, cores: cpuS / (wallMs / 1000), rssAfter,
    };
    paliers.push(p);
    console.log(`| ${n} | ${p.ok}/${n} | ${fmtFail(p.fail)} | ${s(p.p50)} s | ${s(p.p95)} s | ${s(p.max)} s | ${opt(p.p95Pandas)} | ${opt(p.p95Queued)} | ${opt(p.p95Startup)} | ${opt(p.p95Exec)} | ${mb(rssBase)} Mo | ${mb(peak)} Mo | ${mb(p.perWorker)} Mo | ${cpuS.toFixed(0)} s | ${p.cores.toFixed(1)} | ${mb(rssAfter)} Mo |`);
  }

  // ── Bombe mémoire : ce qu'un seul worker peut occuper avant d'être arrêté ──
  let bombe: { reason: string; ms: number; rssBase: number; rssPeak: number } | null = null;
  if (!process.argv.includes("--sans-bombe")) {
    const rssBase = await settle();
    const { value: r, peak } = await withPeakRss(() => timed("bombe", BOMBE));
    bombe = { reason: r.result.ok ? "ok" : r.result.reason ?? "?", ms: r.ms, rssBase, rssPeak: peak };
    console.log(`\n## Bombe mémoire (np.ones(250_000_000), 2 Go en un appel)\n`);
    console.log(`résultat : ${bombe.reason} en ${s(r.ms)} s · RSS ${mb(rssBase)} → pic ${mb(peak)} Mo (+${mb(peak - rssBase)} Mo pour un seul worker) · après : ${mb(await settle())} Mo`);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus().length, totalMemMb: mb(os.totalmem()), timeoutMs: TIMEOUT_MS, missingBefore: missing, warmMs: warm.ms, cold, paliers, rssBeforeWaves, threadsBeforeWaves, vagues, growthBytes: growth, threadsLeft, leak, bombe }, null, 2));
    console.log(`résultats bruts : ${JSON_OUT}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
