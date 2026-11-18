/**
 * EXPORT DU BANC, EXAMEN ÉCRIT : exam_questions.statement_html porte le LaTeX BRUT de l'exercice, que
 * l'export nettoyait comme du HTML (`<[^>]+>`). Banc cs-202-ecrit du 17/11 : tout ce qui se trouve
 * entre un « < » et le « > » suivant disparaissait (« for (int i = 0; i < 3; i++) … » ou
 * « $0 \le x < b$ … > » : des sous-questions entières) — le juge et la relecture lisaient des exercices amputés.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bench-export-"));
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

test("l'export d'un exercice d'examen garde son LaTeX entier, « < » et « > » compris", async () => {
  const statement = String.raw`\subq{1.1}{Boucle}{4} Dans \texttt{for (int i = 0; i < 3; i++)}, combien de threads ?
\subq{1.2}{Bornes}{6} L'accès est valide si $0 \le x < b$. Que vaut $x$ si $y > 2$ ?`;
  const solution = String.raw`\subq{1.1}{Boucle}{4} 3 threads (i < 3). \subq{1.2}{Bornes}{6} $x = 1$ car $y > 2$.`;
  const { runWithCourse } = await import("../db/client");
  const { persistExercise } = await import("../lib/exam");
  const { readExam } = await import("../lib/bench/export");
  const { exam } = await runWithCourse("ml", async () => {
    const { id } = await persistExercise({ category: "OS", concept: "Threads", statement_tex: statement, solution_tex: solution, points: 10 });
    return readExam(id);
  });
  assert.ok(exam);
  const it = exam.items[0] as { stem: string; solution?: string };
  assert.match(it.stem, /i < 3; i\+\+\)\}, combien de threads \?/);
  assert.match(it.stem, /\\subq\{1\.2\}\{Bornes\}/, "la sous-question 1.2 est là");
  assert.match(it.solution ?? "", /\\subq\{1\.2\}\{Bornes\}\{6\} \$x = 1\$ car \$y > 2\$/);
});
