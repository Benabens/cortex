/**
 * Captures des gabarits d'examen, compilées par tectonic sur les fixtures FICTIVES des tests
 * (tests/helpers/gabarits.ts) : un QCM avec sa question ouverte et son corrigé, pour un cours
 * de l'EPFL et pour deux cours hors EPFL (anglais, français). Aucun appel au modèle.
 *
 *   npx tsx scripts/gabarits-captures.ts docs/gabarits
 *
 * Écrit, par gabarit, le PDF de l'énoncé et du corrigé et un PNG de leurs deux premières pages.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] || "docs/gabarits");
process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gabarits-"));

async function main(): Promise<void> {
  const { createGabaritCourses, QCM_DATA, DATE } = await import("../tests/helpers/gabarits");
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { examsDir } = await import("../lib/paths");
  const ids = await createGabaritCourses();
  fs.mkdirSync(out, { recursive: true });
  const cases: [string, string][] = [["epfl", ids.epfl], ["neutre-en", ids.neutralEn], ["neutre-fr", ids.neutralFr]];
  for (const [name, course] of cases) {
    await runWithCourse(course, async () => {
      const r = await buildQcmArtifact(1, QCM_DATA, DATE);
      if (r.file !== "qcm-1.pdf" || r.texWarning) throw new Error(`${name} : ${r.texError ?? r.texWarning}`);
      for (const [pdf, label] of [["qcm-1", "enonce"], ["qcm-1-corrige", "corrige"]]) {
        const target = path.join(out, `${name}-${label}`);
        fs.copyFileSync(path.join(examsDir(), `${pdf}.pdf`), `${target}.pdf`);
        execFileSync("pdftoppm", ["-png", "-r", "70", "-f", "1", "-l", "2", `${target}.pdf`, target]);
      }
    });
    console.log(`✓ ${name}`);
  }
  fs.rmSync(process.env.CORTEX_DATA_DIR!, { recursive: true, force: true });
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
