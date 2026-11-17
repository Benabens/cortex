/**
 * NOMBRE D'EXERCICES GARANTI (examen écrit, lib/exam generateExamViaClaudeCode) :
 * un lot qui échoue était ignoré et l'examen sortait PARTIEL, signalé par une
 * seule étape du journal, payé plein tarif. Les exercices manquants sont
 * relancés une fois ; le résultat dit combien ont été livrés sur combien
 * demandés (le job rembourse l'écart au prorata, lib/jobs settleShortfall).
 * Lots déterministes (CORTEX_TEST_STUB_BATCH), échec forcé (CORTEX_TEST_FAIL_BATCHES).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-fiab-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.CORTEX_TEST_STUB_BATCH = "1";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "CORTEX_TEST_STUB_BATCH", "CORTEX_TEST_FAIL_BATCHES"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un lot d'exercices échoué est relancé : 4 exercices sur 4", async () => {
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode, examQuestions } = await import("../lib/exam");
  process.env.CORTEX_TEST_FAIL_BATCHES = "1";
  const steps: string[] = [];
  const r = await runWithCourse("ml", () => generateExamViaClaudeCode({ count: 4, verify: false, onStep: (s) => { steps.push(s); } }));
  assert.equal(r.requested, 4);
  assert.equal(r.produced, 4, steps.filter((s) => /Lot|manquant|PARTIEL/.test(s)).join("\n"));
  assert.equal((await runWithCourse("ml", () => examQuestions(r.id, 10))).length, 4);
  assert.ok(steps.some((s) => /exercice\(s\) manquant\(s\)/.test(s)), "la relance est dite");
});
