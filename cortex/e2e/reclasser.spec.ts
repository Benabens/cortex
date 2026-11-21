import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";

/**
 * Reclasser un fichier mal rangé depuis la liste des sources (audit ingestion du 16/11, P1-2) :
 * un support de cours qui est en fait un partiel devient une annale, au clavier, sans crédit.
 */

async function api<T>(page: Page, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  }, { path, init });
}

function textPdf(line: string): Buffer {
  const stream = `BT /F1 12 Tf 30 100 Td (${line}) Tj ET\n`;
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

async function waitJob(page: Page, course: string, id: number): Promise<string> {
  let status = "queued";
  await expect.poll(async () => {
    status = (await api<{ status: string }>(page, `/api/jobs/${id}?course=${encodeURIComponent(course)}`)).body.status;
    return ["queued", "running", "verifying", "compiling"].includes(status);
  }, { timeout: 60_000 }).toBe(false);
  return status;
}

test("un support rangé en cours est reclassé comme partiel, au clavier, et compte comme annale", async ({ page }) => {
  await loginPersona(page, "owner");
  const created = await api<{ course: { id: string } }>(page, "/api/courses", { method: "POST", body: JSON.stringify({ name: `Reclasser E2E ${Date.now()}` }) });
  expect(created.status).toBe(201);
  const course = created.body.course.id;

  const added = await page.request.post(`/api/sources/add?course=${encodeURIComponent(course)}&category=lecture`, {
    multipart: { file: { name: "partiel-orvelle-2021.pdf", mimeType: "application/pdf", buffer: textPdf("Partiel Orvelle 2021, exercice 1 : ondes amorties") } },
  });
  expect(added.status()).toBe(200);
  const ingest = await api<{ jobId: number }>(page, `/api/sources/import?course=${encodeURIComponent(course)}&action=finish`, { method: "POST", body: "{}" });
  expect(ingest.status).toBe(200);
  expect(await waitJob(page, course, ingest.body.jobId)).toBe("done");

  await page.goto(`/sources?course=${encodeURIComponent(course)}`);
  const facets = page.getByRole("radiogroup", { name: "Type de fichiers" });
  await facets.getByRole("radio", { name: /Cours \(PDF\)/ }).click();
  const open = page.getByRole("button", { name: /comme annale$/ });
  await open.focus();
  await page.keyboard.press("Enter");

  // Le formulaire s'ouvre sur le type d'épreuve ; type et année viennent du nom du fichier.
  const form = page.getByRole("form", { name: /comme annale$/ });
  await expect(form.getByRole("radio", { name: "Partiel" })).toBeFocused();
  await expect(form.getByRole("radio", { name: "Partiel" })).toBeChecked();
  await expect(form.getByRole("spinbutton", { name: /Année/ })).toHaveValue("2021");
  await page.keyboard.press("ArrowLeft");
  await expect(form.getByRole("radio", { name: "Final" })).toBeChecked();
  // Échap ferme le formulaire et rend le focus au bouton d'origine.
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(open).toBeFocused();

  await page.keyboard.press("Enter");
  await form.getByRole("radio", { name: "Partiel" }).check();
  const classified = page.waitForResponse((r) => r.url().includes("/api/sources/classify"));
  await form.getByRole("button", { name: "Classer comme annale" }).click();
  const res = await classified;
  expect(res.status()).toBe(200);
  const { jobId, path } = await res.json();
  expect(path).toBe("refs/partiel-orvelle-2021.pdf");
  await expect(page.getByRole("status").filter({ hasText: /rangé dans les annales/ })).toBeVisible();
  expect(await waitJob(page, course, jobId)).toBe("done");
  await expect(page.getByRole("status").filter({ hasText: "Corpus à jour." })).toBeVisible();

  // La liste des annales le montre, et le serveur le compte comme partiel de 2021.
  await facets.getByRole("radio", { name: /Annales/ }).click();
  await expect(page.getByRole("button", { name: /Modifier l’année et le type d’épreuve/ })).toBeVisible();
  const sources = await api<{ exams: Array<{ path: string; kind: string; year: number | null }>; sources: Array<{ path: string }> }>(
    page, `/api/sources?course=${encodeURIComponent(course)}`,
  );
  expect(sources.body.exams.map((e) => [e.path, e.kind, e.year])).toEqual([["refs/partiel-orvelle-2021.pdf", "midterm", 2021]]);
  expect(sources.body.sources.filter((s) => s.path.endsWith("partiel-orvelle-2021.pdf")).map((s) => s.path)).toEqual(["refs/partiel-orvelle-2021.pdf"]);
});
