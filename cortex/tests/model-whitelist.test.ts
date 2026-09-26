/**
 * LOT 2b-1 — le CLIENT ne choisit pas le modèle facturé.
 *  - weaknesses/process acceptait n'importe quelle chaîne `model` : un id complet
 *    (« claude-opus-4-8 ») traversait mapModel tel quel et contournait LLM_ALLOW_OPUS ;
 *  - mapModel refuse désormais tout id non logique sur un fournisseur payant ;
 *  - un modèle sans tarif connu est compté au tarif LE PLUS CHER de la grille.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-model-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "test";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_ALLOW_OPUS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("mapModel : un id complet est refusé sur un fournisseur payant, les alias logiques passent", async () => {
  const { mapModel, isLlmModel } = await import("../lib/llm/config");
  delete process.env.LLM_ALLOW_OPUS;
  assert.equal(mapModel("opus", "anthropic"), "claude-sonnet-5", "opus → sonnet sans LLM_ALLOW_OPUS");
  assert.equal(mapModel("haiku", "anthropic"), "claude-haiku-4-5-20251001");
  assert.throws(() => mapModel("claude-opus-4-8" as never, "anthropic"), /refusé|non autorisé/i);
  assert.throws(() => mapModel("gpt-5" as never, "openai-compatible"), /refusé|non autorisé/i);
  assert.equal(mapModel("opus", "claude-code"), "opus", "le CLI local garde le passthrough des alias");
  assert.equal(isLlmModel("sonnet"), true);
  assert.equal(isLlmModel("claude-sonnet-5"), false);
});

test("tarif inconnu → tarif le plus cher de la grille (jamais sous-compté)", async () => {
  const { rateFor } = await import("../lib/billing/usage");
  const unknown = rateFor("modele-inconnu-x");
  const top = rateFor("claude-fable-5-1");
  assert.deepEqual(unknown, top);
  assert.ok(unknown.outPerM >= rateFor("claude-opus-4-8").outPerM);
});

test("weaknesses/process : `model` hors liste blanche → 400 avant toute lecture ou débit", async () => {
  const { POST } = await import("../app/api/weaknesses/process/route");
  const post = (body: unknown) => new NextRequest("http://cortex.test/api/weaknesses/process?course=cs-202", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const r = await POST(post({ id: 1, model: "claude-opus-4-8" }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /modèle/i);
  const r2 = await POST(post({ model: "sonnet" }));
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /id manquant/, "un alias valide passe la validation du modèle (ici : id absent)");
});
