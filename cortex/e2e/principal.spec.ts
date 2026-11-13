import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";

async function api<T>(page: Page, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  }, { path, init });
}

function minimalPdf(): Buffer {
  const stream = "BT /F1 12 Tf 30 100 Td (Annale integrales E2E) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let text = "%PDF-1.4\n", offset = text.length; const offsets = [0];
  for (const object of objects) { offsets.push(offset); text += object; offset += object.length; }
  const xref = offset;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("@principal onboarding complet, PDF, préparation, drill, correction et examen blanc", async ({ page }) => {
  await loginPersona(page, "owner");
  await page.goto("/cours/nouveau");
  const courseName = `Analyse E2E ${Date.now()}`;
  await page.getByRole("textbox").first().fill(courseName);
  await page.getByRole("button", { name: "Créer le cours" }).click();
  await expect(page).toHaveURL(/\/sources/);

  const pdf = minimalPdf();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "annale-e2e.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByText(/fichier.*ingéré/i)).toBeVisible();
  await page.getByRole("button", { name: "Préparer le cours" }).click();
  await expect(page.getByText(/Cours préparé/i)).toBeVisible();
  const catalog = await api<{ courses: Array<{ id: string; name: string }> }>(page, "/api/courses");
  const course = catalog.body.courses.find((item) => item.name === courseName)?.id; expect(course).toBeTruthy();

  const drill = await api<{ drill: { statement_html: string } }>(page, `/api/drill?course=${encodeURIComponent(course!)}`, { method: "POST", body: JSON.stringify({ concept: "intégrales" }) });
  expect(drill.status).toBe(200); expect(drill.body.drill.statement_html).toContain("Calcule");
  const correction = await api<{ result: { verdict: string } }>(page, `/api/check-solution?course=${encodeURIComponent(course!)}`, { method: "POST", body: JSON.stringify({ statement: "Calcule ∫₀¹ x dx", answer: "1" }) });
  expect(correction.status).toBe(200); expect(correction.body.result.verdict).toBe("wrong");
  const exam = await api<{ ok: boolean }>(page, `/api/exams/generate?dry=1&course=${encodeURIComponent(course!)}`, { method: "POST", body: "{}" });
  expect(exam.status).toBe(200); expect(exam.body.ok).toBeTruthy();
  await page.goto("/examens"); await expect(page.getByRole("heading", { name: "Examens prêts" })).toBeVisible();
});

test("nouveau compte à 0 crédit : import et consultation gratuits, préparation et génération paywallées", async ({ page }) => {
  await loginPersona(page, `nocredit-${Date.now()}`);
  const normal = await api<{ quotas: { gen: number | null }; balance: number }>(page, "/api/billing");
  expect(normal.body.balance).toBe(0); expect(normal.body.quotas.gen).not.toBeNull();
  const created = await api<{ course: { id: string } }>(page, "/api/courses", { method: "POST", body: JSON.stringify({ name: `Cours sans crédit ${Date.now()}` }) });
  expect(created.status).toBe(201);

  const imported = await page.request.post(`/api/sources/add?course=${encodeURIComponent(created.body.course.id)}&category=lecture`, {
    multipart: { file: { name: "cours.txt", mimeType: "text/plain", buffer: Buffer.from("Cours E2E sur les limites et les intégrales.") } },
  });
  expect(imported.status()).toBe(200);
  const catalog = await api<{ courses: unknown[] }>(page, "/api/courses");
  expect(catalog.status).toBe(200); expect(catalog.body.courses.length).toBeGreaterThan(0);

  await page.goto(`/sources?course=${encodeURIComponent(created.body.course.id)}`);
  await page.getByRole("button", { name: "Préparer le cours" }).click();
  await expect(page.getByRole("dialog", { name: "Crédits requis" })).toContainText("Il te faut 2 crédits");
  await expect(page.getByRole("link", { name: "Acheter" })).toHaveAttribute("href", "/compte#credits");

  const denied = await api<{ error: string }>(page, `/api/exams/generate?course=${encodeURIComponent(created.body.course.id)}`, { method: "POST", body: "{}" });
  expect(denied.status).toBe(402); expect(denied.body.error).toMatch(/2 crédit/i);

  await page.context().clearCookies(); await loginPersona(page, "owner");
  const owner = await api<{ quotas: { gen: number | null; assist: number | null } }>(page, "/api/billing");
  expect(owner.body.quotas).toEqual({ gen: null, assist: null });
});

test("suppression du compte déconnecte et efface l'accès", async ({ page }) => {
  await loginPersona(page, `delete-${Date.now()}`);
  await page.goto("/compte");
  await page.getByRole("button", { name: "Supprimer mon compte" }).click();
  await page.getByLabel(/Pour confirmer/).fill("SUPPRIMER");
  await page.getByRole("button", { name: "Supprimer définitivement" }).click();
  await expect(page).toHaveURL(/\/login|\/$/);
  const response = await page.request.get("/api/courses"); expect(response.status()).toBe(401);
});

test("un visiteur sans session ne peut pas appeler les API privées", async ({ request }) => {
  expect((await request.get("/api/courses")).status()).toBe(401);
});
