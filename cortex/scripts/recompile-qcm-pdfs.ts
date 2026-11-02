/**
 * Rattrapage des examens QCM restés sans PDF (garde LaTeX trop strict, LaTeX d'une
 * question ouverte cassé) : recompile depuis la base, SANS le modèle, gratuitement.
 *   npx tsx scripts/recompile-qcm-pdfs.ts --user <id> --course <id>
 * Sans --user : le compte propriétaire local. Rien n'est régénéré par le modèle.
 */
import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { ensureCoursesLoaded } from "../lib/courses";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

(async () => {
  const course = arg("course");
  if (!course) { console.error("usage : recompile-qcm-pdfs --course <id> [--user <id>]"); process.exit(1); }
  await ensureCoursesLoaded();
  const { recompileMissingQcmPdfs } = await import("../lib/qcm");
  const run = () => runWithCourse(course, () => recompileMissingQcmPdfs());
  const user = arg("user");
  const results = user ? await runWithUser(user, run) : await run();
  for (const r of results) console.log(`examen ${r.examId} : ${r.file || "aucun .tex sûr"}${r.texError ? ` — ÉCHEC : ${r.texError.slice(0, 200)}` : ""}`);
  console.log(`${results.length} examen(s) sans PDF traité(s), ${results.filter((r) => r.file.endsWith(".pdf")).length} compilé(s).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
