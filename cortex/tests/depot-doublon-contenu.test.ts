/**
 * Le même fichier déposé deux fois (zone « Questions d'exemple », connecteur) était rangé sous
 * « x-2.pdf » et indexé deux fois : double poids dans la couverture et l'analyse — audit
 * ingestion du 16/11/2026, P2. Un contenu différent sous le même nom reste rangé à part.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { textPdf } from "./helpers/pdf";
import { ingest, newCourse, sourcePaths } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-depot-doublon-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("même fichier déposé deux fois : rangé et indexé une seule fois", async () => {
  const c = await newCourse("Orvelle doublons");
  const { addFileSource } = await import("../lib/course-source");
  const { runWithCourse } = await import("../db/client");
  const add = (data: Buffer) => runWithCourse(c.id, () => addFileSource(c.id, { name: "Sample questions.pdf", data, category: "sample_questions", contentType: "application/pdf" }));
  const same = textPdf("Sample question 1 on Orvelle waves");
  const first = await add(same);
  const again = await add(Buffer.from(same));
  assert.equal(again.name, first.name, "le même contenu rend le fichier déjà rangé");
  const other = await add(textPdf("Sample question 2, another version"));
  assert.notEqual(other.name, first.name, "un contenu différent garde sa place");

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const paths = await sourcePaths(c.id);
  assert.equal(paths.filter((p) => p.includes("Sample_questions")).length, 2, JSON.stringify(paths));
});

test("compte gratuit (original en transit) : le même fichier redéposé n'est pas copié deux fois", async () => {
  const saved = { billing: process.env.BILLING_ENABLED, email: process.env.CORTEX_OWNER_EMAIL, id: process.env.CORTEX_OWNER_USER_ID };
  process.env.BILLING_ENABLED = "1";
  delete process.env.CORTEX_OWNER_EMAIL;
  delete process.env.CORTEX_OWNER_USER_ID;
  try {
    const c = await newCourse("Orvelle doublons gratuit");
    const { addFileSource } = await import("../lib/course-source");
    const { runWithCourse } = await import("../db/client");
    const add = () => runWithCourse(c.id, () => addFileSource(c.id, { name: "Exam info.pdf", data: textPdf("Exam: two hours, no notes"), category: "exam_info", contentType: "application/pdf" }));
    const first = await add();
    assert.equal(first.home, "local");
    assert.equal((await add()).name, first.name, "redéposé avant l'ingestion");
    const r = ingest(c.id);
    assert.equal(r.status, 0, r.output);
    assert.equal((await add()).name, first.name, "redéposé après le départ de l'original");
    assert.equal((await sourcePaths(c.id)).filter((p) => p.includes("Exam_info")).length, 1);
  } finally {
    for (const [k, v] of [["BILLING_ENABLED", saved.billing], ["CORTEX_OWNER_EMAIL", saved.email], ["CORTEX_OWNER_USER_ID", saved.id]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
