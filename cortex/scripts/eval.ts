/**
 * Harnais d'éval (interne, lecture seule) — CHIFFRE la justesse du vrai moteur, GÉNÉRIQUE par cours.
 *
 *   npm run eval -- --course=algo [--limit 20] [--gold 80] [--build] [--no-disc] [--disc 1]
 *   npm run eval -- --summary           # synthèse cross-cours (lit le dernier run de chaque cours)
 *
 * - construit le gold set depuis les corrigés (vision) si absent (ou --build), ~--gold items,
 * - résout chaque item à l'aveugle (lib/verify) + juge (DÉTERMINISTE numeric/mcq/short, LLM=ouvert),
 * - mesure discrimination (audit adversarial) + style (format), historise dans `eval_runs`,
 * - écrit data/refs/proof/evals/<course>-<date>.md (et summary-<date>.md en mode --summary).
 */
import { enterCourse, runWithCourse } from "@/db/client";
import { q } from "../db/q";
import { listCourses, normalizeCourse } from "@/lib/courses";
import { buildGoldSet, buildReport, ensureEvalSchema, measureDiscrimination, measureStyleHeuristic, PROMPT_VERSION, recordRun, runAccuracy } from "@/lib/eval";
import fs from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

const EVALS_DIR = path.join(process.cwd(), "data", "refs", "proof", "evals");

/** Synthèse cross-cours : dernier `eval_runs` de chaque cours → tableau + porte de qualité. */
async function summary() {
  await ensureEvalSchema();
  const rows: any[] = [];
  for (const c of listCourses()) {
    try {
      const r = await runWithCourse(c.id, async () => {
        await ensureEvalSchema();
        const run = (await q.get<any>(`SELECT * FROM eval_runs ORDER BY id DESC LIMIT 1`)) as any;
        const gold = ((await q.get<{ n: number }>(`SELECT count(*) n FROM eval_items`)) as { n: number }).n;
        return run ? { course: c.id, code: c.examCode, gold, ...run } : null;
      });
      if (r) rows.push(r);
    } catch {}
  }
  const lines = [`# Eval — synthèse cross-cours — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ``,
    `Même code, zéro branche par cours (preuve de généricité). Solveur à l'aveugle vs corrigés officiels.`, ``,
    `| Cours | accuracy | incertain | prouvé (det.) | discrimination | N (run) | gold | prompt |`,
    `|---|---|---|---|---|---|---|---|`];
  for (const r of rows) lines.push(`| ${r.code} (${r.course}) | **${r.accuracy}%** | ${r.uncertain_rate}% | ${r.deterministic_rate ?? "—"}% | ${r.discrimination ?? "—"}% | ${r.n_items} | ${r.gold} | ${r.prompt_version} |`);
  lines.push(``, `## Porte de qualité`, `Toute nouvelle matière : déposer ses annales (dont des corrigés) → \`npm run prepare:course --course=<id>\` → \`npm run eval -- --course=<id>\` → un chiffre. Contrôle qualité automatique du produit publié, sans toucher au code.`);
  lines.push(``, `> Rapports détaillés (incertains + désaccords à spot-check) : \`evals/<course>-<date>.md\`.`);
  fs.mkdirSync(EVALS_DIR, { recursive: true });
  const file = path.join(EVALS_DIR, `summary-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\nsynthèse : ${path.relative(process.cwd(), file)}`);
}

async function main() {
  if (arg("summary") !== undefined) { await summary(); return; }

  const course = normalizeCourse(arg("course"));
  enterCourse(course);
  await ensureEvalSchema();
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const goldMax = arg("gold") ? Number(arg("gold")) : 80;
  const forceBuild = arg("build") !== undefined;
  const discN = arg("no-disc") !== undefined ? 0 : Number(arg("disc") ?? 2);
  const step = (s: string, p: number) => console.log(`  [${String(p).padStart(3)}%] ${s}`);

  console.log(`▶ eval — cours « ${course} » (prompt-version ${PROMPT_VERSION})`);

  let nGold = ((await q.get<{ n: number }>(`SELECT count(*) n FROM eval_items`)) as { n: number }).n;
  if (!nGold || forceBuild) {
    console.log(`\n━━ gold set (depuis les corrigés, vision · cible ${goldMax}) ━━`);
    nGold = (await buildGoldSet({ max: goldMax, onStep: step })).items;
  }
  console.log(`gold set : ${nGold} items`);
  if (!nGold) { console.error("Aucun item : pas de corrigé ingéré (… with solutions). Stop."); process.exit(1); }

  console.log(`\n━━ justesse du solveur à l'aveugle ━━`);
  const acc = await runAccuracy({ limit, onStep: step });

  let disc: { n: number; discrimination: number } | null = null;
  if (discN > 0) {
    console.log(`\n━━ discrimination (audit adversarial sur ${discN} exos générés) ━━`);
    try { disc = await measureDiscrimination({ n: discN, onStep: step }); } catch (e) { console.log("discrimination ignorée :", (e as Error).message); }
  }
  const style = await measureStyleHeuristic();

  const notes = `${acc.correct}✓/${acc.incorrect}✗/${acc.uncertain}? sur ${acc.n} (gold ${nGold}) · prouvé ${acc.deterministicRate}% [${Object.entries(acc.methods).map(([m, n]) => `${m}:${n}`).join(" ")}]`;
  await recordRun({ accuracy: acc.accuracy, uncertainRate: acc.uncertainRate, nItems: acc.n, discrimination: disc?.discrimination ?? null, styleScore: style.styleScore, deterministicRate: acc.deterministicRate, notes });
  fs.mkdirSync(EVALS_DIR, { recursive: true });
  const file = path.join(EVALS_DIR, `${course}-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, buildReport(acc, disc, style));

  console.log(`\n════════ RÉSULTAT (${course}) ════════`);
  console.log(`  accuracy        : ${acc.accuracy}%  (${acc.correct} justes / ${acc.incorrect} faux sur ${acc.correct + acc.incorrect} tranchés)`);
  console.log(`  incertain       : ${acc.uncertainRate}%  (${acc.uncertain}/${acc.n})`);
  console.log(`  prouvé (det.)   : ${acc.deterministicRate}%  [${Object.entries(acc.methods).map(([m, n]) => `${m}:${n}`).join(" ")}]`);
  if (disc) console.log(`  discrimination  : ${disc.discrimination}%  (${disc.n} exos)`);
  console.log(`  style/format    : ${style.styleScore}/100`);
  console.log(`  rapport         : ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error("Échec eval :", e); process.exit(1); });
