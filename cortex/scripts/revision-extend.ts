/**
 * RÉVISION — EXTENSION massive du parcours (≥10 QCM/topic, ciblé faiblesses), ADDITIF & réentrant.
 *   npm run revision:extend -- --course=ml [--per-topic=10] [--open-per-topic=4] [--only-rank=11] [--no-git]
 *
 * Par vague (= par thème) : exporte cortex/data/ml/revision-<course>.json PUIS commit+push sur main
 * (progrès durable même si la session meurt ; relançable pour grossir). Résilient : un lot raté est
 * loggé puis ignoré. Ne supprime jamais la banque ni le parcours déjà généré.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { enterCourse } from "@/db/client";
import { ensureCoursesLoaded, normalizeCourse } from "@/lib/courses";
import { exportRevisionJson, extendParcours, themeCoverage, planStats, bankStats } from "@/lib/revision";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

const REPO = path.resolve(process.cwd(), ".."); // npm run tourne dans cortex/ → racine = ..
const JSON_REL = "cortex/data/ml/revision-ml.json";

function git(cmd: string): string { return execSync(`git ${cmd}`, { cwd: REPO, encoding: "utf8" }); }

function commitWave(theme: string, qcm: number, open: number): void {
  try {
    git(`add ${JSON_REL}`);
    const dirty = git(`status --porcelain ${JSON_REL}`).trim();
    if (!dirty) { console.log(`  (rien à committer pour « ${theme} »)`); return; }
    const msg = `Révision ML — vague « ${theme} » : +${qcm} QCM /+${open} ouvertes (JSON ré-exporté)\n\nParcours étendu, additif, blind-verify + architecte. Faiblesses ciblées.`;
    execSync(`git commit -F -`, { cwd: REPO, input: msg, encoding: "utf8" });
    for (let i = 1; i <= 4; i++) {
      try { git(`push -u origin main`); break; }
      catch (e) { if (i === 4) throw e; console.log(`  push échoué (${i}/4), retry…`); execSync(`sleep ${2 ** i}`); }
    }
    console.log(`  ✓ commit+push vague « ${theme} »`);
  } catch (e) { console.error(`  ⚠ git échoué pour « ${theme} » : ${(e as Error).message.slice(0, 120)}`); }
}

async function main() {
  const course = normalizeCourse(arg("course"));
  enterCourse(course);
  const perTopic = Number(arg("per-topic") || 10);
  const openPerTopic = Number(arg("open-per-topic") || 4);
  const onlyRank = arg("only-rank") != null ? Number(arg("only-rank")) : undefined;
  const noGit = arg("no-git") != null;

  console.log(`▶ revision:extend — cours « ${course} » · cible ≥${perTopic} QCM/topic, ${openPerTopic} ouvertes/topic${onlyRank != null ? ` · rang ${onlyRank}` : ""}${noGit ? " · SANS git" : ""}`);
  const b0 = await bankStats(), p0 = await planStats();
  console.log(`  départ : banque ${b0.qcm}+${b0.open} · parcours ${p0.qcm}+${p0.open}`);

  // extendParcours déclenche onWave SANS l'attendre (callback fire-and-forget) : on sérialise donc
  // les exports/commits de vague sur une chaîne de promesses, attendue avant l'export final.
  let waveChain: Promise<void> = Promise.resolve();
  const r = await extendParcours({
    perTopic, openPerTopic, onlyRank,
    onStep: (m, p) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
    onWave: (theme, qcm, open) => {
      // n'exporter/committer que si la vague a AJOUTÉ du contenu. Évite, au redémarrage, de salir
      // l'arbre de travail (l'horodatage seul changerait le JSON) sur les thèmes déjà complets.
      // L'export lit toute la DB → un éventuel rattrapage est inclus à la 1ʳᵉ vraie vague.
      if (qcm + open === 0) return;
      waveChain = waveChain.then(async () => {
        const file = await exportRevisionJson();
        console.log(`  → export ${path.basename(file)} (vague « ${theme} »)`);
        // ne committer que si la vague a AJOUTÉ du contenu (évite les commits « +0 » au redémarrage,
        // où seul l'horodatage du JSON changerait).
        if (!noGit && qcm + open > 0) commitWave(theme, qcm, open);
      });
    },
  });
  await waveChain;

  const file = await exportRevisionJson();
  if (!noGit) commitWave("récap final", r.qcmAdded, r.openAdded);
  const ps = await planStats();
  console.log(`\n✓ extension terminée : +${r.qcmAdded} QCM, +${r.openAdded} ouvertes sur ${r.themes} thèmes`);
  console.log(`  parcours total : ${ps.qcm} QCM + ${ps.open} ouvertes (${ps.topics} topics) · ${path.basename(file)}`);
  console.log(`\n  COUVERTURE PAR THÈME (cible / réel) :`);
  for (const t of (await themeCoverage()).sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)))
    console.log(`    L${t.rank} ${t.label}${t.weak ? " ⚑" : ""} : ${t.qcm} QCM / ${t.open} ouv. (cible ${t.target})${t.qcm >= 10 ? " ✓" : " ✗<10"}`);
}

ensureCoursesLoaded().then(main).catch((e) => { console.error("Échec revision:extend :", e); process.exit(1); });
