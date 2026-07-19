import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderFigure, injectFigureTex, FIGURE_MARKER, figureTex, type FigureSpec } from "../lib/figure-gen";
import { sandboxAvailable } from "../lib/sandbox-exec";

/**
 * moteur-v2 (P1) — contrat du rendu de figures sandboxé.
 * Les tests de RENDU sont gatés (sandbox + matplotlib requis) → skip honnête sinon,
 * même convention que le test sympy. Les helpers LaTeX sont toujours testés (purs).
 */

function matplotlibAvailable(): boolean {
  try {
    execFileSync(process.env.CORTEX_PYTHON || "python3", ["-c", "import matplotlib, numpy"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch { return false; }
}

const CAN_RENDER = sandboxAvailable() && matplotlibAvailable();

const SPEC: FigureSpec = {
  kind: "plot",
  seed: 7,
  xlabel: "x1",
  ylabel: "x2",
  legend: true,
  elements: [
    { type: "scatter_cluster", label: "A", n: 12, cx: 0, cy: 0, sx: 0.3, sy: 0.3 },
    { type: "scatter_ring", label: "B", n: 30, cx: 0, cy: 0, r: 3, noise: 0.15 },
    { type: "curve", expr: "x**2 - 1", xmin: -2, xmax: 2 },
  ],
  truth: { nA: "len(data['A'][0])", nB: "len(data['B'][0])", maxAx: "float(np.max(data['A'][0]))" },
};

test("renderFigure : PNG non vide + truth exactes (sandbox)", { skip: !CAN_RENDER && "sandbox/matplotlib absents — rendu non prouvable ici (contrat testé ailleurs)" }, async () => {
  const r = await renderFigure(SPEC);
  assert.equal(r.ok, true, r.reason);
  assert.ok((r.pngB64 ?? "").length > 5_000, "PNG trop petit");
  // en-tête PNG réel
  assert.ok(Buffer.from(r.pngB64!, "base64").subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.equal(r.truth?.nA, 12);
  assert.equal(r.truth?.nB, 30);
  assert.ok(typeof r.truth?.maxAx === "number");
});

test("renderFigure : DÉTERMINISTE — même spec ⇒ même PNG + mêmes truth", { skip: !CAN_RENDER && "sandbox/matplotlib absents" }, async () => {
  const [a, b] = [await renderFigure(SPEC), await renderFigure(SPEC)];
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.pngB64, b.pngB64, "PNG non déterministe");
  assert.deepEqual(a.truth, b.truth);
});

test("renderFigure : spec invalide / trop grosse → refus propre (jamais de crash)", async () => {
  assert.equal((await renderFigure({} as FigureSpec)).ok, false);
  const big: FigureSpec = { kind: "plot", elements: Array.from({ length: 30 }, () => ({ type: "vline" as const, x: 1 })) };
  assert.equal((await renderFigure(big)).ok, false);
});

test("injectFigureTex : marker remplacé UNE fois, sinon préposé", () => {
  const withMarker = `Intro.\n${FIGURE_MARKER}\nSuite ${FIGURE_MARKER} fin.`;
  const out = injectFigureTex(withMarker, "exam-9-fig1.png");
  assert.ok(out.includes("\\includegraphics"));
  assert.equal(out.match(/includegraphics/g)?.length, 1, "un seul includegraphics");
  assert.ok(!out.includes(FIGURE_MARKER));
  const noMarker = injectFigureTex("Question sans marker.", "f.png");
  assert.ok(noMarker.startsWith(figureTex("f.png")));
});
