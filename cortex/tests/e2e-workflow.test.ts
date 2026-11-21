import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = fs.readFileSync("../.github/workflows/e2e.yml", "utf8");

test("le parcours Google réel est exclu du cron et activable manuellement", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+google_reel:/);
  assert.match(workflow, /name: Google réel[^\n]*\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.google_reel/);
  assert.doesNotMatch(workflow, /name: Google réel[^\n]*\n\s+if: github\.event_name == 'schedule'/);
});

/**
 * La charge de nuit (e2e/load.ts) crée un compte PAR utilisateur simulé (jamais le
 * propriétaire) et lance une vraie génération facturée. Deux garde-fous indépendants
 * peuvent la refuser en 402 même quand elle n'est pas en cause : le crédit
 * d'inscription (SIGNUP_FREE_CREDITS, insuffisant face au prix réel du type facturé
 * par e2e/load.ts) et le budget IA lié au revenu (nul sans paiement Stripe, donc
 * sans AI_BUDGET_MARGIN=unlimited il bloque même un crédit d'inscription suffisant).
 * Régression du 19-21/11 : le prix "assist" était passé à 0,3 (#114) sans que ce
 * budget du YAML suive — reproduit en local (401 → 200 après correction).
 */
test("la charge de nuit finance assez de crédit d'inscription et lève le budget IA lié au revenu", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-workflow-"));
  process.env.CORTEX_DATA_DIR = tmp;
  const { creditCost, fromCenti } = await import("../lib/billing/credits");

  const step = workflow.match(/name: Charge légère Linux \(nuit\)[\s\S]*?(?=\n {6}- name:|\n {4}- uses:)/)?.[0];
  assert.ok(step, "étape « Charge légère Linux (nuit) » introuvable dans le workflow");

  const signup = Number(step!.match(/SIGNUP_FREE_CREDITS=(\S+)/)?.[1]);
  assert.ok(Number.isFinite(signup), "SIGNUP_FREE_CREDITS absent ou non numérique dans l'étape de charge");
  // e2e/load.ts n'appelle que /api/drill (bucket "assist") : le crédit d'inscription
  // doit couvrir au moins une génération à ce prix, sans dépendre d'un override de test.
  delete process.env.CREDITS_COST_JSON;
  const assistCost = fromCenti(creditCost("assist"));
  assert.ok(signup > assistCost, `SIGNUP_FREE_CREDITS (${signup}) doit financer au moins une génération "assist" (${assistCost})`);

  assert.match(step!, /AI_BUDGET_MARGIN=unlimited/, "le budget IA lié au revenu (nul sans paiement Stripe en charge) doit être levé pour cette étape");
});
