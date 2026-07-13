/**
 * PREUVE « image → exo neuf » + qualité architecte (NEXT_STEP_EXO_IMAGE_QUALITE).
 *   npx tsx scripts/exo-image-proof.ts text  <slug> "<target>"
 *   npx tsx scripts/exo-image-proof.ts image <slug> "<image-path>" ["<note>"]
 * Dump : data/refs/proof/exo-<slug>.json (énoncé/corrigé + audit adversarial + examId).
 */
import { enterCourse } from "../db/client";
import { q } from "../db/q";
import { architectExercise } from "../lib/architect";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const [kind, slug, arg, note] = process.argv.slice(2);
  if (!kind || !slug || !arg) {
    console.error('usage: exo-image-proof.ts <text|image> <slug> "<target|image-path>" ["<note>"]');
    process.exit(1);
  }
  enterCourse("cs-202");
  const t0 = Date.now();
  const step = (s: string, p: number) => console.log(`  ${p}% ${s}`);
  console.log(`[${kind}/${slug}] ${kind === "image" ? "image=" + arg : "target=" + arg}`);
  const r = kind === "image"
    ? await architectExercise("", { onStep: step, image: arg, note: note || undefined })
    : await architectExercise(arg, { onStep: step });
  const row = await q.get<any>(`SELECT concept, statement_html statement_tex, solution_html solution_tex, verified, verify_issue FROM exam_questions WHERE exam_id = ?`, r.id);
  const dir = path.join(process.cwd(), "data", "refs", "proof");
  fs.mkdirSync(dir, { recursive: true });
  const rec = { slug, kind, source: arg, note: note || null, examId: r.id, url: r.url, seconds: Math.round((Date.now() - t0) / 1000), ...row, auditLog: r.auditLog };
  fs.writeFileSync(path.join(dir, `exo-${slug}.json`), JSON.stringify(rec, null, 2));
  const pm = (r.auditLog as any[]).map((a) => a.pattern_matcher_correct);
  console.log(`[${kind}/${slug}] OK → exam #${r.id} (${rec.seconds}s) · verified=${row?.verified} · audits=${r.auditLog.length} · pm_correct=${JSON.stringify(pm)} · proof/exo-${slug}.json`);
}

main().catch((e) => { console.error("ÉCHEC:", e); process.exit(1); });
