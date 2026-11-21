/**
 * CORÉEN, HÉBREU ET ARABE DANS LE PDF (reste de #165, audit « formats » du 16/11/2026). Le PDF
 * imprimait le cyrillique, le grec et le chinois, mais les lettres hangul, hébraïques et arabes
 * sortaient en blanc : aucune police chargée ne les couvrait. L'hébreu et l'arabe s'écrivent en
 * plus de droite à gauche : sans bidi, chaque mot est juste mais la phrase se lit à l'envers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pdf-rtl-"));
process.env.CORTEX_DATA_DIR = tmp;
after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Un cours fictif par écriture, nommé dans sa langue : le titre du cours s'imprime dans l'en-tête,
 * hors du corps. Langue « auto » : la langue déclarable ne connaît ni le coréen, ni l'hébreu, ni l'arabe.
 */
const NAMES = { ko: "함수 해석학 입문", he: "מבוא לחשבון אינפיניטסימלי", ar: "مقدمة في التحليل" } as const;
const courses: Record<keyof typeof NAMES, string> = { ko: "", he: "", ar: "" };

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  for (const [k, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
    const row = buildCourseRow({ name, code: `FIC-3${Object.keys(NAMES).indexOf(k)}1`, university: "Université fictive", language: "auto" }, "owner");
    await insertCourse(row);
    courses[k] = row.id;
  }
  await reloadCourses();
});

/** Marques de direction que pdftotext insère autour d'un passage de droite à gauche. */
const BIDI_MARKS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Le texte du PDF d'un QCM (énoncé), tel que pdftotext le relit ; null si l'outillage manque. */
async function qcmPdfText(t: TestContext, course: string, examId: number, stems: [string, string[]][]): Promise<string | null> {
  const { texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) { t.skip("tectonic/pdflatex absent"); return null; }
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("pdftotext", ["-v"]).error) { t.skip("pdftotext absent"); return null; }
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { examsDir } = await import("../lib/paths");
  const items = stems.map(([stem, options]) => ({ topic: "T", type: "scq" as const, stem, options, correct: [0], misconceptions: ["", "", "", ""], explanation: options[0], verified: 1 as const }));
  // Le dossier des examens dépend du cours : le chemin se lit dans son contexte.
  const { out, pdf } = await runWithCourse(course, async () => {
    const out = await buildQcmArtifact(examId, { items, open: [] }, "2026-11-21");
    return { out, pdf: path.join(examsDir(), out.file) };
  });
  assert.equal(out.texError, undefined, out.texError);
  return spawnSync("pdftotext", ["-enc", "UTF-8", pdf, "-"], { encoding: "utf8" }).stdout.replace(BIDI_MARKS, "").replace(/\s+/g, " ");
}

test("un QCM d'un cours en coréen imprime ses lettres hangul", async (t) => {
  const text = await qcmPdfText(t, courses.ko, 4301, [["어떤 함수가 연속입니까?", ["사인 함수", "탄젠트 함수", "함수 1/x", "로그 함수"]]]);
  if (text === null) return;
  for (const s of ["어떤 함수가 연속입니까", "사인 함수", "로그 함수", NAMES.ko]) assert.ok(text.includes(s), `${s} absent du PDF`);
});

/** La phrase lue mot à mot à l'envers : ce que pdftotext relit quand le PDF pose les mots de gauche à droite. */
const reversedWords = (s: string) => s.split(" ").reverse().join(" ");
/**
 * Comparaison sans les espaces : pdftotext en ajoute dans un mot arabe après une lettre qui ne se
 * lie pas à la suivante (« اللوغار يتم ») ; l'ordre des mots, lui, reste visible.
 */
const has = (text: string, s: string) => text.replace(/ /g, "").includes(s.replace(/ /g, ""));

test("un QCM d'un cours en hébreu imprime ses lettres, ses mots dans l'ordre de lecture", async (t) => {
  const stem = "איזו פונקציה רציפה";
  const text = await qcmPdfText(t, courses.he, 4302, [[`${stem}?`, ["פונקציית הסינוס", "פונקציית הטנגנס", "הפונקציה 1/x", "פונקציית הלוגריתם"]]]);
  if (text === null) return;
  for (const s of [stem, "פונקציית הסינוס", "פונקציית הלוגריתם", NAMES.he]) {
    assert.ok(has(text, s), `${s} absent du PDF`);
    assert.ok(!has(text, reversedWords(s)), `${s} imprimé à l'envers`);
  }
});

test("un QCM d'un cours en arabe imprime ses lettres, ses mots dans l'ordre de lecture", async (t) => {
  const stem = "أي دالة متصلة";
  const text = await qcmPdfText(t, courses.ar, 4303, [[`${stem}؟`, ["دالة الجيب", "دالة الظل", "الدالة 1/x", "دالة اللوغاريتم"]]]);
  if (text === null) return;
  for (const s of [stem, "دالة الجيب", "دالة اللوغاريتم", NAMES.ar]) {
    assert.ok(has(text, s), `${s} absent du PDF`);
    assert.ok(!has(text, reversedWords(s)), `${s} imprimé à l'envers`);
  }
});

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test("une phrase en hébreu garde dans son passage la formule et le nombre qui la terminent", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const out = withUnicodeFonts(doc("\\item הפונקציה $f(x)$ רציפה בשנת 2024"));
  assert.match(out, /\\item \\CortexRL\{\\CortexHe\{הפונקציה\} \\CortexLR\{\$f\(x\)\$\} \\CortexHe\{רציפה בשנת\} \\CortexLR\{2024\}\}/);
  assert.match(out, /\\newfontfamily\\CortexHebrew[\s\S]*\\begin\{document\}/);
  assert.doesNotMatch(out, /CortexArabic|Hangul/, "seules les polices de l'écriture présente");
});

