/**
 * EXAMEN ÉCRIT FIABLE (chasse aux bugs du 22/11/2026).
 *  - Le LaTeX d'une réponse qui ne double pas ses antislashs n'est plus mutilé : jsonrepair
 *    supprimait l'antislash d'une séquence invalide (« \subq{1.1} Soit \alpha » → « subq{1.1}
 *    Soit alpha »), et un `\underline` rendait toute la réponse illisible.
 *  - L'architecte rédige et révise un exercice avec le budget d'un exercice complet (64 k), pas le
 *    défaut de 16 000 : coupé, il était redemandé trois fois au même budget.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { extractJson } from "../lib/llm/json";

const BS = "\\";

test("JSON : LaTeX aux antislashs non doublés gardé tel quel", () => {
  const raw = `{"statement_tex":"${BS}subq{1.1}{Calcul}{5} Soit ${BS}alpha ${BS}in ${BS}mathbb{R}, ${BS}textbf{x}, ${BS}frac{1}{2}, ${BS}begin{tabular}, ${BS}right)."}`;
  const v = extractJson<{ statement_tex: string }>(raw);
  assert.equal(v.statement_tex, String.raw`\subq{1.1}{Calcul}{5} Soit \alpha \in \mathbb{R}, \textbf{x}, \frac{1}{2}, \begin{tabular}, \right).`);
});

test("JSON : un \\underline ne rend plus la réponse illisible", () => {
  const v = extractJson<{ s: string }>(`{"s":"${BS}underline{x} et ${BS}alpha"}`);
  assert.equal(v.s, String.raw`\underline{x} et \alpha`);
});

test("JSON : dans une telle réponse, \\n, \\\" et \\\\ gardent leur sens", () => {
  const v = extractJson<{ s: string; t: string }>(`{"s":"${BS}alpha${BS}n${BS}"cité${BS}" ${BS}${BS}ok","t":"a${BS}nb"}`);
  assert.equal(v.s, `\\alpha\n"cité" \\ok`);
  assert.equal(v.t, "a\nb");
});

test("JSON : une réponse valide n'est pas réinterprétée (\\t reste une tabulation)", () => {
  assert.equal(extractJson<{ s: string }>(`{"s":"a${BS}tb ${BS}${BS}alpha"}`).s, "a\tb \\alpha");
});

test("JSON : réparée par jsonrepair (guillemet non échappé), le LaTeX garde ses antislashs", () => {
  const v = extractJson<{ s: string }>(`Voici : {"s":"${BS}alpha ${BS}beta "non échappé" fin"}`);
  assert.equal(v.s, String.raw`\alpha \beta "non échappé" fin`);
});

// ── Architecte : budget de rédaction et de révision ─────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-examen-ecrit-fiable-"));
Object.assign(process.env, {
  CORTEX_DATA_DIR: tmp, LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test",
  LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
});
const DESIGN = { misconception: "m", edge_case: "e", reasoning_chain: ["a"], bookkeeping: "b", discriminator: "d", awkward_numbers: "37", subquestion_plan: ["a"] };
const WRITTEN = { category: "General", concept: "Arbres", statement_tex: "Énoncé.", solution_tex: "Corrigé.", points: 20 };
const AUDIT_WEAK = { pattern_matcher_answer: "x", pattern_matcher_correct: true, strong_student_answer: "y", strong_student_stuck: false, rubric_misses: [], trap_present: false, hardening: "durcir", verdict: "too_easy" };
type Kind = "design" | "write" | "revise" | "audit" | "other";
const calls: Array<{ kind: Kind; max_tokens: number }> = [];
let cutWrite = false;
let llm: http.Server;

const kindOf = (content: string): Kind =>
  /"edge_case"/.test(content) ? "design"
    : /"pattern_matcher_answer"/.test(content) ? "audit"
      : /CORRIGÉ ACTUEL/.test(content) ? "revise"
        : /"statement_tex"/.test(content) ? "write" : "other";

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { max_tokens: number; messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      const kind = kindOf(content);
      calls.push({ kind, max_tokens: parsed.max_tokens });
      const cut = kind === "write" && cutWrite;
      const reply = kind === "design" ? DESIGN : kind === "audit" ? AUDIT_WEAK : kind === "write" || kind === "revise" ? WRITTEN : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { content: cut ? '{"category":"General","statement_tex":"\\\\subq{1.1}' : JSON.stringify(reply) }, finish_reason: cut ? "length" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { calls.length = 0; cutWrite = false; });

after(() => {
  llm.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function architect() {
  const { runWithCourse } = await import("../db/client");
  const { architectQuestion } = await import("../lib/architect");
  const { getProfile } = await import("../lib/course-profile");
  return runWithCourse("cs-202", () => architectQuestion(getProfile("cs-202").archetypes[0], "arbres binaires de recherche", 20, { maxRounds: 1 }));
}

test("architecte : rédaction et révision au budget d'un exercice complet (64 k), pas au défaut de 16 000", async () => {
  const { EXAM_OUTPUT_MAX_TOKENS } = await import("../lib/llm");
  await architect();
  const write = calls.filter((c) => c.kind === "write");
  const revise = calls.filter((c) => c.kind === "revise");
  assert.equal(write.length, 1);
  assert.equal(revise.length, 1, "l'audit faible déclenche une révision");
  assert.deepEqual([write[0].max_tokens, revise[0].max_tokens], [EXAM_OUTPUT_MAX_TOKENS, EXAM_OUTPUT_MAX_TOKENS]);
});

test("architecte : rédaction coupée → échec après UN appel (pas trois fois la même demande)", async () => {
  cutWrite = true;
  await assert.rejects(architect(), (e: unknown) => (e as { code?: string }).code === "TRUNCATED");
  assert.equal(calls.filter((c) => c.kind === "write").length, 1);
});
