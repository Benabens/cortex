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
import { architectExercise } from "../lib/architect";
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
  const step = (s: string, p: number) => console.log(`  ${p}% ${s}`);
  // apres = pipeline ARCHITECTE (capture le journal d'audit adversarial pour la preuve).
  // avant = voie mono-passe historique (ne PAS router via l'architecte même si cs-202).
  let auditLog: unknown[] = [];
  let out: { id: number; url: string };
  if (mode === "apres") {
    const r = await architectExercise(target, { onStep: step });
    out = { id: r.id, url: r.url };
    auditLog = r.auditLog;
  } else {
    out = await generateTargetedExercise(target, { onStep: step });
  }
  const q = sqlite
    .prepare(`SELECT concept, statement_html statement_tex, solution_html solution_tex, verified, verify_issue FROM exam_questions WHERE exam_id = ?`)
    .get(out.id) as any;
  const dir = path.join(process.cwd(), "data", "refs", "proof");
  fs.mkdirSync(dir, { recursive: true });
  const rec = { slug, mode, target, examId: out.id, url: out.url, seconds: Math.round((Date.now() - t0) / 1000), ...q, auditLog };
  fs.writeFileSync(path.join(dir, `${slug}.${mode}.json`), JSON.stringify(rec, null, 2));
  console.log(`[${mode}/${slug}] OK → exam #${out.id} (${rec.seconds}s) · verified=${q?.verified} · audits=${auditLog.length} · proof/${slug}.${mode}.json`);
}

main().catch((e) => { console.error("ÉCHEC:", e); process.exit(1); });
