/**
 * QUESTIONS COMPOSÉES À LA FORME DE L'ANNALE (audit du 16/11/2026, axe 3 P1-12). Chaque bloc devait
 * mêler un choix unique à 4 options et une réponse courte, et le code était toujours du Python : une
 * annale dont les questions composées sont des lectures de code Java et des réponses courtes, ou des
 * choix à 5 options, n'était pas reproductible. Le profil de l'annale dit maintenant les types de
 * sous-questions, le langage du code et le nombre d'options ; le mélange reste le défaut. Profils fictifs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import type { FormatProfile } from "../lib/format";

process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-blocs-forme-"));

let blocksOf: typeof import("../lib/exam-format").blocksOf;
let planMockExam: typeof import("../lib/exam-format").planMockExam;
let blockIssue: typeof import("../lib/blocks").blockIssue;

before(async () => {
  ({ blocksOf, planMockExam } = await import("../lib/exam-format"));
  ({ blockIssue } = await import("../lib/blocks"));
});

const profile = (composite: Record<string, unknown>, extra: Partial<FormatProfile> = {}) => ({
  format_summary: "3 questions composées", has_mcq: true, total_points: 30, options_per_question: null,
  sections: [{ name: "Q1", description: "" }, { name: "Q2", description: "" }, { name: "Q3", description: "" }],
  composite: { block_count: 3, parts_min: 3, parts_max: 4, ...composite }, ...extra,
}) as Parameters<typeof blocksOf>[0];

const short = (prompt = "Why?") => ({ kind: "short", prompt, code: "", options: [], correct: -1, answer: "Because.", criteria: [{ label: "Names it", points: 2 }], points: 2, explanation: "" });
const code = { kind: "code_output", prompt: "What does it print?", code: "System.out.println(1 + 2);", options: [], correct: -1, answer: "3", criteria: [], points: 2, explanation: "" };
const scq = (n: number) => ({ kind: "scq", prompt: "Which one?", code: "", options: Array.from({ length: n }, (_, i) => `option ${i}`), correct: 0, answer: "", criteria: [], points: 1, explanation: "" });

test("le profil de l'annale porte ses types de sous-questions, son langage de code et son nombre d'options", () => {
  const b = blocksOf(profile({ part_kinds: ["short", "code_output", "bogus"], code_language: " Java " }, { options_per_question: 5 }));
  assert.deepEqual([b?.kinds, b?.codeLanguage, b?.options], [["short", "code_output"], "java", 5]);
  // Sans ces champs (profils détectés avant) : rien de déclaré, le générateur garde son mélange par défaut.
  const old = blocksOf(profile({}));
  assert.deepEqual([old?.kinds, old?.codeLanguage, old?.options], [undefined, undefined, undefined]);
});

test("une annale de lectures de code et de réponses courtes, sans QCM, reste un format à questions composées", () => {
  const b = blocksOf(profile({ part_kinds: ["short", "code_output"], code_language: "c" }, { has_mcq: false }));
  assert.equal(b?.count, 3);
  // Des problèmes à sous-questions sans code ni QCM restent des exercices.
  assert.equal(blocksOf(profile({ part_kinds: ["short"] }, { has_mcq: false })), null);
});

test("le plan de l'examen transmet la forme des sous-questions au générateur", () => {
  const blocks = { sections: [], partsMin: 3, partsMax: 4, totalPoints: null, kinds: ["short", "code_output"] as const, codeLanguage: "java" };
  const plan = planMockExam({ basis: "annales", kind: "composite", questionCount: 3, openCount: null, durationMin: null, language: "en", discipline: "stem", summary: "", evidence: [], blocks: { ...blocks, kinds: [...blocks.kinds] } }, {});
  assert.equal(plan.generator, "blocks");
  assert.deepEqual(plan.generator === "blocks" ? [plan.kinds, plan.codeLanguage] : null, [["short", "code_output"], "java"]);
});

test("un bloc aux types de l'annale est accepté, un type absent de l'annale est renvoyé au modèle", () => {
  const shape = { kinds: ["short", "code_output"] as ("short" | "code_output")[] };
  assert.equal(blockIssue({ scenario: "S", parts: [short(), code, short("How?")] }, 3, 4, shape), null);
  assert.match(blockIssue({ scenario: "S", parts: [short(), code, scq(4)] }, 3, 4, shape) ?? "", /scq/);
  // Deux types dans l'annale : un bloc qui n'en emploie qu'un ne la reproduit pas.
  assert.match(blockIssue({ scenario: "S", parts: [short(), short("How?"), short("When?")] }, 3, 4, shape) ?? "", /mêle/);
  // Un seul type dans l'annale : trois réponses courtes conviennent.
  assert.equal(blockIssue({ scenario: "S", parts: [short(), short("How?"), short("When?")] }, 3, 4, { kinds: ["short"] }), null);
  // Rien de déclaré : le mélange par défaut reste exigé.
  assert.match(blockIssue({ scenario: "S", parts: [short(), short("How?"), short("When?")] }, 3, 4) ?? "", /mêle les types/);
});

test("un choix unique a le nombre d'options de l'annale", () => {
  assert.equal(blockIssue({ scenario: "S", parts: [scq(5), short(), short("How?")] }, 3, 4, { options: 5 }), null);
  assert.match(blockIssue({ scenario: "S", parts: [scq(4), short(), short("How?")] }, 3, 4, { options: 5 }) ?? "", /5 options/);
});
