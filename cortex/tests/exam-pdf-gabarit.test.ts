/**
 * Le GABARIT MAISON passe le garde LaTeX quelle que soit la mise en page de l'annale.
 *
 * Prod, 22/11/2026 (commit 7ef540c) : un examen à questions composées d'un cours dont l'annale est
 * en 12 pt affichait « PDF indisponible », et « le régénérer » ne changeait rien. Journal :
 * « Source LaTeX refusé, primitive dangereuse : \documentclass, \usepackage, \IfFileExists ».
 * Cause : la mise en page réécrit le préambule du dépôt (taille de police, multicol), qui n'était
 * plus retiré tel quel par le garde (lib/tex-guard) : tout le préambule était lu comme du contenu.
 * Le garde ne doit viser que ce qui vient du modèle et des utilisateurs : un contenu dangereux
 * reste refusé avec ces mêmes mises en page. Cours et examens FICTIFS (tests/helpers/gabarits.ts).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ExamBlock } from "../lib/blocks";
import type { ExamLayout } from "../lib/exam-layout";
import type { GabaritCourses } from "./helpers/gabarits";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-pdf-gabarit-"));
process.env.CORTEX_DATA_DIR = tmp;
const HAS_TECTONIC = spawnSync("tectonic", ["--version"], { encoding: "utf8" }).status === 0;

let ids: GabaritCourses;
let NEUTRAL: ExamLayout;

before(async () => {
  const { createGabaritCourses } = await import("./helpers/gabarits");
  ids = await createGabaritCourses();
  NEUTRAL = (await import("../lib/exam-layout")).NEUTRAL_LAYOUT;
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const layoutOf = (size: 10 | 11 | 12, columns: 1 | 2): ExamLayout => ({
  ...NEUTRAL, source: "annale", font: { ...NEUTRAL.font, size }, questions: { ...NEUTRAL.questions, columns },
});
const VARIANTS = ([10, 11, 12] as const).flatMap((size) => ([1, 2] as const).map((columns) => ({ size, columns })));

async function renders(layout: ExamLayout, blocks?: ExamBlock[]) {
  const { runWithCourse } = await import("../db/client");
  const { renderExamTex } = await import("../lib/exam-latex");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { renderBlocksTex } = await import("../lib/blocks-latex");
  const { WRITTEN_SPEC, QCM_DATA, BLOCKS, DATE } = await import("./helpers/gabarits");
  return runWithCourse(ids.neutralEn, async () => ({
    written: await renderExamTex(WRITTEN_SPEC as never, DATE, true, layout),
    qcm: await renderQcmExamTex(QCM_DATA, DATE, true, layout),
    blocks: await renderBlocksTex(blocks ?? BLOCKS, DATE, true, layout),
  }));
}

for (const v of VARIANTS) {
  test(`gabarit maison en ${v.size} pt sur ${v.columns} colonne(s) : aucun danger signalé, dans les trois moteurs`, async () => {
    const { findTexHazards } = await import("../lib/tex-guard");
    const r = await renders(layoutOf(v.size, v.columns));
    if (v.size !== 11) assert.match(r.blocks, new RegExp(String.raw`\\documentclass\[${v.size}pt`), "la taille de l'annale est bien appliquée");
    if (v.columns === 2) assert.match(r.blocks, /\\usepackage\{multicol\}/);
    for (const [engine, tex] of Object.entries(r)) assert.deepEqual(findTexHazards(tex), [], `${engine} en ${v.size} pt / ${v.columns} col.`);
  });
}

test("un contenu dangereux reste refusé avec une mise en page d'annale (12 pt, deux colonnes)", async () => {
  const { findTexHazards } = await import("../lib/tex-guard");
  const { BLOCKS } = await import("./helpers/gabarits");
  const r = await renders(layoutOf(12, 2));
  // Ce que le modèle ou l'utilisateur pourrait glisser : \usepackage et \documentclass en plus du gabarit.
  const injected = r.blocks.replace(/^\\begin\{document\}/m, String.raw`\usepackage{catchfile}\documentclass{article}` + "\n" + String.raw`\begin{document}`);
  assert.deepEqual(findTexHazards(injected).sort(), [String.raw`\documentclass`, String.raw`\usepackage`]);
  // Le texte du modèle est échappé : un « \input » dans un scénario ne devient jamais une commande.
  const evil = [{ ...BLOCKS[0], scenario: String.raw`\input{/etc/passwd}` }];
  assert.deepEqual(findTexHazards((await renders(layoutOf(12, 2), evil)).blocks), []);
});

test("bout en bout (tectonic) : examen composé d'une annale en 12 pt sur deux colonnes → énoncé et corrigé en PDF, puis « le régénérer »", { skip: !HAS_TECTONIC && "tectonic absent" }, async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { examsDir } = await import("../lib/paths");
  const { BLOCKS, DATE } = await import("./helpers/gabarits");
  const { saveBlockExam, recompileBlocksPdf } = await import("../lib/blocks");
  const { buildBlocksArtifact } = await import("../lib/blocks-latex");
  await runWithCourse(ids.neutralEn, async () => {
    // La mise en page relevée sur l'annale à la préparation, telle que lib/format l'enregistre.
    await q.ensureTable("format_profile");
    await q.run(`DELETE FROM format_profile`);
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({ basis: "annales", layout: { language: "en", font: { family: "serif", size: 12 }, questions: { columns: 2, titles: true } } }));
    const id = await saveBlockExam(BLOCKS);
    const pdfs = [`blocks-${id}.pdf`, `blocks-${id}-corrige.pdf`].map((f) => path.join(examsDir(), f));
    const art = await buildBlocksArtifact(id, BLOCKS, DATE);
    assert.equal(art.texError, undefined, art.texError);
    assert.equal(art.texWarning, undefined, art.texWarning);
    assert.equal(art.file, `blocks-${id}.pdf`);
    assert.match(fs.readFileSync(path.join(examsDir(), `blocks-${id}.tex`), "utf8"), /\\documentclass\[12pt/);
    for (const f of pdfs) assert.equal(fs.readFileSync(f).subarray(0, 5).toString(), "%PDF-", `${path.basename(f)} compilé`);
    // PDF perdu (stockage, compilation ratée) : « le régénérer » recompile depuis la base, sans le modèle.
    for (const f of pdfs) fs.rmSync(f);
    const again = await recompileBlocksPdf(id);
    assert.equal(again?.texError, undefined, again?.texError);
    assert.equal(again?.file, `blocks-${id}.pdf`);
    for (const f of pdfs) assert.ok(fs.existsSync(f), `${path.basename(f)} recompilé`);
    await q.run(`DELETE FROM format_profile`);
  });
});
