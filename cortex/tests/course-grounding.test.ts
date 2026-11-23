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

test("matière d'un item : la diapo des enseignants retirée, le reste de la séance gardé ; une archive ne garde rien", async () => {
  const { courseMatter } = await import("../lib/source-scope");
  const seance = "# Présentation des enseignants\n\nDomaines de recherche : Marc Martin — théorie des organisations appliquée.\n\nLe leadership, c'est la mobilisation de plusieurs personnes vers un objectif commun.";
  assert.equal(courseMatter(seance), "Le leadership, c'est la mobilisation de plusieurs personnes vers un objectif commun.");
  assert.equal(courseMatter("Le marché biface met en relation producteurs et consommateurs."), "Le marché biface met en relation producteurs et consommateurs.");
  assert.equal(courseMatter("> Archive 2025-26 (Durand 2025) — hors programme 2026.\n\nSouveraineté numérique."), "");
});

test("recherche dans tout le corpus : accents, pluriels et flexions trouvés ; archives, annales et diapo des enseignants jamais montrées", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { corpusWindows } = await import("../lib/course-grounding");
  await runWithCourse("fictif", async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const add = async (type: string, title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
    };
    const filler = "Le numérique transforme les organisations. ".repeat(60);
    await add("course_pdf", "S_ance_3_Martin_Entreprises.md", `${filler}Ces exemples illustrent un modèle d'affaires basé sur des marchés bifaces, qui mettent en relation des producteurs et des consommateurs. ${filler}`);
    await add("course_pdf", "S_ance_1_Martin_Leadership.md", "# Présentation des enseignants\n\nDomaines de recherche : Marc Martin, théorie des organisations.\n\nLe leadership mobilise plusieurs personnes.");
    await add("course_pdf", "Archive_2025-26_Exemple_de_r_sum_et_bibliographie_attendu_du_rendu_poster.md", "Rewilding par clonage et rétroaction du pergélisol : exemple de résumé.");
    await add("final", "Examen 2025", "Un marché biface relie producteurs et consommateurs : vrai ou faux ?");
    const biface = await corpusWindows(["plateforme biface producteurs consommateurs"], { cap: 400 });
    assert.equal(biface.length, 1, JSON.stringify(biface));
    assert.match(biface[0].text, /marchés bifaces/);
    assert.equal(biface[0].src, "S_ance_3_Martin_Entreprises.md");
    assert.deepEqual(await corpusWindows(["rewilding par clonage"]), [], "archive jamais montrée");
    assert.deepEqual(await corpusWindows(["domaines de recherche Martin théorie organisations"]), [], "diapo des enseignants jamais montrée");
  });
});

test("chiffres porteurs : pourcentages, années et entiers trouvés dans le cours ; un chiffre d'archive ne compte pas", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { absentCourseNumbers, factNumbers } = await import("../lib/course-grounding");
  assert.deepEqual(factNumbers("Hausse de 14 % (34 % chez les novices), étude de 2023, 0,55 crédit, 3 groupes."), ["14", "34", "2023"]);
  await runWithCourse("cs-202", async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const add = async (title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", title, `course_pdf/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", title, text);
    };
    await add("S_ance_2_Martin.md", "Svenson (1981) : 93 % des conducteurs s'estiment plus habiles que la moyenne.");
    await add("Archive_2025-26_Th\u00e8mes_des_posters_2024.md", "Poster 2024 : 61 % de faux positifs.");
    assert.deepEqual(await absentCourseNumbers(["93", "1981", "61", "14"]), ["61", "14"]);
  });
});

