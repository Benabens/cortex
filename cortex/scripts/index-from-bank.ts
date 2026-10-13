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
 * Regrouper SEULEMENT les notions (ni les exos de l'index ni les chapitres du plan ne sont touchés) :
 *
 *   … <cours> --regrouper                        # le modèle regroupe et rattache, puis on écrit
 *   … <cours> --regrouper --dry --vers <f.json>  # rien n'est écrit en base : la partition proposée est
 *                                                #   affichée et enregistrée dans <f.json> pour relecture
 *   … <cours> --regrouper --depuis <f.json>      # applique la partition relue, SANS appel modèle
 *                                                #   (ajouter --dry pour seulement la confronter à la base)
 *
 * Le modèle ne rend pas deux fois le même regroupement : passer par le fichier garantit que ce qui a
 * été relu est ce qui est écrit. Un plan ne s'applique qu'à l'index sur lequel il a été calculé.
 * Sans modèle disponible, --regrouper s'arrête : il ne retombe JAMAIS sur « un type par libellé ».
 * Une notion dont le label disparaît emporte ses scores de maîtrise : dans ce cas l'écriture est
 * refusée, sauf --perdre-maitrise.
 *
 * Aucun contenu inventé : chaque exo vient d'une question réelle de la banque ; l'énoncé court est
 * un préfixe verbatim ; le passage de cours est le meilleur passage du support du prof trouvé par la
 * recherche de l'app (même fonction que l'indexation en vision). Le n° de lecture de la banque n'est
 * PAS utilisé : il a été attribué à partir des seuls noms de fichiers (« lecture_1 »…), sans les
 * titres réels, et se décale (ex. « Logistic regression » en lecture 5, k-NN).
 */
const args = process.argv.slice(2);
const VALUE_FLAGS = ["--vers", "--depuis"];
const valueOf = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const course = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const DRY = args.includes("--dry");
const ONLY_MAP = args.includes("--rattacher");
const REGROUP = args.includes("--regrouper");
const PLAN_OUT = valueOf("--vers");
const PLAN_IN = valueOf("--depuis");
const LOSE_MASTERY = args.includes("--perdre-maitrise");
if (args.includes("--sans-llm")) {
  // Fournisseur OpenAI-compatible SANS endpoint : chaque appel lève UNAVAILABLE immédiatement,
  // sans réseau ; les étapes basculent sur leurs replis déterministes.
  process.env.LLM_PROVIDER = "openai-compatible";
  delete process.env.LLM_BASE_URL;
}
if (!course) {
  console.error("usage : npx tsx scripts/index-from-bank.ts <cours> [--sans-llm] [--dry] [--rattacher] [--regrouper [--vers <f.json> | --depuis <f.json>]]");
  process.exit(1);
}
{
  const bad =
    VALUE_FLAGS.some((f) => args.includes(f) && (!valueOf(f) || valueOf(f)!.startsWith("--"))) ? "--vers et --depuis attendent un chemin de fichier."
    : (PLAN_OUT || PLAN_IN) && !REGROUP ? "--vers et --depuis ne s'emploient qu'avec --regrouper."
    : PLAN_OUT && PLAN_IN ? "--vers enregistre une partition calculée, --depuis en applique une : l'un ou l'autre."
    : REGROUP && ONLY_MAP ? "--regrouper rattache déjà les notions : inutile avec --rattacher."
    : REGROUP && !PLAN_IN && args.includes("--sans-llm") ? "--regrouper a besoin du modèle (ou d'une partition déjà calculée : --depuis <f.json>)."
    : null;
  if (bad) { console.error(bad); process.exit(1); }
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
  // Le cache des cours ne se charge tout seul qu'en SQLite : sans cet appel, en Postgres, la banque
  // de révision reste introuvable et le script sortait sur « Aucune banque de révision ».
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
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
  if (REGROUP) return regroup(c, log);

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
  if (!agg.clustered) console.log(`[index-from-bank] ⚠ notions NON regroupées (un type par libellé brut) : relancer avec --regrouper quand le modèle est disponible`);
  const plan = await rebuildCoursePlan({ onStep: log });
  console.log(`[index-from-bank] plan : ${plan.plan.ok ? `${plan.plan.chapters} chapitres` : `non dérivé (${plan.plan.reason})`} · rattachement ${plan.map.mapped}/${plan.map.total}`);
}

