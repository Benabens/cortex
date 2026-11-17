/**
 * AUDIT FUITES DU 17/11, I6 — un fichier embarqué (<img>, <iframe>) ne peut pas partir du seau
 * (CSP « 'self' ») : il sort par le serveur, à payer. Un script qui le relit en boucle n'avait
 * aucune limite. Désormais FILES_SERVED_MB_PER_DAY Mo relayés par compte et par jour (défaut
 * 2048) ; au-delà, 429 jusqu'au lendemain. Une redirection vers le seau ne compte pas.
 *
 * Seam : lib/served-bytes serveCounted.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

after(() => { delete process.env.FILES_SERVED_MB_PER_DAY; });

const MB = 1024 * 1024;
const file = (bytes: number) => async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-length": String(bytes) } });

test("I6 : au-delà de FILES_SERVED_MB_PER_DAY Mo relayés dans la journée, 429 ; un autre compte n'est pas touché ; le lendemain, de nouveau", async () => {
  process.env.FILES_SERVED_MB_PER_DAY = "3";
  const { serveCounted, resetServedBytesForTests } = await import("../lib/served-bytes");
  resetServedBytesForTests();
  const day1 = Date.parse("2026-11-17T10:00:00Z");
  assert.equal((await serveCounted("ana", file(2 * MB), day1))?.status, 200);
  assert.equal((await serveCounted("ana", file(2 * MB), day1))?.status, 200, "le fichier qui fait passer la limite est encore servi");
  const refused = await serveCounted("ana", file(1), day1);
  assert.equal(refused?.status, 429);
  assert.match(await refused!.text(), /demain/);
  assert.equal((await serveCounted("ben", file(2 * MB), day1))?.status, 200);
  assert.equal((await serveCounted("ana", file(1), day1 + 24 * 3600_000))?.status, 200);
});

test("I6 : une redirection vers le seau (302) et un 404 ne comptent pas", async () => {
  process.env.FILES_SERVED_MB_PER_DAY = "1";
  const { serveCounted, resetServedBytesForTests } = await import("../lib/served-bytes");
  resetServedBytesForTests();
  const now = Date.parse("2026-11-17T10:00:00Z");
  const redirect = async () => new Response(null, { status: 302, headers: { location: "https://bucket.example.test/x", "content-length": String(50 * MB) } });
  for (let i = 0; i < 3; i++) assert.equal((await serveCounted("ana", redirect, now))?.status, 302);
  assert.equal(await serveCounted("ana", async () => null, now), null);
  assert.equal((await serveCounted("ana", file(1), now))?.status, 200);
});

test("I6 : une requête HEAD (taille sans corps) ne compte pas", async () => {
  process.env.FILES_SERVED_MB_PER_DAY = "1";
  const { serveCounted, resetServedBytesForTests } = await import("../lib/served-bytes");
  resetServedBytesForTests();
  const now = Date.parse("2026-11-17T10:00:00Z");
  const head = async () => new Response(null, { status: 200, headers: { "content-length": String(5 * MB) } });
  assert.equal((await serveCounted("ana", head, now))?.status, 200);
  assert.equal((await serveCounted("ana", file(1), now))?.status, 200);
});

test("I6 : des requêtes parallèles s'additionnent toutes (pas de mise à jour perdue)", async () => {
  process.env.FILES_SERVED_MB_PER_DAY = "3";
  const { serveCounted, resetServedBytesForTests } = await import("../lib/served-bytes");
  resetServedBytesForTests();
  const now = Date.parse("2026-11-17T10:00:00Z");
  const slow = async () => { await new Promise((ok) => setTimeout(ok, 20)); return file(1024 * 1024)(); };
  await Promise.all(Array.from({ length: 4 }, () => serveCounted("ana", slow, now)));
  assert.equal((await serveCounted("ana", file(1), now))?.status, 429, "4 Mo servis en parallèle > 3 Mo");
});
