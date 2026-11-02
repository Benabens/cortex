/**
 * IMAGES-ÉTALON (lib/course-vision) — HUM-285 (27/10 → 02/11) : la grille
 * d'évaluation de l'essai, d'abord classée en annale, avait été rendue en PNG
 * dans refs/figref/. Retirée des annales puis reclassée en consignes d'examen,
 * son PDF disparaissait de refs/, pas ses images : la conception des notions et
 * des QCM recevait encore la grille comme « vraie page d'examen à imiter ».
 * Une image n'est montrée que si l'annale dont elle vient est encore là.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-vision-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("une image dont l'annale a été retirée n'est plus montrée comme page d'examen", async () => {
  const { runWithCourse } = await import("../db/client");
  const { coursePaths } = await import("../lib/courses");
  const { courseRefImages } = await import("../lib/course-vision");
  const refs = coursePaths("ml").refsDir;
  fs.mkdirSync(path.join(refs, "figref"), { recursive: true });
  fs.writeFileSync(path.join(refs, "final2024.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(refs, "final2024-sol.pdf"), "%PDF-1.4");
  for (const png of ["final2024-1.png", "final2024-2.png", "final2024-sol-1.png", "HUM285_grille_midterm_2025-1.png", "final2024-sol-old-1.png"]) {
    fs.writeFileSync(path.join(refs, "figref", png), "png");
  }
  const shown = await runWithCourse("ml", async () => courseRefImages().map((p) => path.basename(p)));
  assert.deepEqual(shown, ["final2024-1.png", "final2024-2.png", "final2024-sol-1.png"]);
});
