import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalScroll, loginPersona } from "./helpers";
import { stageTracker, type StageInfo } from "../lib/job-stage";
import { stageText } from "../lib/i18n/job-text";

/**
 * SUIVI D'UN EXAMEN ÉCRIT, ÉTAPE « EXERCICES PRÊTS » (#9, audit generation-ux-suite du 25/11/2026).
 * Le moteur écrit « 4/4 exercices vérifiés ✓ (lot 2/2, 139s) » ; la carte du compositeur doit dire
 * « Vérification des questions · 4/4 exercices prêts », sans revenir à « Rédaction » quand le lot
 * suivant s'écrit encore. Aucune génération : le cours est fictif (format écrit déclaré), le job est
 * servi par interception. Son étape est celle que le serveur écrirait (lib/job-stage, puis
 * lib/i18n/job-text) ; avancement et temps restant sont ceux relevés sur un vrai examen écrit au
 * même moment (banc du 25/11, job 20, à 141 s). Le rendu, lui, est celui de la vraie page.
 *
 * E2E_SHOTS_DIR=<dossier> : écrit aussi les captures de l'audit (1440 / 390 × clair / sombre).
 */

const JOB_ID = 9301;
/** Ce que la carte doit dire (messages/fr.json : jobText.stage.check + jobText.stageCount). */
const STEP = "Vérification des questions · 4/4 exercices prêts";

/** Phrases du moteur (lib/exam.ts), deux lots de deux exercices ; le lot 2 finit d'écrire après le début des vérifications. */
const ENGINE_STEPS = [
  "Lot 1/2 : génération de 2 exercices…",
  "Lot 2/2 : génération de 2 exercices…",
  "2/4 exercices rédigés ✓ (lot 1/2, 58s)",
  "Lot 1/2 : vérification à l'aveugle + durcissement (0/4 exercices vérifiés)…",
  "4/4 exercices rédigés ✓ (lot 2/2, 74s)",
  "2/4 exercices vérifiés ✓ (lot 1/2, 112s)",
  "Lot 2/2 : vérification à l'aveugle + durcissement (2/4 exercices vérifiés)…",
  "4/4 exercices vérifiés ✓ (lot 2/2, 139s)",
];

function stageAfterEngine(): StageInfo {
  const track = stageTracker("exam");
  let info: StageInfo | null = null;
  for (const step of ENGINE_STEPS) info = track(step);
  return info!;
}

/** Horodatage SQL en UTC, comme `jobs.created_at`. */
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function runningJob(course: string, startedAt: number) {
  const stepInfo = stageAfterEngine();
  return {
    id: JOB_ID, type: "exam", status: "verifying", progress: 88, target: null, course, courseLabel: course,
    currentStep: stageText(stepInfo, "fr"), stepInfo,
    eta: "moins d'une minute", etaRange: { lowMs: 20_000, highMs: 50_000 }, etaLate: false,
    createdAt: sqlTime(startedAt), charged: true,
  };
}

/** Le job en cours, tel que le servent /api/jobs?type=exam, /api/jobs/<id> et /api/jobs/running. */
async function serveRunningJob(page: Page, job: ReturnType<typeof runningJob>) {
  await page.route((url) => url.pathname.startsWith("/api/jobs"), (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/jobs/running") return route.fulfill({ json: { jobs: [job] } });
    if (url.pathname === `/api/jobs/${JOB_ID}`) return route.fulfill({ json: job });
    if (url.pathname === "/api/jobs" && url.searchParams.get("type") === "exam") {
      return route.fulfill({ json: { active: { id: JOB_ID, type: "exam", target: null }, recent: [] } });
    }
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { active: null, recent: [] } });
    return route.continue();
  });
}

async function newWrittenCourse(page: Page): Promise<string> {
  await loginPersona(page, `suivi-ecrit-${Date.now()}`);
  const course = await page.evaluate(async () => {
    const res = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cours fictif", code: "DEMO-101", examFormat: { kind: "exercises", questionCount: 4, durationMin: 180, language: null } }),
    });
    return ((await res.json()) as { course: { id: string } | null }).course?.id ?? null;
  });
  expect(course).toBeTruthy();
  return course!;
}

const SHOT_VARIANTS = [
  { key: "1440-light", width: 1440, height: 900, scheme: "light", dpr: 1, mobile: false },
  { key: "1440-dark", width: 1440, height: 900, scheme: "dark", dpr: 1, mobile: false },
  { key: "390-light", width: 390, height: 844, scheme: "light", dpr: 2, mobile: true },
  { key: "390-dark", width: 390, height: 844, scheme: "dark", dpr: 2, mobile: true },
] as const;

test("examen écrit : la carte dit « 4/4 exercices prêts » à la fin des vérifications, sans débordement mobile", async ({ page, browser }) => {
  const course = await newWrittenCourse(page);
  const job = runningJob(course, Date.now() - 141_000);
  expect(job.stepInfo).toEqual({ key: "stage", stage: "check", done: 4, total: 4, unit: "exercise" });

  await serveRunningJob(page, job);
  await page.goto(`/examens?course=${course}`);
  const card = page.getByRole("region", { name: "Suivi de la génération" });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-stage", "check");
  await expect(card.getByText(STEP)).toBeVisible();
  await expect(card.getByText("Moins d’une minute")).toBeVisible();
  await expect(card.getByText(/Lancée il y a 2 min/)).toBeVisible();
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "88");
  // La carte remplace le bouton de lancement.
  await expect(page.getByRole("button", { name: /Générer l.examen/ })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);

  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const storageState = await page.context().storageState();
  for (const v of SHOT_VARIANTS) {
    const ctx = await browser.newContext({
      storageState, locale: "fr-FR", colorScheme: v.scheme, viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.dpr, isMobile: v.mobile, hasTouch: v.mobile,
    });
    const shot = await ctx.newPage();
    await serveRunningJob(shot, runningJob(course, Date.now() - 141_000));
    await shot.goto(`/examens?course=${course}`);
    await expect(shot.getByRole("region", { name: "Suivi de la génération" }).getByText(STEP)).toBeVisible();
    // La pastille du haut montre le job le temps que la carte se monte, puis s'efface (useShowJob).
    await expect(shot.getByRole("link", { name: /Vérification des questions/ })).toHaveCount(0);
    await shot.waitForLoadState("networkidle");
    await shot.screenshot({ path: path.join(dir, `05-etape-${v.key}.png`) });
    await ctx.close();
  }
});
