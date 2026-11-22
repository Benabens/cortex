/**
 * FORMULES ET PUCES DANS LE VRAI PDF (signalé le 22/11/2026, captures d'un examen) : « x_{t+1} »,
 * « $\frac{a}{b}$ » et « \(\sum_i w_i\) » s'imprimaient en texte brut, et les puces d'une liste se
 * suivaient sur une ligne. QCM, question ouverte et question composée passent par la chaîne
 * réelle (rendu, garde, tectonic), puis pdftotext relit le PDF. Cours et questions fictifs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pdf-formules-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let course = "";
before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: "Optimisation fictive", code: "FIC-411", university: "Université fictive", language: "fr" }, "owner");
  await insertCourse(row);
  course = row.id;
  await reloadCourses();
});

function toolsMissing(t: TestContext, texAvailable: () => boolean): boolean {
  if (!texAvailable()) { t.skip("tectonic/pdflatex absent"); return true; }
  if (spawnSync("pdftotext", ["-v"]).error) { t.skip("pdftotext absent"); return true; }
  return false;
}

/** Texte du PDF, ligne par ligne (mise en page gardée : une puce est en tête de sa ligne). */
const pdfLines = (file: string) =>
  spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim()).filter(Boolean);

/** Aucune trace du source d'une formule : ni antislash, ni dollar, ni « _{ ». */
function assertComposed(lines: string[], where: string) {
  const raw = lines.filter((l) => /\\|\$|_\{|\^\{|x_t/.test(l));
  assert.deepEqual(raw, [], `${where} : formule restée en texte brut`);
}

const STEM = String.raw`La mise à jour vaut x_{t+1} = x_t - \eta \nabla f(x_t), avec $f(x) = \frac{a}{b} x^2$ et \(\sum_i w_i = 1\) :
- premier point
- second point
1. étape un
2. étape deux
Le fichier snake_case.py reste tel quel.`;

test("QCM et question ouverte : formules composées, puces en vraie liste, snake_case intact", async (t) => {
  const { texAvailable } = await import("../lib/exam-latex");
  if (toolsMissing(t, texAvailable)) return;
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { examsDir } = await import("../lib/paths");
  const items = [{
    topic: "Gradient", type: "scq" as const, stem: STEM, options: [String.raw`$\frac{a}{b}$`, "x_{t+1} = 0", String.raw`\(\sum_i x_i\)`, "aucune des deux :\n- option un\n- option deux"],
    correct: [0], misconceptions: ["", "", "", ""], explanation: "Car $x_{t+1} < x_t$ :\n- un\n- deux", verified: 1 as const,
  }];
  // LaTeX libre : un indice hors maths (« Missing $ inserted ») faisait passer toute l'ouverte en texte simple
  const open = [{ concept: "Convergence", points: 10, statement_tex: String.raw`Montrez que x_{t+1} converge, avec $\frac{a}{b} \le 1$ :` + "\n- point ouvert A\n- point ouvert B", solution_tex: String.raw`On a $x_t \to 0$.` }];
  const { out, dir } = await runWithCourse(course, async () => ({ out: await buildQcmArtifact(4411, { items, open: open as never }, "2026-11-22"), dir: examsDir() }));
  assert.equal(out.texError, undefined, out.texError);
  assert.equal(out.texWarning, undefined, out.texWarning);
  for (const file of ["qcm-4411.pdf", "qcm-4411-corrige.pdf"]) {
    const lines = pdfLines(path.join(dir, file));
    assertComposed(lines, file);
    for (const item of ["premier point", "second point", "étape un", "étape deux", "point ouvert A", "point ouvert B", "option un", "option deux"]) {
      assert.ok(lines.some((l) => new RegExp(`^(?:•|\\d\\.)\\s*${item}$`).test(l)), `${file} : « ${item} » n'est pas un élément de liste`);
    }
    assert.ok(lines.some((l) => l.includes("snake_case.py")), `${file} : snake_case.py modifié`);
  }
  const key = pdfLines(path.join(dir, "qcm-4411-corrige.pdf"));
  assert.ok(key.some((l) => /^•\s*deux$/.test(l)), "explication : liste perdue");
});

test("question composée : scénario, sous-questions, options, réponse et barème composés", async (t) => {
  const { texAvailable } = await import("../lib/exam-latex");
  if (toolsMissing(t, texAvailable)) return;
  const { runWithCourse } = await import("../db/client");
  const { buildBlocksArtifact } = await import("../lib/blocks-latex");
  const { examsDir } = await import("../lib/paths");
  const part = (kind: "scq" | "short") => ({
    kind, prompt: "Calculez x_{t+1} :\n- cas 1\n- cas 2", code: "", options: kind === "scq" ? [String.raw`$x^2$`, String.raw`\(\sum_i x_i\)`, "x_{t+1}", "deux cas :\n- choix un\n- choix deux"] : [],
    correct: kind === "scq" ? 0 : -1, answer: kind === "short" ? String.raw`On obtient \[x_{t+1} = 0\].` : "", criteria: kind === "short" ? [{ label: "donne $x_{t+1}$", points: 2 }] : [],
    points: 2, explanation: String.raw`Parce que \frac{a}{b} :` + "\n- un\n- deux",
  });
  const blocks = [{ title: "Q1", scenario: String.raw`Soit x_{t+1} = A x_t, avec $A \in \mathbb{R}^{n\times n}$.` + "\n\n- hypothèse un\n- hypothèse deux", parts: [part("scq"), part("short")], points: 4 }];
  const { out, dir } = await runWithCourse(course, async () => ({ out: await buildBlocksArtifact(4412, blocks as never, "2026-11-22"), dir: examsDir() }));
  assert.equal(out.texError, undefined, out.texError);
  assert.equal(out.texWarning, undefined, out.texWarning);
  for (const file of ["blocks-4412.pdf", "blocks-4412-corrige.pdf"]) {
    const lines = pdfLines(path.join(dir, file));
    assertComposed(lines, file);
    for (const item of ["hypothèse un", "hypothèse deux", "cas 1", "cas 2", "choix un", "choix deux"]) assert.ok(lines.some((l) => new RegExp(`^•\\s*${item}$`).test(l)), `${file} : « ${item} » n'est pas une puce`);
  }
});
