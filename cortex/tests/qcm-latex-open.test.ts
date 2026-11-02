/**
 * PDF D'UN EXAMEN QCM AVEC SA PARTIE OUVERTE — examens 1 et 2 de CS-290
 * (01/11/2026) : seuls les .tex existaient, l'utilisateur ne voyait les questions
 * ouvertes que dans l'app. Recompilés depuis le dump : « Undefined control
 * sequence \captionof » et « Something's wrong--perhaps a missing \item » (nœud
 * TikZ avec « \\ » sans align, même quand la figure redéfinit « every node »). L'architecte écrit du LaTeX libre : le préambule
 * QCM doit accepter ces deux tournures courantes, sans nouveau paquet (le cache
 * tectonic de l'image n'est préchauffé que pour le préambule commun).
 * Sauté sans tectonic/pdflatex.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-latex-"));
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

const OPEN_TEX = String.raw`\textbf{Setting.} Two groups are scored by the bank.

\begin{center}
\small
\begin{tabular}{|l|c|c|}
\hline
 & TP & FP \\\hline
Group 1 & 93 & 58 \\\hline
\end{tabular}
\captionof{table}{Table 1 -- fill in the derived columns.}
\end{center}

\begin{center}
\begin{tikzpicture}[>=stealth, every node/.style={font=\small}]
 \node[draw, rounded corners] (gen) at (0,1.8) {Gender\\(not in training table)};
 \node (lat) at (0,3.6) {Latent\\variable};
 \node[draw, rounded corners] (sen) at (4,1.8) {Professional\\Seniority};
 \draw[->] (gen) -- (sen);
\end{tikzpicture}
\end{center}`;

test("une question ouverte avec \\captionof et un nœud TikZ multiligne compile en PDF", async (t) => {
  const { texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const item = {
    topic: "Fairness", type: "scq" as const, stem: "Which metric compares false positive rates across groups?",
    options: ["Equalized odds", "Demographic parity", "Predictive parity", "Calibration"], correct: [0],
    misconceptions: ["", "a", "b", "c"], explanation: "Equalized odds compares FPR and TPR.", verified: 1 as const,
  };
  const open = [{ category: "Fairness", concept: "Error rates by group", statement_tex: OPEN_TEX, solution_tex: "FPR = FP/(FP+TN).", points: 15 }];
  const out = await runWithCourse("ml", () => buildQcmArtifact(4242, { items: [item], open }, "2026-11-02"));
  assert.equal(out.texError, undefined, out.texError);
  assert.match(out.file, /\.pdf$/);
});