test("extraits du QCM, du drill et de check-solution (suite de #202) : la théorie loin dans un support, et deux notions d'un même support, sont montrées", async () => {
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { coursePassages } = await import("../lib/course-grounding");
  await runWithCourse("fictif", async () => {
    ensureFts();
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    // Banc rs-composite du 22/11 : l'en-tête du support (le notebook) reprend le nom du chapitre,
    // la théorie n'arrive qu'après 900 caractères.
    const title = "Safety 2 - content recommendation";
    const notebook = Array.from({ length: 14 }, (_, i) => `Safety 2 cell ${i}: df.sort_values("likes").head(${i + 2}) prints the least liked memes.`).join(" ");
    const loop = "A feedback loop happens when the recommender's output becomes its next input and amplifies the user's drift.";
    const theory = "Malinformation is genuine content shared out of context to cause harm, unlike disinformation (false and deliberate).";
    const text = `${title}. ${loop} ${notebook} Theory. ${theory}`;
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", title, `course_pdf/${title}`, null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", title, text);
    await indexItemForSearch(iid, sid, title, text);
    // Un sujet de QCM qui porte le nom du chapitre : la fenêtre se calait sur le titre.
    const one = await coursePassages(["Safety 2: malinformation versus disinformation"]);
    assert.ok(one.some((p) => p.text.includes("Malinformation is genuine content")), JSON.stringify(one));
    // Deux sujets servis par le même support : le second n'en recevait plus rien.
    const two = await coursePassages(["feedback loop recommender amplifies", "malinformation genuine content out of context"]);
    assert.ok(two.some((p) => p.text.includes("feedback loop happens")), JSON.stringify(two));
    assert.ok(two.some((p) => p.text.includes("Malinformation is genuine content")), JSON.stringify(two));
  });
});

test("budget d'extraits : chaque requête reçoit son meilleur extrait avant qu'une autre n'en reçoive un second", async () => {
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { evidencePassages } = await import("../lib/course-grounding");
  await runWithCourse("ml", async () => {
    ensureFts();
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const filler = (w: string) => Array.from({ length: 20 }, (_, i) => `${w} example ${i} of the chapter.`).join(" ");
    for (const [title, w] of [["Week 1 - utilitarianism", "utilitarianism"], ["Week 2 - deontology", "deontology"], ["Week 3 - virtue ethics", "virtue"]]) {
      // Deux pages par support : la requête a de quoi remplir deux extraits.
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", title, `course_pdf/${title}`, null, 1);
      for (const page of [1, 2]) {
        const text = `${title}, page ${page}. ${filler(w)}`;
        const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", title, text);
        await indexItemForSearch(iid, sid, title, text);
      }
    }
    // Lot QCM de 3 notions, 2 extraits de 300 caractères chacune, budget de 3 extraits : la dernière
    // notion du lot n'en recevait aucun, les deux premières ayant tout pris.
    const got = await evidencePassages(["utilitarianism", "deontology", "virtue"], { perQuery: 2, cap: 300, budget: 900 });
    assert.deepEqual([...new Set(got.map((p) => p.src))].sort(), ["Week 1 - utilitarianism", "Week 2 - deontology", "Week 3 - virtue ethics"], JSON.stringify(got.map((p) => p.src)));
  });
});

test("revue : plages déjà montrées au milieu d'une fenêtre, ou données dans le désordre : jamais montrées deux fois", async () => {
  const { freshSpan } = await import("../lib/course-grounding");
  const flat = `${"alphazone note. ".repeat(12)}${"betazone note. ".repeat(12)}${"gammazone note. ".repeat(12)}`;
  const beta = flat.indexOf("betazone");
  const gamma = flat.indexOf("gammazone");
  // Une plage montrée au milieu (la zone beta) : le segment neuf le plus riche, sans elle.
  const mid = freshSpan(flat, "alphazone gammazone", 0, flat.length, [[beta, gamma]])!;
  assert.ok(mid[1] <= beta || mid[0] >= gamma, `recouvre la plage montrée : ${mid}`);
  // Deux plages dans le désordre, l'une dans l'autre au début : même résultat que dans l'ordre.
  const a = freshSpan(flat, "gammazone", 0, flat.length, [[60, beta], [0, 100]]);
  const b = freshSpan(flat, "gammazone", 0, flat.length, [[0, 100], [60, beta]]);
  assert.deepEqual(a, b);
  assert.ok(a![0] >= beta, `${a}`);
  // Tous les mots de la requête déjà montrés : rien de neuf.
  assert.equal(freshSpan(flat, "betazone", 0, flat.length, [[beta, gamma]]), null);
});
