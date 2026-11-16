/**
 * COMPTE DÉMO DES RELECTEURS D'ANNUAIRES (Claude, ChatGPT) — crée ou complète,
 * idempotent : le relancer ne crée rien de plus.
 *
 *   # dans le conteneur de l'app (variables du service déjà posées)
 *   cd /app/cortex && node_modules/.bin/tsx scripts/review-account.ts [--lot 2026-11] [--dry-run]
 *
 * 1. Le compte de REVIEW_LOGIN_EMAIL (le seul que la connexion relecteur ouvre,
 *    lib/review-login). Refus si c'est un compte propriétaire (CORTEX_OWNER_*) :
 *    le relecteur doit payer en crédits comme un client, pour voir le devis puis
 *    la confirmation.
 * 2. 20 crédits par une ligne de grand livre `review_grant`, une fois par lot
 *    (référence `review_grant:<compte>:<lot>`, lot « 1 » par défaut). Ce ne sont
 *    pas des revenus : le budget lié au revenu ne lit que les paiements Stripe
 *    (lib/billing/revenue). Ils sont servis comme des crédits achetés (tout ce
 *    qui n'est pas `signup:*`, lib/billing/budget) : sans cela, un compte sans
 *    paiement aurait un budget nul et la revue échouerait au premier devis.
 * 3. Le cours DEMO-101 « Probabilités (démo) », examen dans 30 jours, avec un
 *    polycopié, une annale corrigée et une fiche d'examen écrits pour la démo
 *    (scripts/review-demo/, aucun contenu de cours réel).
 *
 * La préparation du cours n'est PAS lancée : elle se fait par le connecteur
 * (prepare_course), comme le ferait un utilisateur.
 */
import fs from "node:fs";
import path from "node:path";

const DEMO_CODE = "DEMO-101";
const DEMO_NAME = "Probabilités (démo)";
const GRANT_CREDITS = 20;
const SOURCES = [
  { file: "lecture-notes.md", title: "DEMO-101 lecture notes", category: "lecture" },
  { file: "past-exam.md", title: "DEMO-101 practice final", category: "past_exam" },
  { file: "exam-info.md", title: "DEMO-101 exam information", category: "exam_info" },
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const lot = (arg("lot") ?? "1").trim();
  if (!/^[\w.-]{1,32}$/.test(lot)) throw new Error("--lot : lettres, chiffres, « . » « - » « _ » (32 max).");
  const email = (process.env.REVIEW_LOGIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) throw new Error("REVIEW_LOGIN_EMAIL n'est pas posée : c'est l'adresse du compte démo.");
  if (email === (process.env.CORTEX_OWNER_EMAIL ?? "").trim().toLowerCase()) {
    throw new Error("REVIEW_LOGIN_EMAIL est l'adresse du propriétaire : le compte démo doit être un compte client.");
  }

  const { authGet } = await import("../db/auth-store");
  const { ensureReviewUser, reviewLoginActive } = await import("../lib/review-login");
  const { isOwner } = await import("../lib/billing/owner");
  const { addTransaction, billingEnabled, getBalanceCenti, fmtCredits, toCenti } = await import("../lib/billing/credits");
  const { accountRevenue } = await import("../lib/billing/revenue");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { ensureCoursesLoaded, listCoursesOf, reloadCourses } = await import("../lib/courses");
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { addTextSource, textSourceExists } = await import("../lib/course-source");

  const report: string[] = [];
  if (!reviewLoginActive()) report.push("⚠ connexion relecteur FERMÉE (REVIEW_LOGIN_PASSWORD_HASH absente, illisible ou REVIEW_LOGIN_UNTIL passée)");
  if (!billingEnabled()) report.push("⚠ BILLING_ENABLED n'est pas à 1 : les crédits sont écrits mais rien n'est facturé");

  if (dry) {
    const u = await authGet<{ id: string }>("SELECT id FROM users WHERE lower(email) = ?", email);
    report.push(u ? `compte existant ${u.id}` : "compte à créer", "(--dry-run : rien n'est écrit)");
    console.log(report.join("\n"));
    return;
  }

  // 1. compte
  const user = await ensureReviewUser(email);
  if (await isOwner(user.id)) throw new Error(`le compte ${user.id} est propriétaire (CORTEX_OWNER_*) : refus.`);
  report.push(`compte ${user.id}`);

  // 2. crédits (idempotent par référence)
  const ref = `review_grant:${user.id}:${lot}`;
  const granted = await addTransaction(user.id, toCenti(GRANT_CREDITS), "review_grant", ref);
  report.push(granted ? `+${GRANT_CREDITS} crédits (${ref})` : `crédits déjà accordés (${ref})`);
  const revenue = await accountRevenue(user.id);
  if (revenue.netUsd !== 0) report.push(`⚠ revenu net du compte : ${revenue.netUsd} $ (attendu 0)`);

  // 3. cours d'exemple, dans le contexte du compte démo
  await runWithUser(user.id, async () => {
    await ensureCoursesLoaded();
    let course = listCoursesOf(user.id).find((c) => c.examCode?.toLowerCase() === DEMO_CODE.toLowerCase());
    if (course) {
      report.push(`cours ${DEMO_CODE} existant (${course.id})`);
    } else {
      const row = buildCourseRow({
        name: DEMO_NAME, code: DEMO_CODE, language: "en", examDate: inDays(30), durationMin: 120,
        examFormat: { kind: "exercises", questionCount: 5, durationMin: 120, language: "en", documents: "none" },
      }, user.id);
      await insertCourse(row);
      await reloadCourses();
      course = listCoursesOf(user.id).find((c) => c.id === row.id);
      if (!course) throw new Error("cours enregistré mais introuvable après rechargement.");
      report.push(`cours ${DEMO_CODE} créé (${course.id}), examen le ${row.exam_date}`);
    }
    const courseId = course.id;
    await runWithCourse(courseId, async () => {
      for (const s of SOURCES) {
        if (await textSourceExists(courseId, { title: s.title, category: s.category })) {
          report.push(`support déjà là : ${s.title}`);
          continue;
        }
        const text = fs.readFileSync(path.join(__dirname, "review-demo", s.file), "utf8");
        const saved = await addTextSource(courseId, { text, title: s.title, category: s.category });
        report.push(`support ajouté : ${saved.folder}/${saved.name}`);
      }
    });
  });

  report.push(`solde : ${fmtCredits(await getBalanceCenti(user.id))} crédits`);
  report.push("préparation NON lancée : prepare_course par le connecteur.");
  console.log(report.join("\n"));
}

main()
  .then(async () => {
    if (process.env.DB_DRIVER === "postgres") await (await import("../db/driver-postgres")).closePostgres();
    process.exit(0);
  })
  .catch((e) => {
    console.error(`review-account : ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
