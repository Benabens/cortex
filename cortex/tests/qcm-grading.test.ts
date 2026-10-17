import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-grading-"));
const realCwd = process.cwd();
let scoreQcmAnswer: typeof import("../lib/qcm").scoreQcmAnswer;
let gradeQcm: typeof import("../lib/qcm").gradeQcm;
let runWithCourse: typeof import("../db/client").runWithCourse;
let q: typeof import("../db/q").q;

before(async () => {
  process.chdir(tmp);
  ({ scoreQcmAnswer, gradeQcm } = await import("../lib/qcm"));
  ({ runWithCourse } = await import("../db/client"));
  ({ q } = await import("../db/q"));
});

after(() => {
  process.chdir(realCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un QCM à choix unique reste noté en tout-ou-rien", () => {
  assert.equal(scoreQcmAnswer([1], [1], 4), 1);
  assert.equal(scoreQcmAnswer([1], [2], 4), 0);
});

test("un QCM multiple exact vaut un point", () => {
  assert.equal(scoreQcmAnswer([0, 2], [2, 0], 4), 1);
});

test("la moitié des bonnes réponses sans erreur vaut un demi-point", () => {
  assert.equal(scoreQcmAnswer([0, 2], [0], 4), 0.5);
});

test("cocher toutes les cases d'un QCM multiple vaut zéro", () => {
  assert.equal(scoreQcmAnswer([0, 2], [0, 1, 2, 3], 4), 0);
});

test("ne cocher aucune case vaut zéro", () => {
  assert.equal(scoreQcmAnswer([0, 2], [], 4), 0);
});

test("gradeQcm somme les points et réserve ok aux réponses parfaitement justes", async () => {
  await runWithCourse("ml", async () => {
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES (?, ?)`, "qcm", "ready");
    const insert = (idx: number, correct: number[]) => q.run(
      `INSERT INTO qcm_items (exam_id, idx, options_json, correct_json, misconceptions_json, explanation) VALUES (?,?,?,?,?,?)`,
      examId, idx, JSON.stringify(["A", "B", "C", "D"]), JSON.stringify(correct), "[]", "Explication",
    );
    await insert(0, [0, 2]);
    await insert(1, [1]);

    const result = await gradeQcm(examId, { 0: [0], 1: [1] });

    assert.equal(result.score, 1.5);
    assert.deepEqual(result.detail.map(({ points, ok }) => ({ points, ok })), [
      { points: 0.5, ok: false },
      { points: 1, ok: true },
    ]);
  });
});
