/**
 * RÉVISION — pré-construit la banque exhaustive (P1) + le parcours généré (P3) + l'export JSON (P4bis).
 *   npm run revision -- --course=ml [--index] [--parcours] [--export]   (sans flag = tout)
 */
import { enterCourse } from "@/db/client";
import { ensureCoursesLoaded, normalizeCourse } from "@/lib/courses";
import { assignLectureRanks, bankStats, buildParcours, exportRevisionJson, indexBank, planStats } from "@/lib/revision";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

async function main() {
  const course = normalizeCourse(arg("course"));
  enterCourse(course);
  const only = (k: string) => arg(k) !== undefined;
  const all = !only("index") && !only("parcours") && !only("export");
  const step = (s: string, p: number) => console.log(`  [${String(p).padStart(3)}%] ${s}`);

  console.log(`▶ revision — cours « ${course} »`);

  if (all || only("index")) {
    console.log(`\n━━ P1 : index exhaustif question-par-question (vision) ━━`);
    const r = await indexBank({ onStep: step });
    console.log(`index : ${r.qcm} QCM + ${r.open} ouvertes sur ${r.exams} finals`);
    await assignLectureRanks({ onStep: step });
    const s = await bankStats();
    console.log(`\n  banque : ${s.qcm} QCM + ${s.open} ouvertes · ${s.byTopic.length} sujets`);
    for (const t of s.byTopic) console.log(`    L${t.lectureRank ?? "?"} · ${t.topic} : ${t.qcm} QCM, ${t.open} ouvertes`);
  }

  if (all || only("parcours")) {
    console.log(`\n━━ P3 : parcours généré (couverture 100 % à la proportion réelle) ━━`);
    const r = await buildParcours({ onStep: step });
    console.log(`parcours : ${r.qcm} QCM + ${r.open} ouvertes sur ${r.topics} sujets`);
  }

  if (all || only("export") || only("parcours") || only("index")) {
    const file = await exportRevisionJson();
    const ps = await planStats(), bs = await bankStats();
    console.log(`\n✓ export JSON committé : ${file}`);
    console.log(`  banque ${bs.qcm}+${bs.open} · parcours ${ps.qcm}+${ps.open} (${ps.topics} sujets)`);
  }
}

ensureCoursesLoaded().then(main).catch((e) => { console.error("Échec revision :", e); process.exit(1); });
