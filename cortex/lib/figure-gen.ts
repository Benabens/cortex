import { runSandboxed, sandboxAvailable } from "@/lib/sandbox-exec";
import fs from "node:fs";
import path from "node:path";

/**
 * moteur-v2 (P1) — GÉNÉRATION DE FIGURES « data/géométrie », 100 % générique.
 *
 * Le modèle émet un FIGURE SPEC (JSON générique ci-dessous) quand une question requiert une figure
 * de type « plot » (nuage, courbe, frontière, barres…). Le pipeline la REND en SANDBOX (matplotlib :
 * réseau coupé, cwd jetable, timeout) depuis un générateur de points SEEDÉ → même spec ⇒ même PNG.
 * Le script calcule aussi des valeurs « truth » déclarées par la spec (comptes, min/max, expressions
 * numpy sur les données générées) → base de la VÉRIFICATION DÉTERMINISTE des questions à figure (P4).
 *
 * Les DIAGRAMMES (graphe, arbre, automate, table…) restent du TikZ générique (latex/figures.tex +
 * contrat LaTeX du profil) — aucun rendu Python nécessaire.
 *
 * GÉNÉRICITÉ : les éléments sont des primitives de tracé (cluster, ring, curve, region, bars…) —
 * AUCUN vocabulaire de matière ici. Le CHOIX du type de figure vient de l'ADN détecté (P0).
 */

export type FigureElement =
  | { type: "scatter_cluster"; label?: string; n: number; cx: number; cy: number; sx?: number; sy?: number; marker?: string }
  | { type: "scatter_ring"; label?: string; n: number; cx: number; cy: number; r: number; noise?: number; marker?: string }
  | { type: "points"; label?: string; xs: number[]; ys: number[]; marker?: string }
  | { type: "curve"; label?: string; expr: string; xmin: number; xmax: number; style?: string }
  | { type: "vline"; x: number; style?: string }
  | { type: "hline"; y: number; style?: string }
  | { type: "segment"; x1: number; y1: number; x2: number; y2: number; style?: string }
  | { type: "region"; expr: string; alpha?: number }
  | { type: "bars"; labels: string[]; values: number[] }
  | { type: "annotate"; x: number; y: number; text: string };

export type FigureSpec = {
  kind: "plot";
  /** Graine du générateur (défaut 0) — DÉTERMINISTE : même spec ⇒ même figure. */
  seed?: number;
  title?: string;
  xlabel?: string;
  ylabel?: string;
  xlim?: [number, number];
  ylim?: [number, number];
  equal_aspect?: boolean;
  grid?: boolean;
  legend?: boolean;
  elements: FigureElement[];
  /**
   * Valeurs VÉRITÉ déclarées : clé → expression numpy évaluée APRÈS génération des données.
   * `data[label]` = (xs, ys) de l'élément labellisé. Ex. « len(data['A'][0]) », « float(np.max(data['B'][1])) ».
   * Sert à la vérification déterministe des questions de lecture de figure.
   */
  truth?: Record<string, string>;
};

export type FigureRender = {
  ok: boolean;
  reason?: string;
  pngB64?: string;
  truth?: Record<string, number>;
};

/** Bloc à injecter dans les prompts de génération : le contrat FIGURE SPEC (générique). */
export function figureSpecPromptBlock(): string {
  return [
    `FIGURE SPEC (« figure_spec », UNIQUEMENT si la question exige une figure de type data/plot ; les`,
    `diagrammes graphe/arbre/automate/table se font en TikZ dans l'énoncé) — JSON :`,
    `{ "kind":"plot", "seed":<int>, "xlabel","ylabel", "xlim":[a,b], "ylim":[a,b], "equal_aspect":bool,`,
    `  "legend":bool, "elements":[`,
    `    {"type":"scatter_cluster","label":"A","n":25,"cx":1.0,"cy":2.0,"sx":0.4,"sy":0.4},`,
    `    {"type":"scatter_ring","label":"B","n":40,"cx":0,"cy":0,"r":3.0,"noise":0.2},`,
    `    {"type":"points","label":"C","xs":[…],"ys":[…]}, {"type":"curve","expr":"x**2-1","xmin":-2,"xmax":2},`,
    `    {"type":"vline","x":1.5}, {"type":"segment","x1":0,"y1":0,"x2":2,"y2":1},`,
    `    {"type":"region","expr":"y > 2*x + 1","alpha":0.15}, {"type":"bars","labels":[…],"values":[…]},`,
    `    {"type":"annotate","x":1,"y":2,"text":"P"} ],`,
    `  "truth": { "<clé>": "<expression numpy sur data[label]>" } }`,
    `Rends la question RÉSOLUBLE depuis la figure seule (quantités lisibles), et déclare dans "truth"`,
    `les valeurs que la figure fixe (ex. nombre de points d'un groupe, coordonnée d'une intersection).`,
  ].join("\n");
}

