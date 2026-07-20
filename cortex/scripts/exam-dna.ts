/**
 * moteur-v2 (P0) — CLI de détection de l'ADN D'EXAMEN d'un cours (générique, ré-entrant).
 *
 *   npm run dna -- <course>            # détecte (reprend où c'était), imprime + écrit la preuve
 *   npm run dna -- <course> --print    # n'exécute rien : imprime l'ADN persisté + la preuve
 *
 * Preuve committée : data/refs/proof/moteur-v2/dna-<course>.{json,md} — la distribution détectée
 * CÔTE-À-CÔTE avec de vrais exemples d'annales par moule (vérifiable à l'œil).
 */
import fs from "node:fs";
import path from "node:path";
import { enterCourse } from "../db/client";
import { q } from "../db/q";
import { detectExamDna, getExamDna, ensureDnaSchema, type ExamDna } from "../lib/exam-dna";
import { indexExamExercises } from "../lib/exam-index";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const course = args[0];
if (!course) { console.error("usage: npm run dna -- <course> [--print]"); process.exit(1); }
enterCourse(course);

const PROOF_DIR = path.join(process.cwd(), "data", "refs", "proof", "moteur-v2");

async function moldExamples(mold: string, k = 2): Promise<{ year: number | null; page: number | null; statement: string }[]> {
  return (
    await q.all<{ year: number | null; page: number | null; statement: string | null }>(
      `SELECT exam_year year, exam_page page, statement FROM exam_exercises
        WHERE mold = ? AND statement IS NOT NULL ORDER BY (exam_year IS NULL), exam_year DESC, id LIMIT ?`,
      mold, k
    )
  ).map((r) => ({ ...r, statement: (r.statement ?? "").replace(/\s+/g, " ").slice(0, 200) }));
}

async function writeProof(dna: ExamDna): Promise<void> {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROOF_DIR, `dna-${course}.json`), JSON.stringify(dna, null, 2));

  const lines: string[] = [];
  lines.push(`# ADN d'examen — ${course} (détecté depuis les annales, ${dna.detected_at})`);
  lines.push("");
  lines.push(`Exercices indexés : **${dna.totals.exercises}** · classés en moule : **${dna.totals.classified}**`);
  lines.push("");
  lines.push(`## Distribution des MOULES (réelle)`);
  lines.push("");
  lines.push(`| Moule | n | part |`);
  lines.push(`|---|---|---|`);
  for (const m of dna.molds) lines.push(`| ${m.mold} | ${m.count} | ${m.share_pct} % |`);
  lines.push("");
  lines.push(`### Exemples RÉELS par moule (côte-à-côte avec les annales)`);
  for (const m of dna.molds) {
    const ex = await moldExamples(m.mold);
    if (!ex.length) continue;
    lines.push(``);
    lines.push(`**${m.mold}** (${m.count}×)`);
    for (const e of ex) lines.push(`- (${e.year ?? "?"}${e.page ? ` · p.${e.page}` : ""}) ${e.statement}`);
  }
  lines.push("");
  lines.push(`## FIGURES (scan vision des annales)`);
  lines.push("");
  lines.push(`Pages scannées : **${dna.figures.pages_scanned}** · pages avec ≥1 figure : **${dna.figures.pages_with_figures}** (${dna.figures.figure_share_pct} %) · exos référençant une figure : **${dna.figures.exercises_with_figure_pct} %**`);
  lines.push("");
  if (dna.figures.kinds.length) {
    lines.push(`| Type de figure | n | ce qu'elle montre (spec paramétrique) |`);
    lines.push(`|---|---|---|`);
    for (const k of dna.figures.kinds) lines.push(`| ${k.kind} | ${k.count} | ${k.shows.join(" · ").slice(0, 220)} |`);
  } else {
    lines.push(`(aucune figure détectée / aucune annale scannable — le cours générera 0 figure, jamais forcé)`);
  }
  lines.push("");
  lines.push(`Examens scannés : ${Object.entries(dna.figures.scanned).map(([t, s]) => `${t} (${s.pages} p., ${s.figures.length} fig.)`).join(" · ")}`);
  lines.push("");
  lines.push(`## Texture de difficulté`);
  lines.push("");
  if (dna.difficulty) {
    lines.push(dna.difficulty.summary);
    lines.push("");
    lines.push(`- nombres non-ronds : ${dna.difficulty.non_round_numbers ?? "?"} · sous-questions en escalier : ${dna.difficulty.staircase_subquestions ?? "?"}`);
    for (const t of dna.difficulty.typical_traps) lines.push(`- piège : ${t}`);
  } else {
    lines.push(`(non dérivée — à relancer)`);
  }
  lines.push("");
  fs.writeFileSync(path.join(PROOF_DIR, `dna-${course}.md`), lines.join("\n"));
}

function printDna(dna: ExamDna): void {
  console.log(`\n=== ADN ${course} — ${dna.totals.classified}/${dna.totals.exercises} exos classés ===`);
  for (const m of dna.molds) console.log(`  ${String(m.share_pct).padStart(5)} %  ${m.mold}  (${m.count}×)`);
  console.log(`  figures: ${dna.figures.kinds.length} types · ${dna.figures.figure_share_pct} % des pages · exos avec figure ${dna.figures.exercises_with_figure_pct} %`);
  for (const k of dna.figures.kinds.slice(0, 10)) console.log(`    - ${k.kind} (${k.count}×)`);
  if (dna.difficulty) console.log(`  difficulté: ${dna.difficulty.summary.slice(0, 160)}`);
}

async function main() {
  let dna: ExamDna | null;
  if (flags.has("--print")) {
    dna = await getExamDna();
    if (!dna) { console.error("Aucun ADN persisté pour ce cours — lance sans --print."); process.exit(1); }
  } else {
    // Cours jamais indexé exo-par-exo (ex. onboarding) → indexation d'abord (vision, ré-entrant :
    // uniquement si l'index est VIDE — on ne ré-indexe jamais un index existant ici).
    await ensureDnaSchema();
    const n = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_exercises`))?.n ?? 0;
    if (n === 0) {
      console.log("Index exo-par-exo vide → indexation des annales d'abord (vision)…");
      await indexExamExercises({ onStep: (s, p) => console.log(`  [idx ${String(p).padStart(3)}%] ${s}`) });
    }
    dna = await detectExamDna({ onStep: (s, p) => console.log(`  [${String(p).padStart(3)}%] ${s}`) });
  }
  printDna(dna);
  await writeProof(dna);
  console.log(`\nPreuve écrite : data/refs/proof/moteur-v2/dna-${course}.{json,md}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
