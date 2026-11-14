/**
 * AUDIT PRÉ-LANCEMENT DU 14/11/2026, 🔴 1 : LECTURE DE FICHIERS DU SERVEUR PAR LaTeX.
 * TikZ `plot file` (et ses équivalents PGF) lisait un fichier du conteneur : la garde ne
 * le connaissait pas. Le champ « enseignant » arrivait sans échappement dans l'en-tête des
 * QCM, et le journal de compilation (qui cite le texte lu) était renvoyé à l'utilisateur.
 * Aucun appel au modèle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-latex-read-"));
process.env.CORTEX_DATA_DIR = tmp;

/** Métadonnées saisies par l'utilisateur : chacune porte une commande que la garde refuserait. */
const PIEGE = "piege";
before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  const { insertCourse } = await import("../db/courses-store");
  await ensureCoursesLoaded();
  await insertCourse({
    id: PIEGE, owner_user_id: "alice", name: String.raw`Cours \input{nom}`, short: "CP", code: String.raw`X\input{code}`,
    exam_name: String.raw`Examen \input{examen} 100% & co_1`, exam_kind: String.raw`Final \input{genre}`,
    university: String.raw`Uni \input{uni}`, university_lines: JSON.stringify([String.raw`Uni \input{ligne}`]),
    faculty: String.raw`Fac \input{fac}`, teachers: JSON.stringify([String.raw`Ada \input{prof1}`, String.raw`Bob \input{prof2}`]),
    language: "fr", profile_id: null, duration_min: 120, exam_date: null, db_file: null, refs_rel: null, exams_rel: null,
    uploads_rel: null, content_rel: null, created_at: "2026-11-14 00:00:00",
  });
  await reloadCourses();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const doc = (s: string) => `\\begin{document}\nTexte ${s} texte\n\\end{document}`;

test("la garde refuse les tracés PGF/TikZ qui lisent ou écrivent un fichier", async () => {
  const { findTexHazards } = await import("../lib/tex-guard");
  const cases = [
    String.raw`\draw plot file {/etc/hostname};`,
    String.raw`\draw plot[mark=*] file {../../x.table};`,
    String.raw`\draw plot [smooth] file{x.table};`,
    String.raw`\path plot file {x.table};`,
    String.raw`\draw plot function {x**2};`,
    String.raw`\draw plot[id=f] function{sin(x)};`,
    String.raw`\pgfplotxyfile{/etc/hostname}`,
    String.raw`\pgfplotxyzfile{/etc/hostname}`,
    String.raw`\pgfplotgnuplot[f]{x**2}`,
    String.raw`\pgfplothandlerrecord{sortie.table}`,
    // Vérifié sous tectonic : TikZ développe une macro à la place de `plot` (mais pas à la
    // place de `file`), donc la règle porte aussi sur le mot-clé suivi de son argument.
    String.raw`\def\p{plot}\draw \p file {x.table};`,
    String.raw`\def\p{plot}\def\f{x.table}\draw \p file\f;`,
    String.raw`\def\p{plot file}\draw \p {x.table};`,
    String.raw`\draw plot % commentaire
      file {x.table};`,
    String.raw`\font\x=/etc/hostname`,
  ];
  for (const c of cases) assert.ok(findTexHazards(doc(c)).length > 0, `non détecté : ${c}`);
});

test("les tracés légitimes passent : coordonnées et expressions calculées par TikZ", async () => {
  const { findTexHazards } = await import("../lib/tex-guard");
  const ok = [
    String.raw`\draw plot coordinates {(0,0) (1,1) (2,0)};`,
    String.raw`\draw[domain=0:2, samples=20] plot (\x, {\x*\x});`,
    String.raw`\draw plot[smooth] coordinates {(0,0) (1,2)};`,
    String.raw`\node {profile of the file system};`,
    "Le plot du fichier de log est en annexe.",
    String.raw`The function \(f\) maps a file $F$ of the file system to its size.`,
    String.raw`{\fontsize{9}{11}\selectfont petit}`,
  ];
  for (const c of ok) assert.deepEqual(findTexHazards(doc(c)), [], c);
});