/**
 * Script de rendu (embarqué, écrit dans le cwd jetable de la sandbox). Lit la spec sur stdin,
 * seed numpy, trace en niveaux de gris/markers différenciés (impression N&B), calcule les « truth »,
 * imprime UNE ligne JSON {ok, png_b64, truth} sur stdout. Aucun accès réseau (sandbox) ; matplotlib
 * en backend Agg avec MPLCONFIGDIR local.
 */
const PY_RENDER = `
import sys, os, json, io, base64
os.environ.setdefault("MPLCONFIGDIR", os.getcwd())
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:400]})); sys.exit(0)

try:
    spec = json.loads(sys.stdin.read() or "{}")
except Exception as e:
    fail(f"bad spec json: {e}")

rng = np.random.default_rng(int(spec.get("seed") or 0))
SAFE = {"np": np, "abs": abs, "min": min, "max": max, "len": len, "float": float, "int": int,
        "round": round, "pi": np.pi, "e": np.e, "sin": np.sin, "cos": np.cos, "tan": np.tan,
        "exp": np.exp, "log": np.log, "sqrt": np.sqrt, "sign": np.sign}

GRAYS = ["0.0", "0.45", "0.7", "0.25", "0.55"]
MARKERS = ["o", "s", "^", "x", "D", "v", "P", "*"]

fig, ax = plt.subplots(figsize=(4.6, 3.4), dpi=150)
data = {}
mi = 0
try:
    for el in spec.get("elements", []):
        t = el.get("type")
        if t == "scatter_cluster":
            n = max(1, int(el["n"])); sx = float(el.get("sx", 0.5)); sy = float(el.get("sy", 0.5))
            xs = rng.normal(float(el["cx"]), sx, n); ys = rng.normal(float(el["cy"]), sy, n)
            lab = el.get("label"); m = el.get("marker") or MARKERS[mi % len(MARKERS)]; mi += 1
            ax.scatter(xs, ys, marker=m, s=22, c=GRAYS[(mi-1) % len(GRAYS)], label=lab, zorder=3)
            if lab: data[lab] = (xs, ys)
        elif t == "scatter_ring":
            n = max(1, int(el["n"])); r = float(el["r"]); noise = float(el.get("noise", 0.1))
            th = rng.uniform(0, 2*np.pi, n); rr = r + rng.normal(0, noise, n)
            xs = float(el["cx"]) + rr*np.cos(th); ys = float(el["cy"]) + rr*np.sin(th)
            lab = el.get("label"); m = el.get("marker") or MARKERS[mi % len(MARKERS)]; mi += 1
            ax.scatter(xs, ys, marker=m, s=22, c=GRAYS[(mi-1) % len(GRAYS)], label=lab, zorder=3)
            if lab: data[lab] = (xs, ys)
        elif t == "points":
            xs = np.asarray(el["xs"], dtype=float); ys = np.asarray(el["ys"], dtype=float)
            lab = el.get("label"); m = el.get("marker") or MARKERS[mi % len(MARKERS)]; mi += 1
            ax.scatter(xs, ys, marker=m, s=26, c=GRAYS[(mi-1) % len(GRAYS)], label=lab, zorder=3)
            if lab: data[lab] = (xs, ys)
        elif t == "curve":
            xs = np.linspace(float(el["xmin"]), float(el["xmax"]), 400)
            ys = eval(el["expr"], {"__builtins__": {}}, {**SAFE, "x": xs})
            ys = np.broadcast_to(np.asarray(ys, dtype=float), xs.shape)
            ax.plot(xs, ys, el.get("style") or "-", color="0.1", linewidth=1.4, label=el.get("label"), zorder=2)
            if el.get("label"): data[el["label"]] = (xs, np.asarray(ys))
        elif t == "vline":
            ax.axvline(float(el["x"]), linestyle=el.get("style") or "--", color="0.3", linewidth=1.1)
        elif t == "hline":
            ax.axhline(float(el["y"]), linestyle=el.get("style") or "--", color="0.3", linewidth=1.1)
        elif t == "segment":
            ax.plot([float(el["x1"]), float(el["x2"])], [float(el["y1"]), float(el["y2"])],
                    el.get("style") or "-", color="0.2", linewidth=1.3)
        elif t == "region":
            xl = spec.get("xlim") or [-5, 5]; yl = spec.get("ylim") or [-5, 5]
            gx, gy = np.meshgrid(np.linspace(xl[0], xl[1], 220), np.linspace(yl[0], yl[1], 220))
            mask = eval(el["expr"], {"__builtins__": {}}, {**SAFE, "x": gx, "y": gy})
            ax.contourf(gx, gy, mask.astype(float), levels=[0.5, 1.5], colors=["0.75"], alpha=float(el.get("alpha", 0.3)))
        elif t == "bars":
            labs = [str(s) for s in el["labels"]]; vals = np.asarray(el["values"], dtype=float)
            ax.bar(labs, vals, color="0.55", edgecolor="0.1")
            data.setdefault("bars", (np.arange(len(vals), dtype=float), vals))
        elif t == "annotate":
            ax.annotate(str(el.get("text", "")), (float(el["x"]), float(el["y"])),
                        fontsize=9, color="0.05", zorder=4)
        else:
            fail(f"unknown element type: {t}")
except Exception as e:
    fail(f"element error: {e}")

if spec.get("title"): ax.set_title(str(spec["title"]), fontsize=10)
if spec.get("xlabel"): ax.set_xlabel(str(spec["xlabel"]), fontsize=9)
if spec.get("ylabel"): ax.set_ylabel(str(spec["ylabel"]), fontsize=9)
if spec.get("xlim"): ax.set_xlim(spec["xlim"])
if spec.get("ylim"): ax.set_ylim(spec["ylim"])
if spec.get("equal_aspect"): ax.set_aspect("equal", adjustable="box")
if spec.get("grid", True): ax.grid(True, linestyle=":", linewidth=0.5, color="0.8", zorder=0)
if spec.get("legend") and any(el.get("label") for el in spec.get("elements", [])):
    ax.legend(fontsize=8, framealpha=0.9)
ax.tick_params(labelsize=8)
fig.tight_layout()

truth = {}
try:
    for k, expr in (spec.get("truth") or {}).items():
        v = eval(expr, {"__builtins__": {}}, {**SAFE, "data": data})
        truth[str(k)] = float(v)
except Exception as e:
    fail(f"truth error: {e}")

buf = io.BytesIO()
fig.savefig(buf, format="png")
print(json.dumps({"ok": True, "png_b64": base64.b64encode(buf.getvalue()).decode("ascii"), "truth": truth}))
`;

