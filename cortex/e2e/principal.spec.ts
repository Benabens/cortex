import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("@principal importe un dossier de 60 Mo par fichiers bornés et signale un fichier trop gros", async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-folder-e2e-"));
  try {
    const chapter = path.join(root, "chapitre-1");
    const scans = path.join(root, "scans");
    fs.mkdirSync(chapter); fs.mkdirSync(scans);
    for (let index = 0; index < 4; index++) {
      const destination = index < 2 ? chapter : scans;
      fs.writeFileSync(path.join(destination, `notes-${index}.txt`), Buffer.alloc(15 * 1024 * 1024, 0x61 + index));
    }
    fs.writeFileSync(path.join(root, ".DS_Store"), "ignoré");

    await loginPersona(page, "owner");
    await page.goto("/cours/nouveau");
    await page.getByRole("textbox").first().fill(`Dossier E2E ${Date.now()}`);
    await page.getByRole("button", { name: "Créer le cours" }).click();
    const folder = page.getByLabel("Dossier de cours à importer");
    await page.route("**/api/sources/import?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("action") === "finish") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await route.continue();
    });
    await folder.setInputFiles(root);
    await expect(page.getByText(/Envoi de 4\/4 fichiers/)).toBeVisible();
    await expect(page.getByText(/4 fichiers déposés/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Dossier ingéré/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("notes-0.txt", { exact: false })).toBeVisible();

    const oversized = path.join(root, "trop-gros.pdf");
    fs.writeFileSync(oversized, Buffer.alloc(30 * 1024 * 1024 + 1));
    await folder.setInputFiles(root);
    await expect(page.getByText(/trop-gros\.pdf.*30 Mo maximum par fichier/)).toBeVisible();

    await page.getByRole("button", { name: "Préparer le cours" }).click();
    await expect(page.getByText(/Cours préparé/)).toBeVisible({ timeout: 60_000 });
    await page.goto("/programme");
    await expect(page.getByRole("heading", { name: "Programme" })).toBeVisible();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("utilisateur sans crédit bloqué proprement et propriétaire sans limite", async ({ page }) => {
  await loginPersona(page, `nocredit-${Date.now()}`);
  const normal = await api<{ quotas: { gen: number | null }; balance: number }>(page, "/api/billing");
  expect(normal.body.balance).toBe(0.1); expect(normal.body.quotas.gen).not.toBeNull();
  const created = await api<{ course: { id: string } }>(page, "/api/courses", { method: "POST", body: JSON.stringify({ name: `Cours sans crédit ${Date.now()}` }) });
  expect(created.status).toBe(201);
  const spent = await api(page, `/api/drill?course=${encodeURIComponent(created.body.course.id)}`, { method: "POST", body: JSON.stringify({ concept: "limites" }) });
  expect(spent.status).toBe(200);
  const empty = await api<{ balance: number }>(page, "/api/billing"); expect(empty.body.balance).toBe(0);
  const denied = await api<{ error: string }>(page, `/api/drill?course=${encodeURIComponent(created.body.course.id)}`, { method: "POST", body: JSON.stringify({ concept: "limites" }) });
  expect(denied.status).toBe(402); expect(denied.body.error).toMatch(/crédit/i);
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
