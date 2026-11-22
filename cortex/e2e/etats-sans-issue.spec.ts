import { test, expect } from "@playwright/test";
import { loginPersona } from "./helpers";
import { minimalPdf } from "./i18n-helpers";

/**
 * Écrans sans issue relevés par la chasse aux bugs du 22/11/2026 :
 *  - Programme vide qui disait de cliquer « Ré-analyser les annales », bouton absent de cet état ;
 *  - titres de Sources coupés à « Final Exam 2024-202… » sur desktop (annale et corrigé indistincts) ;
 *  - examen blanc introuvable : « Mock introuvable. » et un « Réessayer » qui ne pouvait rien changer ;
 *  - fichier déposé avant que la liste des cours revienne : envoyé avec `course=` vide, lu par le
 *    serveur comme le cours par défaut (« Cours inconnu : cs-202 », ou rangé dans le mauvais cours).
 */
test("un cours neuf : consignes qui mènent quelque part, titres lisibles, examen introuvable", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 }); // MacBook 14" : largeur où la ligne coupait le titre
  await loginPersona(page, `etats-${Date.now()}`);
  await page.goto("/cours/nouveau");
  const courseName = `Analyse ${Date.now()}`;
  await page.getByRole("textbox", { name: "Nom du cours" }).fill(courseName);
  await page.getByRole("button", { name: "Créer le cours" }).click();
  await expect(page).toHaveURL(/\/sources/);
  const course = await page.evaluate(async (name) => {
    const { courses } = await (await fetch("/api/courses")).json() as { courses: Array<{ id: string; name: string }> };
    return courses.find((c) => c.name === name)?.id ?? null;
  }, courseName);
  expect(course).toBeTruthy();

  // Programme vide : la consigne nomme le bouton que Sources affiche vraiment.
  await page.goto(`/programme?course=${course}`);
  await expect(page.getByText("Aucune notion analysée pour ce cours")).toBeVisible();
  await expect(page.getByText(/«\s*Préparer le cours\s*»/)).toBeVisible();
  await expect(page.getByText("Ré-analyser les annales")).toHaveCount(0);

  // Sources : un titre d'annale long reste lisible en entier à côté de ses actions.
  // Dépôt immédiat, sans attendre la liste des cours : la page doit le garder pour SON cours.
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/courses", async (route) => { await held; await route.continue(); });
  await page.goto(`/sources?course=${course}`);
  const title = "Final Exam 2024-2025 with solutions";
  const uploads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/refs/upload")) uploads.push(new URL(r.url()).searchParams.get("course") ?? ""); });
  await expect(page.getByText("Chargement du cours…")).toBeVisible();
  await expect(page.locator('input[type="file"]').first()).toBeDisabled();
  release();
  await expect(page.getByRole("button", { name: /Glisse un examen/ })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name: `${title}.pdf`, mimeType: "application/pdf", buffer: minimalPdf() });
  await expect(page.getByText(/fichiers? (ingéré|déposé)/i).first()).toBeVisible();
  expect(uploads).toEqual([course]);
  const row = page.locator(`[title="${title.replaceAll(" ", "_")}"]`).first(); // titre = nom du fichier
  await expect(row).toBeVisible();
  const clipped = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(clipped, "le titre de l'annale est coupé").toBe(false);

  // Examen blanc inexistant : on le dit, et on renvoie vers les examens du cours.
  await page.goto(`/mock/999999?course=${course}`);
  await expect(page.getByRole("alert").filter({ hasText: "Examen blanc introuvable." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Retour aux examens" })).toHaveAttribute("href", `/examens?course=${course}`);
  await expect(page.getByRole("button", { name: "Réessayer" })).toHaveCount(0);
});
