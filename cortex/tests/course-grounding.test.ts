/**
 * NOTIONS DU COURS (lib/course-grounding) — mock 3 de CS-290 (02/11/2026) : la
 * bonne réponse reposait sur « status quo bias », absent des 13 documents du
 * cours (la prof n'a vu que stereotypes, confirmation bias, groupthink, sunk
 * cost fallacy). Le terme que le juge dit avoir trouvé dans le cours est
 * vérifié dans le corpus, de façon déterministe : pluriels, tirets, casse et
 * accents tolérés ; un cours sans corpus ne fait rien rejeter.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-grounding-"));
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

const NOTES = "Cognitive biases in design: stereotypes; confirmation bias (seeking confirming evidence); groupthink; the sunk-cost fallacy. Biais de représentation : un échantillon non représentatif. Users were quickly disabused. Le biais d'ancrage et le taux d’erreur. Simpson's paradox. AUC (area under the curve). A confusion matrix per criterion. Two LLM agents.";

test("un terme absent du corpus est signalé, les variantes d'un terme présent ne le sont pas", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { absentCourseTerms } = await import("../lib/course-grounding");
  await runWithCourse("ml", async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", "Fairness 1", "note/f1", null, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", "Fairness 1", NOTES);
    assert.deepEqual(
      await absentCourseTerms(["Status quo bias", "Groupthink", "sunk cost fallacy", "Stereotype", "confirmation biases", "biais de representation", "status quo bias"]),
      ["Status quo bias"],
    );
    assert.deepEqual(await absentCourseTerms([]), []);
    // Écrits comme dans le cours, ou à une flexion près : jamais rejetés (relecture du 02/11).
    assert.deepEqual(
      await absentCourseTerms(["biais d'ancrage", "taux d'erreur", "Simpson's paradox", "AUC (area under the curve)", "confusion matrices", "criteria", "LLMs"]),
      [],
    );
    assert.deepEqual(await absentCourseTerms(["abuse"]), ["abuse"], "un mot n'est pas trouvé à l'intérieur d'un autre");
  });
});

test("cours sans corpus : rien à vérifier, rien n'est rejeté", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { absentCourseTerms } = await import("../lib/course-grounding");
  await runWithCourse("algo", async () => {
    await q.ensureTable("items");
    assert.deepEqual(await absentCourseTerms(["status quo bias"]), []);
  });
});

test("un terme qui n'apparaît que dans les consignes d'examen (grille d'évaluation) n'est pas un terme du cours", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { absentCourseTerms } = await import("../lib/course-grounding");
  await runWithCourse("ml", async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    // HUM-285, 02/11 : la grille de l'essai (exam_info) nommait D1 « lien conceptuel SHS ».
    const add = async (type: string, title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
    };
    await add("exam_info", "Grille d'évaluation de l'essai", "D1 Lien conceptuel SHS : l'essai mobilise un concept du cours. D2 Vocabulaire conceptuel précis.");
    await add("sample_questions", "Questions d'exemple", "Lequel de ces énoncés décrit le mieux un nudge numérique ?");
    assert.deepEqual(await absentCourseTerms(["lien conceptuel SHS", "vocabulaire conceptuel"]), ["lien conceptuel SHS", "vocabulaire conceptuel"]);
    assert.deepEqual(await absentCourseTerms(["nudge numérique", "groupthink"]), [], "les questions d'exemple de l'enseignant restent du cours");
  });
});
