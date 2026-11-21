/**
 * CORÉEN, HÉBREU ET ARABE DANS LE PDF (reste de #165, audit « formats » du 16/11/2026). Le PDF
 * imprimait le cyrillique, le grec et le chinois, mais les lettres hangul, hébraïques et arabes
 * sortaient en blanc : aucune police chargée ne les couvrait. L'hébreu et l'arabe s'écrivent en
 * plus de droite à gauche : sans bidi, chaque mot est juste mais la phrase se lit à l'envers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pdf-rtl-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Marques de direction que pdftotext insère autour d'un passage de droite à gauche. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** Le texte du PDF d'un QCM (énoncé), tel que pdftotext le relit ; null si l'outillage manque. */
async function qcmPdfText(t: TestContext, examId: number, stems: [string, string[]][]): Promise<string | null> {
  const { texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) { t.skip("tectonic/pdflatex absent"); return null; }
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("pdftotext", ["-v"]).error) { t.skip("pdftotext absent"); return null; }
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { examsDir } = await import("../lib/paths");
  const items = stems.map(([stem, options]) => ({ topic: "T", type: "scq" as const, stem, options, correct: [0], misconceptions: ["", "", "", ""], explanation: options[0], verified: 1 as const }));
  // Le dossier des examens dépend du cours : le chemin se lit dans son contexte.
  const { out, pdf } = await runWithCourse("ml", async () => {
    const out = await buildQcmArtifact(examId, { items, open: [] }, "2026-11-21");
    return { out, pdf: path.join(examsDir(), out.file) };
  });
  assert.equal(out.texError, undefined, out.texError);
  return spawnSync("pdftotext", ["-enc", "UTF-8", pdf, "-"], { encoding: "utf8" }).stdout.replace(BIDI_MARKS, "").replace(/\s+/g, " ");
}

test("un QCM d'un cours en coréen imprime ses lettres hangul", async (t) => {
  const text = await qcmPdfText(t, 4301, [["어떤 함수가 연속입니까?", ["사인 함수", "탄젠트 함수", "함수 1/x", "로그 함수"]]]);
  if (text === null) return;
  for (const s of ["어떤 함수가 연속입니까", "사인 함수", "로그 함수"]) assert.ok(text.includes(s), `${s} absent du PDF`);
});