/** Arrêt net, sans trace de pile : le message dit quoi faire. */
function stop(message: string): never {
  console.error(`[index-from-bank] ${message}`);
  process.exit(1);
}

/**
 * Regroupe les notions d'un cours déjà indexé, puis les rattache au plan existant. Ne lit ni la
 * banque ni les slides : `exam_exercises` n'y gagne que son lien `topic_id`, `plan_chapters` n'est
 * pas réécrit (le re-dériver changerait l'id des chapitres).
 */
async function regroup(c: string, log: (m: string) => void) {
  const fs = await import("node:fs");
  const { q } = await import("../db/q");
  const { aggregateTopicsFromIndex, clusterIndexLabels } = await import("../lib/program");
  const { classifyNotionsByLecture, mapNotionsToChapters } = await import("../lib/course-plan");
  const { parsePlan, planMismatches, partitionStats, renderPartition } = await import("../lib/notion-regroup");
  type Plan = import("../lib/notion-regroup").RegroupPlan;

  // Lecture seule jusqu'à l'écriture finale : aucun ensure*Schema ici, un essai à blanc ne crée rien.
  const index = new Map(
    (await q.all<{ topic: string; n: number | string }>(`SELECT topic, count(*) AS n FROM exam_exercises GROUP BY topic`)).map((r) => [r.topic, Number(r.n)])
  );
  if (!index.size) stop("Index vide : rien à regrouper (reconstruire d'abord l'index, sans --regrouper).");
  const exos = [...index.values()].reduce((s, n) => s + n, 0);
  const chapters = await q.all<{ id: number; lecture_no: number | null; title: string }>(`SELECT id, lecture_no, title FROM plan_chapters ORDER BY seq`);
  if (!chapters.length) stop("Aucun plan de cours : --regrouper ne le dérive pas (lancer d'abord le script sans --regrouper).");
  const lectureOfChapter = new Map(chapters.map((ch) => [ch.id, ch.lecture_no]));
  const before = await q.all<{ id: number; label: string; exam_count: number | null; source: string | null; plan_chapter_id: number | null }>(
    `SELECT id, label, exam_count, source, plan_chapter_id FROM topics`
  );

  let plan: Plan;
  if (PLAN_IN) {
    plan = parsePlan(JSON.parse(fs.readFileSync(PLAN_IN, "utf8")));
    const gaps = planMismatches(plan, index);
    if (plan.course !== c) gaps.unshift(`plan calculé pour « ${plan.course} », pas pour « ${c} »`);
    if (gaps.length) stop(`Le plan ${PLAN_IN} ne correspond pas à l'index de cette base, rien n'est écrit :\n${gaps.map((g) => `    - ${g}`).join("\n")}`);
    log(`Plan ${PLAN_IN} (calculé le ${plan.createdAt.slice(0, 16).replace("T", " ")}) : identique à l'index de cette base ✓`);
  } else {
    // Modèle indisponible → arrêt. Le repli « un type par libellé » est précisément ce qu'on vient corriger.
    const ask = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
      log(what);
      try { return await call(); } catch (e) { return stop(`Modèle indisponible (${(e as Error).message.slice(0, 120)}) : rien n'est écrit.`); }
    };
    const clusters = await ask(`Regroupement de ${index.size} libellés par le modèle…`, () => clusterIndexLabels(index));
    if (!clusters.length) stop("Le modèle n'a proposé aucun type : rien n'est écrit.");
    const covered = new Set(clusters.flatMap((cl) => cl.members));
    const alone = [...index.keys()].filter((l) => !covered.has(l));
    if (alone.length) log(`⚠ ${alone.length} libellé(s) oublié(s) par le modèle, gardés tels quels : ${alone.join(" | ")}`);
    const { types } = await aggregateTopicsFromIndex({ clusters, dryRun: true });
    const answers = new Map(
      (await ask(`Rattachement de ${types.length} notions aux ${chapters.length} chapitres par le modèle…`, () =>
        classifyNotionsByLecture(chapters, types.map((t, i) => ({ id: i, label: t.label, method: t.method, category: t.category })))
      )).map((m) => [m.id, m.lecture_no])
    );
    const lectures = new Set(chapters.map((ch) => ch.lecture_no));
    plan = {
      course: c,
      createdAt: new Date().toISOString(),
      index: Object.fromEntries(index),
      types: types.map((t, i) => {
        const lec = answers.get(i) ?? null;
        return {
          label: t.label, method: t.method ?? undefined, category: t.category ?? undefined, archetype: t.archetype ?? undefined,
          members: [...t.rawLabels], lecture_no: lec != null && lectures.has(lec) ? lec : null, // jamais une lecture hors plan
        };
      }),
    };
  }

  // Avant / après, en chiffres puis en liste.
  const countOf = (members: string[]) => members.reduce((s, m) => s + (index.get(m) ?? 0), 0);
  const after = plan.types.map((t) => ({ label: t.label, count: countOf(t.members), lectureNo: t.lecture_no }));
  const was = partitionStats(before.map((t) => ({ label: t.label, count: t.exam_count ?? 0, lectureNo: t.plan_chapter_id != null ? lectureOfChapter.get(t.plan_chapter_id) ?? null : null })));
  const will = partitionStats(after);
  const line = (s: ReturnType<typeof partitionStats>) => `${s.notions} notions tombées, dont ${s.once} une seule fois ; au plus ×${s.max} ; ${s.occurrences} occurrences ; ${s.unattached} sans chapitre`;
  console.log(`[index-from-bank] ${c} : ${exos} exos, ${index.size} libellés bruts, ${chapters.length} chapitres (inchangés)`);
  console.log(`[index-from-bank] avant : ${line(was)}`);
  console.log(`[index-from-bank] après : ${line(will)}`);
  console.log(renderPartition(after, chapters));

  // Maîtrise : un type dont le label disparaît est supprimé, et ses scores avec lui (cascade).
  const kept = new Set(plan.types.map((t) => t.label));
  let scores: { topic_id: number; attempts: number | null }[] = [];
  try { scores = await q.all(`SELECT topic_id, attempts FROM mastery`); } catch { /* table absente : aucun score */ }
  const atRisk = scores
    .map((m) => before.find((t) => t.id === m.topic_id))
    .filter((t): t is (typeof before)[number] => !!t && ((t.source === "final" && !kept.has(t.label)) || !(t.exam_count ?? 0)));
  if (atRisk.length) console.log(`[index-from-bank] ⚠ maîtrise : ${atRisk.length} score(s) portés par des notions qui disparaissent : ${atRisk.map((t) => t.label).join(" | ")}`);
  else console.log(`[index-from-bank] maîtrise : ${scores.length} score(s) enregistrés, aucun perdu`);

  if (PLAN_OUT) {
    fs.writeFileSync(PLAN_OUT, JSON.stringify(plan, null, 2) + "\n");
    console.log(`[index-from-bank] partition enregistrée dans ${PLAN_OUT}`);
  }
  if (DRY) { console.log(`[index-from-bank] essai à blanc : rien n'a été écrit en base`); return; }
  if (atRisk.length && !LOSE_MASTERY) stop("Rien n'est écrit : relancer avec --perdre-maitrise pour accepter la perte de ces scores.");

  const agg = await aggregateTopicsFromIndex({ onStep: log, clusters: plan.types });
  // Le label écrit peut différer de celui du plan (troncature, fusion de labels équivalents) :
  // on retrouve la lecture d'un type par un de ses libellés bruts, pas par son nom.
  const lectureOfRaw = new Map(plan.types.flatMap((t) => t.members.map((m) => [m, t.lecture_no] as const)));
  const map = await mapNotionsToChapters({
    onStep: log,
    lectureByLabel: new Map(agg.types.map((t) => [t.label, lectureOfRaw.get([...t.rawLabels][0]) ?? null])),
  });
  const orphans = Number((await q.get<{ n: number | string }>(`SELECT count(*) AS n FROM exam_exercises WHERE topic_id IS NULL`))?.n ?? 0);
  console.log(`[index-from-bank] notions : ${agg.count} types sur ${agg.exercises} exos (${orphans} exo(s) sans notion) · rattachement ${map.mapped}/${map.total}`);
}

main(course).then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