test("les métadonnées du cours arrivent échappées dans le .tex d'un QCM et d'un examen", async () => {
  const { runWithCourse } = await import("../db/client");
  const { findTexHazards } = await import("../lib/tex-guard");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { renderExamTex } = await import("../lib/exam-latex");
  const item = {
    topic: "T", type: "scq" as const, stem: "Question ?", options: ["a", "b"], correct: [0],
    misconceptions: ["", "x"], explanation: "Parce que.", verified: 1 as const,
  };
  const spec = { title: "Examen", duration_min: 120, questions: [{ category: "C", concept: "Notion", points: 10, statement_tex: "Énoncé.", solution_tex: "Solution." }] };
  const rendered = {
    qcm: await runWithCourse(PIEGE, () => renderQcmExamTex({ items: [item], open: [] }, "2026-11-14", true)),
    examen: await runWithCourse(PIEGE, async () => renderExamTex(spec as never, "2026-11-14", true)),
  };
  for (const [kind, tex] of Object.entries(rendered)) {
    assert.deepEqual(findTexHazards(tex), [], `${kind} : métadonnée insérée telle quelle`);
    assert.match(tex, /\\textbackslash\{\}input/, `${kind} : la saisie reste lisible, échappée`);
  }
});

test("la création d'un cours refuse l'antislash, qui ouvre une commande LaTeX, dans chaque champ affiché", async () => {
  const { buildCourseRow, InvalidCourseError } = await import("../lib/course-create");
  const base = { name: "Analyse 3", code: "MATH-203", university: "EPFL", teachers: ["Ada Lovelace"], language: "fr" };
  assert.doesNotThrow(() => buildCourseRow({ ...base, name: "Probabilités & statistiques (100 %)" }, "alice"));
  for (const bad of [{ name: String.raw`Cours \input{x}` }, { code: String.raw`X\y` }, { university: String.raw`\font` }, { teachers: [String.raw`Ada \input{x}`] }, { teachers: String.raw`Ada, \x` }]) {
    assert.throws(() => buildCourseRow({ ...base, ...bad }, "alice"), InvalidCourseError, JSON.stringify(bad));
  }
});

test("la modification d'un cours refuse aussi l'antislash (nom, code, université, enseignants)", async () => {
  const { PATCH } = await import("../app/api/courses/[id]/route");
  const patch = (body: unknown) => PATCH(
    new NextRequest(`http://cortex.test/api/courses/${PIEGE}`, { method: "PATCH", headers: { "x-cortex-user": "alice", "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: PIEGE }) },
  );
  for (const bad of [{ name: String.raw`Cours \input{x}` }, { code: String.raw`X\y` }, { university: String.raw`Uni \font` }, { teachers: [String.raw`Ada \input{x}`] }]) {
    const res = await patch(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await patch({ name: "Probabilités & statistiques" })).status, 200);
});

test("un échec de compilation ne renvoie pas le journal LaTeX : message générique, détail dans les logs serveur", async (t) => {
  const { compileExamPdf, texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  const { examsDir } = await import("../lib/paths");
  // Le journal cite la ligne fautive : c'est par là que le texte d'un fichier lu ressortait.
  const MARK = "CONTENU_DU_JOURNAL_7f3a";
  fs.mkdirSync(examsDir(), { recursive: true });
  fs.writeFileSync(path.join(examsDir(), "fuite-1.tex"), `\\documentclass{article}\n\\begin{document}\n\\nonDefinie ${MARK}\n\\end{document}\n`);
  const logged = t.mock.method(console, "error", () => {});
  const err = await compileExamPdf("fuite-1").then(() => null, (e: Error) => e);
  assert.ok(err, "la compilation devait échouer");
  assert.match(err.message, /^Échec compilation LaTeX/);
  assert.doesNotMatch(err.message, new RegExp(`${MARK}|nonDefinie|Undefined`), err.message);
  assert.ok(logged.mock.calls.some((c) => c.arguments.map(String).join(" ").includes("Undefined control sequence")), "le détail doit rester dans les logs serveur");
});
