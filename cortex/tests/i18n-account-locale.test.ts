/**
 * Préférence de langue du compte (users.locale) : posée par POST /api/account/locale,
 * relue pour l'interface, les e-mails et le connecteur MCP (qui n'ont pas de navigateur).
 * Banc Postgres (PGlite) : la colonne arrive par la migration additive d'une base existante.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-locale-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
delete process.env.CORTEX_USER;

before(async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email) VALUES ($1, $2)`, "u-loc", "loc@example.test");
});

function post(body: unknown, user: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-cortex-user"] = user;
  return new NextRequest("http://localhost/api/account/locale", { method: "POST", headers, body: JSON.stringify(body) });
}

test("compte sans choix : null (l'interface retombe sur le cookie puis Accept-Language)", async () => {
  const { accountLocale } = await import("../lib/i18n/account-locale");
  assert.equal(await accountLocale("u-loc"), null);
  assert.equal(await accountLocale("inconnu"), null);
});

test("POST /api/account/locale : enregistre la langue du compte et pose le cookie", async () => {
  const { POST } = await import("../app/api/account/locale/route");
  const { accountLocale } = await import("../lib/i18n/account-locale");
  const res = await POST(post({ locale: "fr" }, "u-loc"));
  assert.equal(res.status, 200);
  assert.equal(await accountLocale("u-loc"), "fr");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /cortex_locale=fr/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d{7,}/, "un an : le choix survit à la fermeture du navigateur");

  await POST(post({ locale: "en" }, "u-loc"));
  assert.equal(await accountLocale("u-loc"), "en");
});

test("POST /api/account/locale : langue non livrée refusée, rien d'écrit", async () => {
  const { POST } = await import("../app/api/account/locale/route");
  const { accountLocale } = await import("../lib/i18n/account-locale");
  for (const locale of ["de", "", null, "<x>"]) {
    const res = await POST(post({ locale }, "u-loc"));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal(await accountLocale("u-loc"), "en");
});

test("première visite d'un compte sans choix : la langue négociée est copiée, une seule fois", async () => {
  const { authRun } = await import("../db/auth-store");
  const { accountLocale, adoptLocaleOnce } = await import("../lib/i18n/account-locale");
  await authRun(`INSERT INTO users (id, email) VALUES ($1, $2)`, "u-new", "new@example.test");
  await adoptLocaleOnce("u-new", "fr");
  assert.equal(await accountLocale("u-new"), "fr");
  await adoptLocaleOnce("u-new", "en");
  assert.equal(await accountLocale("u-new"), "fr", "un choix existant n'est jamais écrasé");
});
