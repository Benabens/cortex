import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * I4 — Les routes qui acceptent du multipart lisaient tout le corps en mémoire
 * (req.formData()) AVANT de contrôler la taille : un seul client pouvait faire
 * tomber le conteneur unique. Le refus doit se faire sur Content-Length, avant
 * toute lecture du corps.
 */

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { NextRequest } from "next/server";
import { ensureCoursesLoaded, resetCoursesCache } from "../lib/courses";

const GIB = 1024 * 1024 * 1024;
type Init = ConstructorParameters<typeof NextRequest>[1];

/** Corps multipart minuscule, mais Content-Length annonçant 4 Gio : la route ne doit jamais tenter de le lire. */
function hugeMultipart(): NextRequest {
  const boundary = "----cortexTest";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`;
  const headers = new Headers({
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(4 * GIB),
  });
  // Corps sous forme de flux : sa lecture serait détectable (et coûteuse) ; ici elle n'a pas lieu.
  return new NextRequest("http://cortex.test/api/x?course=cs-202", { method: "POST", headers, body, duplex: "half" } as Init);
}

const ROUTES = [
  { name: "POST refs/upload", load: () => import("../app/api/refs/upload/route") },
  { name: "POST sources", load: () => import("../app/api/sources/route") },
  { name: "POST exercises/generate", load: () => import("../app/api/exercises/generate/route") },
  { name: "POST check-solution", load: () => import("../app/api/check-solution/route") },
  { name: "POST weaknesses", load: () => import("../app/api/weaknesses/route") },
];

before(async () => {
  delete process.env.CORTEX_USER;
  resetCoursesCache();
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER;
  delete process.env.DATABASE_URL;
  resetCoursesCache();
});

test("I4 — un Content-Length démesuré est refusé en 413 avant lecture du corps", async () => {
  const failures: string[] = [];
  for (const rc of ROUTES) {
    const mod = await rc.load();
    let status: number | string;
    try {
      status = (await mod.POST(hugeMultipart())).status;
    } catch (e) {
      status = `exception ${(e as Error).message.slice(0, 60)}`;
    }
    if (status !== 413) failures.push(`${rc.name} → ${status}`);
  }
  assert.deepEqual(failures, [], `routes qui lisent un corps trop gros :\n  ${failures.join("\n  ")}`);
});

test("I4 — multipart sans Content-Length → 411 (on ne lit pas un corps de taille inconnue)", async () => {
  const mod = await import("../app/api/refs/upload/route");
  // Un corps texte n'ajoute PAS de Content-Length aux en-têtes de la requête (vérifié sous Node).
  const headers = new Headers({ "content-type": "multipart/form-data; boundary=x" });
  const req = new NextRequest("http://cortex.test/api/x?course=cs-202", { method: "POST", headers, body: "--x--\r\n", duplex: "half" } as Init);
  assert.equal(req.headers.get("content-length"), null);
  const res = await mod.POST(req);
  assert.equal(res.status, 411, await res.text());
});
