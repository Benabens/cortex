/**
 * Captures des gabarits d'examen, compilées par tectonic sur les fixtures FICTIVES des tests
 * (tests/helpers/gabarits.ts) : examen écrit, QCM avec question ouverte et questions composées,
 * énoncé et corrigé, pour un cours de l'EPFL et deux cours hors EPFL (anglais, français).
 * Aucun appel au modèle.
 *
 *   npx tsx scripts/gabarits-captures.ts docs/gabarits
 *
 * Écrit, par cours et par forme, le PDF de l'énoncé et du corrigé et un PNG de leurs deux premières
 * pages (la garde, puis les premières questions).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || "docs/gabarits");
process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gabarits-"));

async function main(): Promise<void> {
  const { createGabaritCourses, WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("../tests/helpers/gabarits");
  const { runWithCourse } = await import("../db/client");
  const { buildExamArtifact } = await import("../lib/exam-latex");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { buildBlocksArtifact } = await import("../lib/blocks-latex");
  const { examsDir } = await import("../lib/paths");
  const ids = await createGabaritCourses();
  fs.mkdirSync(out, { recursive: true });
  const cases: [string, string][] = [["epfl", ids.epfl], ["neutre-en", ids.neutralEn], ["neutre-fr", ids.neutralFr]];
  for (const [name, course] of cases) {
    await runWithCourse(course, async () => {
      const built = [
        { kind: "ecrit", r: await buildExamArtifact(WRITTEN_SPEC as never, 1, DATE) },
        { kind: "qcm", r: await buildQcmArtifact(1, QCM_DATA, DATE) },
        { kind: "composees", r: await buildBlocksArtifact(1, BLOCKS, DATE) },
      ];
      for (const { kind, r } of built) {
        const warning = "texWarning" in r ? r.texWarning : undefined;
        if (!r.file.endsWith(".pdf") || warning) throw new Error(`${name} ${kind} : ${r.texError ?? warning}`);
        const base = r.file.replace(/\.pdf$/, "");
        for (const [pdf, label] of [[base, "enonce"], [`${base}-corrige`, "corrige"]]) {
          const target = path.join(out, `${name}-${kind}-${label}`);
          fs.copyFileSync(path.join(examsDir(), `${pdf}.pdf`), `${target}.pdf`);
          execFileSync("pdftoppm", ["-png", "-r", "70", "-f", "1", "-l", "2", `${target}.pdf`, target]);
        }
      }
    });
    console.log(`✓ ${name}`);
  }
  fs.rmSync(process.env.CORTEX_DATA_DIR!, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.rmSync(process.env.CORTEX_DATA_DIR!, { recursive: true, force: true });
    process.exit(1);
  },
);
