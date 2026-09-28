/**
 * Reconstruit l'index exo-par-exo (`exam_exercises`) d'un cours DEPUIS SA BANQUE DE RÉVISION
 * (data/<cours>/revision-<cours>.json : chaque QCM et chaque question ouverte des vrais finals,
 * avec année, page, barème, lien vers l'énoncé à la bonne page et n° de lecture), puis relance
 * la partition des notions et le plan de cours avec le code de l'app.
 *
 * Sert quand l'indexation en vision n'a jamais tourné mais que la banque existe (cas du cours ML
 * local au 28/09/2026 : banque de 130 questions du 24/06, index et plan jamais calculés).
 *
 *   npx tsx scripts/index-from-bank.ts <cours>              # avec LLM si disponible
 *   npx tsx scripts/index-from-bank.ts <cours> --sans-llm   # replis déterministes, AUCUN appel modèle
 *   npx tsx scripts/index-from-bank.ts <cours> --dry        # n'écrit rien : résume ce qui serait indexé
 *   npx tsx scripts/index-from-bank.ts <cours> --rattacher  # seulement le rattachement notions → chapitres
 *
 * Aucun contenu inventé : chaque exo vient d'une question réelle de la banque ; l'énoncé court est
 * un préfixe verbatim ; le passage de cours est le meilleur passage du support du prof trouvé par la
 * recherche de l'app (même fonction que l'indexation en vision). Le n° de lecture de la banque n'est
 * PAS utilisé : il a été attribué à partir des seuls noms de fichiers (« lecture_1 »…), sans les
 * titres réels, et se décale (ex. « Logistic regression » en lecture 5, k-NN).
 */
const args = process.argv.slice(2);
const course = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry");
const ONLY_MAP = args.includes("--rattacher");
if (args.includes("--sans-llm")) {
  // Fournisseur OpenAI-compatible SANS endpoint : chaque appel lève UNAVAILABLE immédiatement,
  // sans réseau ; les étapes basculent sur leurs replis déterministes.
  process.env.LLM_PROVIDER = "openai-compatible";
  delete process.env.LLM_BASE_URL;
}
if (!course) {
  console.error("usage : npx tsx scripts/index-from-bank.ts <cours> [--sans-llm] [--dry]");
  process.exit(1);
}

/** Énoncé court et fidèle : les premières phrases entières jusqu'à ~280 caractères. */
export function shortStatement(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sentences = t.match(/[^.?!]+[.?!]+(\s|$)/g) ?? [];
  let out = "";
  for (const x of sentences) {
    if ((out + x).trim().length > max) break;
    out += x;
  }
  out = out.trim();
  return out.length >= 40 ? out : `${t.slice(0, max - 1).trimEnd()}…`;
}

async function main(c: string) {
  const { enterCourse } = await import("../db/client");
  enterCourse(c);
  const { q } = await import("../db/q");
  const { loadRevisionJson } = await import("../lib/revision");
  const { ensureIndexSchema, courseHrefFor } = await import("../lib/exam-index");
  const { aggregateTopicsFromIndex } = await import("../lib/program");
  const { rebuildCoursePlan, mapNotionsToChapters } = await import("../lib/course-plan");
  const log = (m: string) => console.log(`  · ${m}`);

  if (ONLY_MAP) {
    const map = await mapNotionsToChapters({ onStep: log });
    console.log(`[index-from-bank] rattachement ${map.ok ? `${map.mapped}/${map.total}` : `échoué (${map.reason})`}`);
    return;
  }

  const rev = loadRevisionJson(c);
  const bank = rev ? [...(rev.bank.qcm ?? []), ...(rev.bank.open ?? [])] : [];
  if (!bank.length) {
    console.error(`Aucune banque de révision pour « ${c} » (revision-${c}.json absent ou vide).`);
    process.exit(1);
  }

  // Passage de cours : un par (sujet, sous-sujet), par la recherche de l'app.
  const hrefCache = new Map<string, string | null>();
  for (const b of bank) {
    const k = `${b.topic}\u0000${b.subtopic ?? ""}`;
    if (!hrefCache.has(k)) hrefCache.set(k, await courseHrefFor(c, b.topic.trim(), b.subtopic?.trim() || null));
  }

  const rows = bank.map((b) => ({
      examTitle: (b.sourceExam ?? "").replace(/[_ -]?(solutions?|corrig[eé]s?)$/i, "") || b.sourceExam,
      examYear: b.examYear,
      examPage: b.examPage,
      topic: b.topic.trim().slice(0, 160),
      method: b.subtopic?.trim().slice(0, 300) || null,
      exoType: b.kind === "qcm" ? "QCM" : "Question ouverte",
      statement: shortStatement(b.statement),
      points: Number(b.points) > 0 ? Number(b.points) : null,
      examHref: b.examHref,
      courseHref: hrefCache.get(`${b.topic}\u0000${b.subtopic ?? ""}`) ?? null,
  }));

  const exams = new Set(rows.map((r) => `${r.examTitle} ${r.examYear ?? ""}`));
  console.log(`[index-from-bank] ${c} : ${rows.length} exos de ${exams.size} examens (${[...exams].join(", ")})`);
  console.log(`[index-from-bank] ${rows.filter((r) => r.courseHref).length}/${rows.length} avec un passage du support du prof`);
  if (DRY) return;

  await ensureIndexSchema();
  await q.tx(async () => {
    await q.exec(`DELETE FROM exam_exercises`); // index reconstruit à chaque passe, comme l'indexeur vision
    for (const r of rows) {
      await q.run(
        `INSERT INTO exam_exercises (exam_title, exam_year, exam_page, topic, method, exo_type, trap, archetype, statement, points, exam_href, course_href, mold, figure_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        r.examTitle, r.examYear, r.examPage, r.topic, r.method, r.exoType, null, null, r.statement, r.points, r.examHref, r.courseHref, null, null,
      );
    }
  });
  const agg = await aggregateTopicsFromIndex({ onStep: log });
  console.log(`[index-from-bank] notions : ${agg.count} types sur ${agg.exercises} exos`);
  const plan = await rebuildCoursePlan({ onStep: log });
  console.log(`[index-from-bank] plan : ${plan.plan.ok ? `${plan.plan.chapters} chapitres` : `non dérivé (${plan.plan.reason})`} · rattachement ${plan.map.mapped}/${plan.map.total}`);
}

main(course).then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
