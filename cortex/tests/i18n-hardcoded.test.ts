/**
 * GARDE-FOU : aucun texte d'interface écrit en dur ne réapparaît dans les composants, les
 * pages et lib/ux (tout texte visible passe par messages/fr.json et messages/en.json).
 *
 * Cliquet : PENDING liste les fichiers pas encore migrés. Un fichier hors de la liste doit
 * être propre ; un fichier de la liste qui devient propre DOIT en sortir (la liste ne fait
 * que rétrécir, jusqu'à être vide). Exception légitime (contenu de cours, nom de marque) :
 * une ligne `// i18n-allow: <raison>` juste au-dessus.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { looksFrench, scanSource, uiFiles } from "./helpers/i18n-scan";

const ROOT = path.resolve(__dirname, "..");

const PENDING = new Set<string>([
  "app/compte/AccountContent.tsx",
  "app/compte/AppearanceSetting.tsx",
  "app/compte/BillingPanel.tsx",
  "app/compte/ConnectedApps.tsx",
  "app/compte/DeleteAccount.tsx",
  "app/compte/ExportData.tsx",
  "app/compte/UsagePanel.tsx",
  "app/compte/WithdrawalForm.tsx",
  "app/compte/assistants/CopyButton.tsx",
  "app/compte/assistants/page.tsx",
  "app/cours/nouveau/page.tsx",
  "app/cours/page.tsx",
  "app/entrainement/page.tsx",
  "app/examens/page.tsx",
  "app/faiblesses/page.tsx",
  "app/mock/[id]/page.tsx",
  "app/oauth/authorize/page.tsx",
  "app/page.tsx",
  "app/programme/page.tsx",
  "app/qa/QaHarness.tsx",
  "app/recherche/page.tsx",
  "app/revision/page.tsx",
  "app/signalements/page.tsx",
  "app/sources/locale/page.tsx",
  "app/sources/page.tsx",
  "components/billing/PaywallNotice.tsx",
  "components/cours/CourseForm.tsx",
  "components/cours/CourseList.tsx",
  "components/cours/ExamFormatFields.tsx",
  "components/dashboard/FirstRunHero.tsx",
  "components/dashboard/JobBanner.tsx",
  "components/dashboard/JobProgress.tsx",
  "components/dashboard/OnboardingHero.tsx",
  "components/dashboard/PriorityHero.tsx",
  "components/dashboard/QuietDoors.tsx",
  "components/dashboard/StepList.tsx",
  "components/dashboard/UpNext.tsx",
  "components/entrainement/LabsSeries.tsx",
  "components/entrainement/TrainingStudio.tsx",
  "components/exam/BlockExam.tsx",
  "components/exam/ExamFrame.tsx",
  "components/exam/OpenResponse.tsx",
  "components/exam/ReportButton.tsx",
  "components/examens/ExamComposer.tsx",
  "components/faiblesses/WeaknessBase.tsx",
  "components/faiblesses/WeaknessInbox.tsx",
  "components/programme/ChapterAccordion.tsx",
  "components/programme/NotionRow.tsx",
  "components/programme/ProgramExplorer.tsx",
  "components/programme/ReanalyzeButton.tsx",
  "components/recherche/SearchExperience.tsx",
  "components/shell/AppShell.tsx",
  "components/shell/CourseSelector.tsx",
  "components/shell/Logo.tsx",
  "components/shell/NavList.tsx",
  "components/shell/MobileNav.tsx",
  "components/shell/Sidebar.tsx",
  "components/shell/ThemeToggle.tsx",
  "components/shell/Topbar.tsx",
  "components/sources/FileManager.tsx",
  "components/sources/ImportPanel.tsx",
  "components/sources/OriginalsNotes.tsx",
  "components/ui/ImageTextArea.tsx",
  "components/viz/ForgettingCurve.tsx",
  "components/viz/Sparkline.tsx",
  "components/viz/WaffleGrid.tsx",
  "lib/ux/api.tsx",
  "lib/ux/job-watch.ts",
  "lib/ux/labels.tsx",
  "lib/ux/mock.ts",
  "lib/ux/next-up.ts",
  "lib/ux/program.ts",
  "lib/ux/search.ts",
  "lib/ux/sources.ts",
  "lib/ux/training.ts",
  "lib/ux/types.ts",
  "lib/ux/weaknesses.ts",
]);

const files = uiFiles(ROOT);
const report = (hits: ReturnType<typeof scanSource>) => hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n");

test("aucun texte en dur hors des fichiers encore à migrer", () => {
  const hits = files.filter((f) => !PENDING.has(f)).flatMap((f) => scanSource(f, fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.equal(hits.length, 0, `texte d'interface en dur (à mettre dans messages/*.json) :\n${report(hits)}`);
});

test("la liste des fichiers à migrer ne fait que rétrécir", () => {
  const clean = [...PENDING].filter((f) => !fs.existsSync(path.join(ROOT, f)) || scanSource(f, fs.readFileSync(path.join(ROOT, f), "utf8")).length === 0);
  assert.deepEqual(clean, [], "fichiers migrés (ou supprimés) à retirer de PENDING");
});

test("le détecteur voit le texte en dur et laisse passer le code", () => {
  const hits = scanSource("x.tsx", [
    "import { a } from \"./où\";",
    "const L = { ok: \"Créer le cours\" };",
    "export const X = () => <p className=\"text-ink-2 max-w\" aria-label=\"Fermer la fenêtre\">",
    "  {t(\"common.close\")} Bonjour",
    "  {/* i18n-allow: marque */}",
    "  <b>cortex</b>",
    "  <input placeholder=\"Search\" title={\"Delete course\"} alt=\"\" aria-label={label} />",
    "</p>;",
  ].join("\n"));
  // Un libellé d'attribut lu à l'écran est pris en toute langue ; du code ({label}, "") passe.
  assert.deepEqual(hits.map((h) => h.text), ["Créer le cours", "Fermer la fenêtre", "Bonjour", "Search", "Delete course"]);
  assert.ok(looksFrench("Tu as 3 crédits"));
  assert.ok(looksFrench("Pour le cours de demain"));
  assert.ok(!looksFrench("Create the course"));
  assert.ok(!looksFrench("h-10 rounded-md px-3"));
});
