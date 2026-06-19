/**
 * Harnais d'éval (interne, lecture seule) — CHIFFRE la justesse du vrai moteur.
 *
 *   npm run eval -- --course=algo [--limit 12] [--build] [--no-disc] [--disc 2]
 *
 * - construit le gold set depuis les corrigés si absent (ou --build),
 * - résout chaque item à l'aveugle (lib/verify) + juge (déterministe/LLM, bucket incertain),
 * - mesure discrimination (audit adversarial) + style (format),
 * - écrit un `eval_runs` + un rapport data/refs/proof/evals/<course>-<date>.md.
 */
import { enterCourse } from "@/db/client";
import { normalizeCourse } from "@/lib/courses";
import { buildGoldSet, buildReport, ensureEvalSchema, measureDiscrimination, measureStyleHeuristic, recordRun, runAccuracy } from "@/lib/eval";
import { sqlite } from "@/db/client";
import fs from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

async function main() {
  const course = normalizeCourse(arg("course"));
  enterCourse(course);
  ensureEvalSchema();
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const forceBuild = arg("build") !== undefined;
  const discN = arg("no-disc") !== undefined ? 0 : Number(arg("disc") ?? 2);
  const step = (s: string, p: number) => console.log(`  [${String(p).padStart(3)}%] ${s}`);

  console.log(`▶ eval — cours « ${course} » (prompt-version eval-v1)`);

  // gold set
  let nGold = (sqlite.prepare(`SELECT count(*) n FROM eval_items`).get() as { n: number }).n;
  if (!nGold || forceBuild) {
    console.log(`\n━━ gold set (depuis les corrigés, vision) ━━`);
    const g = await buildGoldSet({ onStep: step });
    nGold = g.items;
  }
  console.log(`gold set : ${nGold} items`);
  if (!nGold) { console.error("Aucun item : pas de corrigé ingéré (… with solutions). Stop."); process.exit(1); }

  // P2 — justesse (la métrique critique)
  console.log(`\n━━ justesse du solveur à l'aveugle ━━`);
  const acc = await runAccuracy({ limit, onStep: step });

  // P3 — discrimination + style (secondaires)
  let disc: { n: number; discrimination: number } | null = null;
  if (discN > 0) {
    console.log(`\n━━ discrimination (audit adversarial sur ${discN} exos générés) ━━`);
    try { disc = await measureDiscrimination({ n: discN, onStep: step }); } catch (e) { console.log("discrimination ignorée :", (e as Error).message); }
  }
  const style = measureStyleHeuristic();

  // P4 — run + rapport
  const notes = `${acc.correct}✓/${acc.incorrect}✗/${acc.uncertain}? sur ${acc.n}`;
  recordRun({ accuracy: acc.accuracy, uncertainRate: acc.uncertainRate, nItems: acc.n, discrimination: disc?.discrimination ?? null, styleScore: style.styleScore, notes });
  const report = buildReport(acc, disc, style);
  const dir = path.join(process.cwd(), "data", "refs", "proof", "evals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${course}-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, report);

  console.log(`\n════════ RÉSULTAT (${course}) ════════`);
  console.log(`  accuracy        : ${acc.accuracy}%  (${acc.correct} justes / ${acc.incorrect} faux sur ${acc.correct + acc.incorrect} tranchés)`);
  console.log(`  incertain       : ${acc.uncertainRate}%  (${acc.uncertain}/${acc.n})`);
  if (disc) console.log(`  discrimination  : ${disc.discrimination}%  (${disc.n} exos)`);
  console.log(`  style/format    : ${style.styleScore}/100`);
  console.log(`  rapport         : ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error("Échec eval :", e); process.exit(1); });
