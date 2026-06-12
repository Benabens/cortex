/**
 * Harnais de PREUVE difficulté (V3) : capture un exercice ciblé généré pour un slug donné,
 * dans l'état COURANT du moteur (AVANT = ancien moteur, APRÈS = nouveau), et dump le couple
 * énoncé/corrigé en JSON committable + note l'id de l'exam (PDF dans data/exams).
 *
 *   npx tsx scripts/difficulty-ab.ts <avant|apres> <slug> "<target>"
 *
 * Le JSON va dans data/refs/proof/<slug>.<mode>.json (committé → A/B reproductible).
 */
import { enterCourse, sqlite } from "../db/client";
import { generateTargetedExercise } from "../lib/exam";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const [mode, slug, target] = process.argv.slice(2);
  if (!mode || !slug || !target) {
    console.error('usage: difficulty-ab.ts <avant|apres> <slug> "<target>"');
    process.exit(1);
  }
  enterCourse("cs-202");
  const t0 = Date.now();
  console.log(`[${mode}/${slug}] génération : ${target}`);
  const out = await generateTargetedExercise(target, { onStep: (s, p) => console.log(`  ${p}% ${s}`) });
  const q = sqlite
    .prepare(`SELECT concept, statement_html statement_tex, solution_html solution_tex, verified, verify_issue FROM exam_questions WHERE exam_id = ?`)
    .get(out.id) as any;
  const dir = path.join(process.cwd(), "data", "refs", "proof");
  fs.mkdirSync(dir, { recursive: true });
  const rec = { slug, mode, target, examId: out.id, url: out.url, seconds: Math.round((Date.now() - t0) / 1000), ...q };
  fs.writeFileSync(path.join(dir, `${slug}.${mode}.json`), JSON.stringify(rec, null, 2));
  console.log(`[${mode}/${slug}] OK → exam #${out.id} (${rec.seconds}s) · verified=${q?.verified} · proof/${slug}.${mode}.json`);
}

main().catch((e) => { console.error("ÉCHEC:", e); process.exit(1); });
