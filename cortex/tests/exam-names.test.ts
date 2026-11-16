/**
 * Un seul classifieur de noms d'annales, multilingue (audit ingestion du 16/11/2026) : import de
 * dossier, ingestion des annales et index des examens. Noms fictifs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFile } from "../lib/import-folder";
import { pickEnonces } from "../lib/exam-index";
import { inferExamMeta } from "../lib/sources";

test("les annales nommées hors « final/midterm + année » sont reconnues, en plusieurs langues", () => {
  const cases: [string, "final" | "midterm", number | null][] = [
    ["Examen_2023.pdf", "final", 2023],
    ["Klausur_WS2023.pdf", "final", 2023],
    ["Pruefung_2024.pdf", "final", 2024],
    ["Prüfung_2024.pdf", "final", 2024],
    ["Parcial_2023.pdf", "midterm", 2023],
    ["esame_2022.pdf", "final", 2022],
    ["tentamen-2021.pdf", "final", 2021],
    ["exam1.pdf", "final", null],
    ["Final2023.pdf", "final", 2023],
    ["midterm1_2022.pdf", "midterm", 2022],
    ["past_paper_2021.pdf", "final", 2021],
    ["Exams/2022.pdf", "final", 2022],
    ["final-ws23.pdf", "final", 2023],
    ["quiz_2023.pdf", "midterm", 2023],
    ["partiel_2022.pdf", "midterm", 2022],
  ];
  for (const [name, kind, year] of cases) {
    assert.deepEqual(classifyFile(name), { bucket: "refs", type: kind, year }, name);
  }
});

test("un projet ou une révision « final » n'est pas une annale", () => {
  assert.notEqual(classifyFile("final-project-2024.pdf").bucket, "refs");
  assert.notEqual(classifyFile("final_report_2023.pdf").bucket, "refs");
});

test("l'annale enregistrée a le même type que celui du classement (partiel = midterm)", () => {
  assert.deepEqual(inferExamMeta("partiel_2022.pdf"), { kind: "midterm", year: 2022 });
  assert.deepEqual(inferExamMeta("Parcial_2023.pdf"), { kind: "midterm", year: 2023 });
  assert.deepEqual(inferExamMeta("final-ws23.pdf"), { kind: "final", year: 2023 });
});

test("un corrigé allemand ou espagnol n'évince plus l'énoncé, et un corrigé sans année est écarté", () => {
  const rows = (paths: [string, number | null][]) => paths.map(([p, year]) => ({ path: `refs/${p}`, title: p.replace(/\.pdf$/, ""), year }));
  assert.deepEqual(pickEnonces(rows([["final_2023.pdf", 2023], ["final_2023_Musterloesung.pdf", 2023]])).map((r) => r.path), ["refs/final_2023.pdf"]);
  assert.deepEqual(pickEnonces(rows([["final_2023_solucion.pdf", 2023], ["final_2023.pdf", 2023]])).map((r) => r.path), ["refs/final_2023.pdf"]);
  assert.deepEqual(pickEnonces(rows([["Final_Exam.pdf", null], ["Final_Exam_Solutions.pdf", null]])).map((r) => r.path), ["refs/Final_Exam.pdf"]);
  // Un corrigé seul reste pris : c'est tout ce qu'on a de cette épreuve.
  assert.deepEqual(pickEnonces(rows([["Klausur_2020_Loesung.pdf", 2020]])).map((r) => r.path), ["refs/Klausur_2020_Loesung.pdf"]);
});
