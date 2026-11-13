import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

test("architecture : aucun chemin de production ne contourne le point d'entrée LLM gardé", () => {
  const roots = ["app", "lib", "scripts"];
  const offenders: string[] = [];
  for (const file of roots.flatMap(files)) {
    const rel = file.replaceAll(path.sep, "/");
    const source = fs.readFileSync(file, "utf8");
    if (/llm\/providers\//.test(source) && !rel.startsWith("lib/llm/")) offenders.push(rel);
    if (/\brunClaudeCodeRaw\b/.test(source) && rel !== "lib/claude-code.ts" && rel !== "lib/llm/providers/claude-code.ts") offenders.push(rel);
  }
  assert.deepEqual([...new Set(offenders)], [], `contournements provider : ${offenders.join(", ")}`);

  const entry = fs.readFileSync("lib/llm/index.ts", "utf8");
  const guard = entry.indexOf("await assertLlmAuthorized()");
  const provider = entry.indexOf("provider.complete(req)");
  assert.ok(guard >= 0 && provider > guard, "la garde doit précéder tout appel provider");
});

test("architecture : le paywall précède les contraintes gratuites d'un examen", () => {
  const generation = fs.readFileSync("lib/generation.ts", "utf8");
  const paywall = generation.indexOf("await preflightGeneration(type)");
  const examPlan = generation.indexOf("planMockExam(");
  assert.ok(paywall >= 0 && examPlan > paywall, "un compte sans crédit doit recevoir 402 avant une éventuelle erreur de format");
});
