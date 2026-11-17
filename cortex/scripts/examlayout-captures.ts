/**
 * Captures de l'ExamLayout : trois annales FICTIVES de styles différents (tests/fixtures/annales :
 * un QCM américain à cinq options, un examen anglais à rédaction, un examen français), et à côté
 * le rendu de Cortex à la mise en page relevée dans chacune (lib/exam-layout-survey), sur les
 * examens fictifs des tests (tests/helpers/gabarits.ts). Compilé par tectonic, aucun appel au modèle.
 *
 *   npx tsx scripts/examlayout-captures.ts docs/examlayout
 *
 * Écrit, par annale, `<nom>-annale-<page>.png` et `<nom>-cortex-<page>.png` (deux premières pages),
 * les PDF de Cortex, et `<nom>-releve.json` : ce que le relevé a vu.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || "docs/examlayout");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-examlayout-"));
process.env.CORTEX_DATA_DIR = path.join(work, "data");

const DPI = "60";

function png(pdf: string, prefix: string): void {
  execFileSync("pdftoppm", ["-png", "-r", DPI, "-f", "1", "-l", "2", pdf, prefix]);
}

async function main(): Promise<void> {
  const { createGabaritCourses, WRITTEN_SPEC, QCM_DATA, DATE } = await import("../tests/helpers/gabarits");
  const { runWithCourse } = await import("../db/client");
  const { renderExamTex, compileExamPdf } = await import("../lib/exam-latex");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { annaleLayout } = await import("../lib/exam-layout");
  const { surveyAnnalePdfs } = await import("../lib/exam-layout-survey");
  const { examsDir } = await import("../lib/paths");
  const ids = await createGabaritCourses();
  fs.mkdirSync(out, { recursive: true });
  const cases = [
    { name: "us-mcq", course: ids.neutralEn, language: "en" as const, form: "qcm" as const },
    { name: "uk-essay", course: ids.neutralEn, language: "en" as const, form: "written" as const },
    { name: "fr-examen", course: ids.neutralFr, language: "fr" as const, form: "written" as const },
  ];
  for (const c of cases) {
    const tex = path.join(__dirname, "..", "tests", "fixtures", "annales", `${c.name}.tex`);
    execFileSync("tectonic", ["--chatter", "minimal", "-o", work, tex]);
    const annale = path.join(work, `${c.name}.pdf`);
    png(annale, path.join(out, `${c.name}-annale`));
    const surveyed = surveyAnnalePdfs([annale]);
    if (!surveyed) throw new Error(`${c.name} : rien de lisible`);
    fs.writeFileSync(path.join(out, `${c.name}-releve.json`), `${JSON.stringify(surveyed, null, 2)}\n`);
    await runWithCourse(c.course, async () => {
      const layout = annaleLayout(surveyed, c.language);
      const src = c.form === "qcm" ? await renderQcmExamTex(QCM_DATA, DATE, false, layout) : await renderExamTex(WRITTEN_SPEC as never, DATE, false, layout);
      const base = `cortex-${c.name}`;
      fs.mkdirSync(examsDir(), { recursive: true });
      fs.writeFileSync(path.join(examsDir(), `${base}.tex`), src);
      await compileExamPdf(base);
      const pdf = path.join(out, `${c.name}-cortex.pdf`);
      fs.copyFileSync(path.join(examsDir(), `${base}.pdf`), pdf);
      png(pdf, path.join(out, `${c.name}-cortex`));
    });
    console.log(`✓ ${c.name}`);
  }
}

main().then(
  () => {
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(0);
  },
  (e) => {
    console.error(e);
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(1);
  },
);
