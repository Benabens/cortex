import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as z from "zod/v4";

/**
 * DESCRIPTIONS DES OUTILS MCP, telles que les annuaires (Claude, ChatGPT) et les
 * clients les lisent par tools/list :
 *  - aucun coût chiffré (le coût exact vient du premier appel, le tarif de
 *    get_account_status) : claude.ai garde la liste en cache, un prix écrit ici
 *    redevient faux au premier changement de CREDITS_COST_JSON ;
 *  - une description du comportement de l'outil, jamais un ordre au modèle : la
 *    consigne de demander l'accord vit dans les instructions du serveur ;
 *  - figées par un instantané : tout changement de texte est relu dans la PR.
 *
 * Régénérer l'instantané après une modification voulue :
 *   UPDATE_MCP_DESCRIPTIONS=1 npx tsx --test tests/mcp-descriptions.test.ts
 */

const SNAPSHOT = path.join(__dirname, "fixtures", "mcp-tool-descriptions.json");

type Texts = { name: string; description: string; fields: string[] };

/** Description de l'outil + celles de ses champs d'entrée et de sortie (publiées elles aussi). */
async function texts(): Promise<Texts[]> {
  const { TOOLS } = await import("../lib/mcp/registry");
  const collect = (node: unknown, out: string[]) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else collect(v, out);
    }
  };
  return TOOLS.map((t) => {
    const fields: string[] = [];
    collect(z.toJSONSchema(t.input, { io: "input" }), fields);
    collect(z.toJSONSchema(t.output, { io: "output" }), fields);
    return { name: t.name, description: t.description, fields };
  });
}

/** Un nombre accolé à un mot de coût, dans un sens ou dans l'autre (« 0.1 credit », « costs 2 », « credits (2 by default) »). */
const HARD_CODED_COST = [
  /\d+(?:[.,]\d+)?\s*(?:credits?|crédits?)\b/i,
  /\b(?:costs?|credits?)\b[^.;:]{0,25}?\(?\s*\d/i,
  /\d[^.;]{0,20}\bby default\b/i,
  /\+\s*\d+\s*per\b/i,
];

/** Ordres adressés au modèle (au lieu de décrire ce que fait l'outil). */
const ORDERS_TO_MODEL = /\bask the (?:user|student)\b|\bONLY after\b|\bonly after (?:they|the user)\b|\bcall (?:this|it) first\b|\buse (?:it|this) (?:when|before|to|for)\b|\byou (?:must|should)\b|\bmake sure\b|\bpoll\b|\bnever confirm\b|\bwait for\b/i;

test("instantané des descriptions d'outils (régénérer avec UPDATE_MCP_DESCRIPTIONS=1)", async () => {
  const now = Object.fromEntries((await texts()).map((t) => [t.name, t.description]));
  if (process.env.UPDATE_MCP_DESCRIPTIONS === "1") {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`);
  }
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(now, saved, "descriptions modifiées : relire puis régénérer l'instantané");
  assert.equal(Object.keys(now).length, 15);
});

test("aucun coût chiffré dans les descriptions d'outils ni dans celles de leurs champs", async () => {
  for (const t of await texts()) {
    for (const s of [t.description, ...t.fields]) {
      for (const re of HARD_CODED_COST) assert.doesNotMatch(s, re, `${t.name} : « ${s.slice(0, 140)} »`);
    }
  }
});

test("le motif « coût chiffré » attrape bien les anciennes formulations", () => {
  for (const old of [
    "Costs credits (0.1 by default) and one daily assistance",
    "Costs credits (as in the app: a written exam 2 by default, +1 per 4 exercises beyond 8",
    "Costs credits (2 by default) and one daily generation",
    "up to 8 exercises; +1 per 4 more",
  ]) {
    assert.ok(HARD_CODED_COST.some((re) => re.test(old)), old);
  }
});

test("les descriptions décrivent l'outil, sans ordre au modèle", async () => {
  for (const t of await texts()) {
    for (const s of [t.description, ...t.fields]) assert.doesNotMatch(s, ORDERS_TO_MODEL, `${t.name} : « ${s.slice(0, 140)} »`);
  }
  assert.match("ask the user in the conversation and call again ONLY after they explicitly approved", ORDERS_TO_MODEL);
});

test("outils payants : le devis et le jeton sont décrits comme le comportement de l'outil", async () => {
  const { TOOLS } = await import("../lib/mcp/registry");
  const paid = TOOLS.filter((t) => t.kind === "generate" || t.spends).map((t) => t.name).sort();
  assert.deepEqual(paid, ["check_answer", "generate_drill", "generate_mock_exam", "prepare_course"]);
  for (const t of TOOLS.filter((x) => paid.includes(x.name))) {
    assert.match(t.description, /The first call spends nothing: it returns the exact cost and a confirmation_token\./, t.name);
    assert.match(t.description, /plus that confirmation_token runs the tool/, t.name);
    assert.match(t.description, /get_account_status/, t.name);
  }
  for (const t of TOOLS.filter((x) => !paid.includes(x.name))) {
    assert.match(t.description, /\bfree\b|Free\b/, `${t.name} : gratuit, dit dans la description`);
  }
});

test("la consigne de demander l'accord reste dans les instructions du serveur", async () => {
  const { SERVER_INSTRUCTIONS } = await import("../lib/mcp/server");
  assert.match(SERVER_INSTRUCTIONS, /wait for their explicit yes/);
  assert.match(SERVER_INSTRUCTIONS, /Never confirm on their behalf/);
  assert.match(SERVER_INSTRUCTIONS, /format_required/);
  assert.match(SERVER_INSTRUCTIONS, /get_job_status at most every 30-60 seconds/);
});
