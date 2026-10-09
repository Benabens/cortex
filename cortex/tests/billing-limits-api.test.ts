/**
 * LIMITES DU COMPTE et COÛT D'UN COURS exposés par /api/billing — ce que l'écran
 * « Abonnement & crédits » affiche au-dessus des offres. Ce sont les limites
 * EFFECTIVES : la valeur posée, sinon le défaut du déploiement gardé, et rien
 * quand la limite est levée. L'écran ne doit jamais annoncer un chiffre que le
 * serveur n'applique pas.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-limites-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
const env = process.env as Record<string, string | undefined>;
const LIMITS = ["DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "STORAGE_QUOTA_MB"];

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", ...LIMITS]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("/api/billing : limites effectives du compte (défauts du déploiement gardé, valeurs posées, limites levées)", async () => {
  const billing = await import("../app/api/billing/route");
  const read = async () => {
    const res = await billing.GET(new NextRequest("http://cortex.test/api/billing", { headers: { "x-cortex-user": "alice" } }) as never);
    const body = (await res.json()) as { quotas: unknown; storageQuotaMb: unknown; costs: { prepare: unknown; format: unknown } };
    assert.deepEqual([body.costs.prepare, body.costs.format], [2, 1], "ce que coûte un cours : préparation, puis chaque ajout d'annales");
    return { quotas: body.quotas, storageQuotaMb: body.storageQuotaMb };
  };
  for (const k of LIMITS) delete env[k];
  assert.deepEqual(await read(), { quotas: { gen: 10, assist: 40 }, storageQuotaMb: 200 }, "rien de posé : les défauts s'appliquent, donc s'affichent");
  env.DAILY_GEN_QUOTA = "3"; env.DAILY_ASSIST_QUOTA = "20"; env.STORAGE_QUOTA_MB = "500";
  assert.deepEqual(await read(), { quotas: { gen: 3, assist: 20 }, storageQuotaMb: 500 });
  for (const k of LIMITS) env[k] = "unlimited";
  assert.deepEqual(await read(), { quotas: { gen: null, assist: null }, storageQuotaMb: null }, "limite levée : aucun chiffre");
});