function pyBin(): string {
  return process.env.CORTEX_PYTHON || "python3";
}

/**
 * Rend un FIGURE SPEC en PNG (+ valeurs truth) DANS LA SANDBOX. Refuse sans isolation
 * (cohérent docs/SANDBOX.md : jamais d'exécution non isolée). Déterministe (seed).
 */
export async function renderFigure(spec: FigureSpec): Promise<FigureRender> {
  if (!spec || spec.kind !== "plot" || !Array.isArray(spec.elements) || spec.elements.length === 0) {
    return { ok: false, reason: "spec invalide (kind='plot' + elements requis)" };
  }
  if (spec.elements.length > 24) return { ok: false, reason: "spec trop grosse (>24 éléments)" };
  if (!sandboxAvailable()) return { ok: false, reason: "no-sandbox" };
  const res = await runSandboxed({
    cmd: pyBin(),
    args: ["fig.py"],
    files: { "fig.py": PY_RENDER },
    stdin: JSON.stringify(spec),
    timeoutMs: 30_000,
    cpuSeconds: 20,
    maxOutputBytes: 4_000_000,
  });
  if (!res.ok) return { ok: false, reason: res.reason ?? `exit ${res.exitCode}` };
  const last = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    const out = JSON.parse(last) as { ok: boolean; error?: string; png_b64?: string; truth?: Record<string, number> };
    if (!out.ok || !out.png_b64) return { ok: false, reason: out.error ?? "rendu vide" };
    return { ok: true, pngB64: out.png_b64, truth: out.truth ?? {} };
  } catch {
    return { ok: false, reason: `sortie illisible: ${last.slice(0, 120)}` };
  }
}

/**
 * Rend et ÉCRIT la figure en PNG dans `dir` sous `baseName`.png (le .tex compilé dans ce même
 * dossier peut alors l'\\includegraphics). Renvoie le nom de fichier + les valeurs truth.
 */
export async function writeFigurePng(
  dir: string,
  baseName: string,
  spec: FigureSpec
): Promise<{ ok: boolean; file?: string; truth?: Record<string, number>; reason?: string }> {
  const r = await renderFigure(spec);
  if (!r.ok || !r.pngB64) return { ok: false, reason: r.reason };
  const safe = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const file = `${safe}.png`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), Buffer.from(r.pngB64, "base64"));
  return { ok: true, file, truth: r.truth };
}

/** Bloc LaTeX d'inclusion d'une figure rendue (le PNG doit être dans le dossier de compilation). */
export function figureTex(file: string, opts: { width?: string } = {}): string {
  const w = opts.width ?? "0.62\\linewidth";
  return `\\begin{center}\\includegraphics[width=${w}]{${file}}\\end{center}`;
}

/** Marqueur que le générateur place dans l'énoncé à l'endroit de la figure. */
export const FIGURE_MARKER = "%%FIGURE%%";

/** Remplace le marqueur par l'inclusion (ou l'insère en tête si absent) ; retire les doublons. */
export function injectFigureTex(statementTex: string, file: string): string {
  const inc = figureTex(file);
  if (statementTex.includes(FIGURE_MARKER)) {
    let first = true;
    return statementTex
      .split(FIGURE_MARKER)
      .reduce((acc, part, i) => {
        if (i === 0) return part;
        const sep = first ? inc : "";
        first = false;
        return acc + sep + part;
      });
  }
  return `${inc}\n${statementTex}`;
}