test("des mots hébreux cités dans une phrase française restent chacun un passage", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const out = withUnicodeFonts(doc("Le mot שלום et le mot עולם, \\textbf{en gras}."));
  assert.match(out, /Le mot \\CortexRL\{\\CortexHe\{שלום\}\} et le mot \\CortexRL\{\\CortexHe\{עולם\}\}, \\textbf\{en gras\}\./);
});

test("le libellé d'une option et la mise en forme ne décident pas du sens d'une phrase arabe", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const out = withUnicodeFonts(doc("\\textbf{C.}~الدالة \\textbf{المتصلة} 1/x"));
  assert.match(out, /\\textbf\{C\.\}~\\CortexRL\{\\CortexAr\{الدالة\} \\textbf\{\\CortexAr\{المتصلة\}\} \\CortexLR\{1\/x\}\}/);
  assert.match(out, /\\newfontfamily\\CortexArabic/);
});

test("crochets d'argument, parenthèses et espaces en macro restent à leur place", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const cases: [string, string][] = [
    // Le « ] » d'un argument optionnel reste hors du passage : l'argument se ferme.
    ["\\item[א.] שאלה", "\\item[\\CortexRL{\\CortexHe{א.}}] \\CortexRL{\\CortexHe{שאלה}}"],
    // Les deux parenthèses dans le passage, que la police retourne ensemble.
    ["(שלום) עולם", "\\CortexRL{\\CortexHe{(שלום) עולם}}"],
    // Un mot cité : ses parenthèses le suivent, la virgule reste à la phrase française.
    ["Le mot (שלום), puis עולם, enfin.", "Le mot \\CortexRL{\\CortexHe{(שלום)}}, puis \\CortexRL{\\CortexHe{עולם}}, enfin."],
    // « \quad » ne coupe pas la phrase, la formule qui le suit en fait partie.
    ["נתון\\quad$x>0$ כאן", "\\CortexRL{\\CortexHe{נתון}\\quad\\CortexLR{$x>0$} \\CortexHe{כאן}}"],
    // \lstinline{…} est du code, même entre accolades.
    ["\\lstinline{a[i]} שלום {b}", "\\lstinline{a[i]} \\CortexRL{\\CortexHe{שלום}} {b}"],
  ];
  for (const [body, want] of cases) assert.ok(withUnicodeFonts(doc(body)).includes(`\n${want}\n`), body);
});

test("code et commentaires en hébreu ne sont pas balisés", async () => {
  const { withUnicodeFonts } = await import("../lib/exam-latex");
  const code = "\\begin{lstlisting}\nprint('שלום')\n\\end{lstlisting}";
  const out = withUnicodeFonts(doc(`${code}\n% הערה\nשלום`));
  assert.ok(out.includes(code));
  assert.ok(out.includes("% הערה\n\\CortexRL{\\CortexHe{שלום}}"));
});

test("pdflatex reçoit le source d'origine, sans polices ni balisage", async () => {
  const { withUnicodeFonts, withoutUnicodeFonts } = await import("../lib/exam-latex");
  for (const body of ["הפונקציה $f(x)$ רציפה 2024", "\\textbf{C.}~الدالة \\textbf{المتصلة} 1/x", "어떤 함수 哪个", "Le mot שלום."]) {
    assert.equal(withoutUnicodeFonts(withUnicodeFonts(doc(body))), doc(body), body);
  }
  assert.match(withUnicodeFonts(doc("어떤 함수")), /\\usepackage\{xeCJK\}[\s\S]*Hangul=/);
  assert.equal(withUnicodeFonts(doc("Énoncé : coût")), doc("Énoncé : coût"), "Latin-1 : rien ne change");
});

test("un examen écrit en hébreu (listes, gras, formules, pied de page) compile et se lit dans l'ordre", async (t) => {
  const { texAvailable, compileExamPdf } = await import("../lib/exam-latex");
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("pdftotext", ["-v"]).error) return t.skip("pdftotext absent");
  const { examsDir } = await import("../lib/paths");
  const { runWithCourse } = await import("../db/client");
  const body = "\\begin{enumerate}\n\\item הוכיחו כי \\textbf{הפונקציה} $f(x)=x^2$ רציפה.\n\\item חשבו את הגבול\n\\end{enumerate}";
  const text = await runWithCourse(courses.he, async () => {
    fs.mkdirSync(examsDir(), { recursive: true });
    // Le pied de page vient du préambule (layoutChrome y pose le nom du cours), hors du corps.
    const chrome = `\\usepackage{fancyhdr}\\pagestyle{fancy}\\fancyfoot[C]{${NAMES.he}}\n`;
    fs.writeFileSync(path.join(examsDir(), "ecrit-he.tex"), doc(body).replace("\\begin{document}", `${chrome}\\begin{document}`));
    const pdf = await compileExamPdf("ecrit-he");
    return spawnSync("pdftotext", ["-enc", "UTF-8", path.join(examsDir(), pdf), "-"], { encoding: "utf8" }).stdout.replace(BIDI_MARKS, "");
  });
  for (const s of ["הוכיחו כי", "חשבו את הגבול", NAMES.he]) {
    assert.ok(has(text, s), `${s} absent du PDF`);
    assert.ok(!has(text, reversedWords(s)), `${s} imprimé à l'envers`);
  }
});
