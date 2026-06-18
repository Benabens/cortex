/**
 * V8 Phase 1 — SETUP D'UN COURS EN UNE COMMANDE (idempotent, cold-start).
 *
 *   npm run prepare -- --course=ml
 *
 * Enchaîne, de façon idempotente (rejouable à volonté) :
 *   (a) ingestion : purge l'état dérivé (sources/items/fts) puis ré-indexe
 *       data/<id>/content + data/<id>/refs (les ANNALES) — PAS un dossier brut externe ;
 *   (b) détection du format (peuple `format_profile`) — calée sur les annales (refs/) ;
 *   (c) construction du blueprint (taxonomie typée + pondérée) — calée sur les annales.
 *
 * But : sur un clone frais, UNE seule commande rend le cours pleinement opérationnel
 * (la carte « Mock QCM » réapparaît, /programme est complet) — fini la dépendance à l'état
 * « chaud » d'un conteneur. (b)/(c) ont besoin de Claude Code (Max) ; s'il manque, l'ingestion
 * (a) réussit quand même et un avertissement clair explique comment finir le setup.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { enterCourse, sqlite } from "../db/client";
import { claudeBinPath } from "../lib/claude-code";
import { DEFAULT_COURSE, normalizeCourse } from "../lib/courses";

function argVal(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

const COURSE = normalizeCourse(argVal("course"));

/** (a) Lance l'ingestion (purge + ré-indexe content + refs) dans un sous-process, en streamant la sortie. */
function runIngest(): Promise<void> {
  const tsxLocal = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const args = ["scripts/ingest.ts", "--course", COURSE];
  console.log(`\n━━ (a) Ingestion : ${COURSE} (content + refs) ━━`);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tsxLocal, args, { cwd: process.cwd(), env: { ...process.env, CORTEX_COURSE: COURSE }, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ingest a quitté (code ${code})`))));
  });
}

async function main() {
  console.log(`▶ prepare — cours « ${COURSE} » (cold-start, idempotent)`);

  // (a) INGESTION — toujours (purge + re-indexe content + refs). C'est ce qui fait « refs : 8 ».
  await runIngest();

  // L'ingestion tournait dans un autre process → on (ré)ouvre la DB du cours dans CE process.
  enterCourse(COURSE);
  const refsN = (sqlite.prepare(`SELECT count(*) n FROM exam_refs`).get() as { n: number } | undefined)?.n ?? 0;

  // cs-202 garde son format calcul/trace + son blueprint statique (archétypes) → pas de détection IA.
  if (COURSE === DEFAULT_COURSE) {
    console.log(`\n✓ prepare terminé pour ${COURSE} : ingestion OK (format/blueprint statiques, rien à détecter).`);
    return;
  }

  if (!claudeBinPath()) {
    console.log(`\n⚠ Claude Code (binaire « claude ») introuvable → étapes (b) format et (c) blueprint SAUTÉES.`);
    console.log(`  L'ingestion a réussi (refs : ${refsN}). Lance « claude » une fois (connexion Max), puis :`);
    console.log(`  • détecte le format depuis /examens (ou re-lance « npm run prepare -- --course=${COURSE} »).`);
    return;
  }

  const onStep = (m: string, p: number) => console.log(`   [${String(p).padStart(3)}%] ${m}`);

  // (b) DÉTECTION DU FORMAT — calée sur les annales (refs/). Non-fatale : un échec ne casse pas le setup.
  console.log(`\n━━ (b) Détection du format (annales : ${refsN}) ━━`);
  try {
    const { detectFormat } = await import("../lib/format");
    const f = await detectFormat({ onStep });
    console.log(`   ✓ format : ${(f.format_summary || "").slice(0, 90)}`);
  } catch (e) {
    console.log(`   ⚠ format non détecté (${(e as Error).message.slice(0, 120)}) — réessaie depuis /examens.`);
  }

  // (c) BLUEPRINT EXHAUSTIF (V11) — index exo-par-exo des finals → partition agrégée. Non-fatale.
  console.log(`\n━━ (c) Index exo-par-exo des finals + partition ━━`);
  try {
    const { rebuildBlueprintFromIndex } = await import("../lib/program");
    const r = await rebuildBlueprintFromIndex({ onStep });
    console.log(`   ✓ index : ${r.exercises} exo(s) sur ${r.exams} finals → ${r.types} type(s).`);
  } catch (e) {
    console.log(`   ⚠ index non construit (${(e as Error).message.slice(0, 120)}) — réessaie depuis /programme.`);
  }

  console.log(`\n✓ prepare terminé pour ${COURSE} : refs ${refsN}, format + index exo-par-exo + partition.`);
}

main().catch((e) => {
  console.error("Échec prepare :", e);
  process.exit(1);
});
