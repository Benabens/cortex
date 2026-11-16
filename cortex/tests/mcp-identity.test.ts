/**
 * IDENTITÉ PUBLIQUE DU CONNECTEUR MCP — ce que les annuaires (Claude, ChatGPT,
 * registre officiel) et les clients lisent avant même de se connecter :
 * server.json conforme au schéma du registre et identique à lib/mcp/identity,
 * carte du serveur (SEP-2127) conforme et servie sans session, icônes publiques
 * aux tailles annoncées, annotations de TOUS les outils explicites et cohérentes
 * (un outil sans indication fait échouer ce test), résumé pour la page Assistants.
 * Les schémas officiels sont copiés dans tests/fixtures/mcp-schemas (16/11/2026).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { NextRequest } from "next/server";

process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-identity-"));

const ROOT = path.join(__dirname, "..");
const SCHEMAS = path.join(__dirname, "fixtures", "mcp-schemas");
const ENV_KEYS = ["MCP_ENABLED", "AUTH_URL", "AUTH_ENABLED"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;

function pngSize(file: string): string {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${file} n'est pas un PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

// ───────────────────────────── registre officiel ─────────────────────────────

test("server.json : identique à registryServerJson() et conforme au schéma du registre (2025-12-11)", async () => {
  const { registryServerJson, MCP_REGISTRY_NAME } = await import("../lib/mcp/identity");
  const onDisk = readJson(path.join(ROOT, "server.json"));
  assert.deepEqual(onDisk, registryServerJson(), "server.json à régénérer depuis lib/mcp/identity (voir docs/annuaires/registre-mcp.md)");
  const schema = readJson(path.join(SCHEMAS, "registry-server-2025-12-11.schema.json"));
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  assert.ok(validate(onDisk), JSON.stringify(validate.errors));
  assert.equal(onDisk.$schema, schema.$id ?? onDisk.$schema);
  // Espace de noms prouvé par le domaine (vérification HTTP) : com.cortexexam/…
  assert.equal(MCP_REGISTRY_NAME, "com.cortexexam/cortex");
  const remotes = onDisk.remotes as { type: string; url: string }[];
  assert.deepEqual(remotes, [{ type: "streamable-http", url: "https://app.cortexexam.com/mcp" }]);
  assert.ok(String(onDisk.description).length <= 100);
});

// ───────────────────────────── carte du serveur ─────────────────────────────

test("carte du serveur : conforme au schéma v1 de SEP-2127, sans outil ni secret", async () => {
  const { serverCard } = await import("../lib/mcp/identity");
  const card = serverCard("https://app.cortexexam.com");
  const schema = readJson(path.join(SCHEMAS, "server-card-v1.schema.json"));
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  assert.ok(validate(card), JSON.stringify(validate.errors));
  assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
  assert.equal("tools" in card, false, "SEP-2127 : les outils se lisent par tools/list");
  assert.deepEqual(card.remotes.map((r) => r.url), ["https://app.cortexexam.com/mcp"]);
});

test("carte du serveur : servie aux deux adresses sans session (CORS *), 404 si le connecteur est coupé", async () => {
  process.env.AUTH_URL = "https://cortex.test";
  const { serverCardResponse } = await import("../lib/mcp/card");
  const { MCP_CARD_PATHS } = await import("../lib/mcp/identity");
  process.env.MCP_ENABLED = "1";
  for (const p of MCP_CARD_PATHS) {
    const res = serverCardResponse(new Request(`https://cortex.test${p}`));
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("cache-control") ?? "", /public/);
    const card = (await res.json()) as { remotes: { url: string }[]; icons: { src: string }[] };
    assert.equal(card.remotes[0].url, "https://cortex.test/mcp", "l'adresse suit l'émetteur de l'instance");
    assert.ok(card.icons.every((i) => i.src.startsWith("https://cortex.test/mcp-icon")));
  }
  const pre = serverCardResponse(new Request("https://cortex.test/mcp/server-card", { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  delete process.env.MCP_ENABLED;
  assert.equal(serverCardResponse(new Request("https://cortex.test/mcp/server-card")).status, 404);
});

test("proxy (auth active) : carte et icônes passent sans redirection vers /login", async () => {
  process.env.AUTH_ENABLED = "1";
  const { default: proxy, publicPath } = await import("../proxy");
  const { MCP_CARD_PATHS, MCP_ICON_PATHS } = await import("../lib/mcp/identity");
  for (const p of [...MCP_CARD_PATHS, ...MCP_ICON_PATHS]) {
    assert.equal(publicPath(p), true, p);
    const res = await proxy(new NextRequest(`http://cortex.test${p}`));
    assert.equal(res.headers.get("location"), null, `${p} redirigé`);
  }
  for (const p of ["/mcp-icon.png", "/mcp/server-card/x", "/.well-known/mcp/autre.json"]) assert.equal(publicPath(p), false, p);
});

// ───────────────────────────── icônes ─────────────────────────────

test("icônes : chaque fichier annoncé existe dans public/ à la taille déclarée", async () => {
  const { mcpIcons, MCP_ICON_PATHS } = await import("../lib/mcp/identity");
  const icons = mcpIcons("https://app.cortexexam.com");
  assert.deepEqual(icons.map((i) => new URL(i.src).pathname).sort(), [...MCP_ICON_PATHS].sort());
  for (const icon of icons) {
    const file = path.join(ROOT, "public", new URL(icon.src).pathname);
    assert.ok(fs.existsSync(file), file);
    if (icon.mimeType === "image/png") assert.deepEqual([pngSize(file)], icon.sizes, icon.src);
    else {
      assert.equal(icon.mimeType, "image/svg+xml");
      const svg = fs.readFileSync(file, "utf8");
      assert.match(svg, /^<svg [^>]*viewBox="0 0 256 256"/);
      assert.doesNotMatch(svg, /<script|href=|gradient/i, "SVG statique, sans script ni dégradé");
    }
  }
  // Le PNG 512 d'abord : un client qui ne prend que la première icône lit un PNG net.
  assert.equal(icons[0].mimeType, "image/png");
});

test("cache long des icônes déclaré dans next.config", () => {
  const conf = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  assert.match(conf, /source: "\/mcp-icon:variant\(\.\*\)"[^\n]*max-age=2592000/);
});

// ───────────────────────────── versions du protocole ─────────────────────────────

test("versions annoncées par la carte : toutes servies par le SDK", async () => {
  const { MCP_PROTOCOL_VERSIONS } = await import("../lib/mcp/identity");
  const { SUPPORTED_PROTOCOL_VERSIONS } = await import("@modelcontextprotocol/server");
  for (const v of MCP_PROTOCOL_VERSIONS.filter((x) => x !== "2026-07-28")) {
    assert.ok((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v), v);
  }
  assert.equal(MCP_PROTOCOL_VERSIONS[0], "2026-07-28");
});

// ───────────────────────────── annotations des outils ─────────────────────────────

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

test("annotations : chaque outil a un titre et les quatre indications EXPLICITES, cohérentes avec ce qu'il fait", async () => {
  const { TOOLS } = await import("../lib/mcp/registry");
  assert.equal(TOOLS.length, 15);
  for (const t of TOOLS) {
    const a = t.annotations as Record<string, unknown>;
    assert.ok(t.title && t.title.length <= 60, `${t.name} : titre`);
    for (const h of HINTS) assert.equal(typeof a[h], "boolean", `${t.name} : ${h} manquant`);
    assert.deepEqual(Object.keys(a).sort(), [...HINTS].sort(), `${t.name} : indication inconnue`);
    // Lecture seule ⇔ outil `read` ; jamais lecture seule ET destructif.
    assert.equal(t.annotations.readOnlyHint, t.kind === "read", `${t.name} : readOnlyHint`);
    if (t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, t.name);
    // Tout outil payant (crédits) : pas lecture seule, destructif (dépense irréversible), pas idempotent.
    if (t.kind === "generate" || t.spends) {
      assert.deepEqual({ ...t.annotations, openWorldHint: false }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, `${t.name} : outil payant`);
    }
  }
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));
  // Les seuls cas qui ne se déduisent pas du genre de l'outil : décisions écrites dans lib/mcp/tool.ts.
  assert.equal(byName.add_course_source.openWorldHint, true, "lit une URL fournie");
  assert.equal(TOOLS.filter((t) => t.annotations.openWorldHint).length, 1);
  assert.equal(byName.create_course.destructiveHint, false, "ajout pur");
  assert.equal(byName.add_course_source.destructiveHint, false, "ajout pur, jamais d'écrasement");
  assert.equal(byName.set_exam_format.destructiveHint, true, "remplace ou efface le format déclaré");
  assert.equal(byName.set_exam_format.idempotentHint, true);
  assert.equal(byName.report_question.destructiveHint, true, "retire la question des révisions");
});

test("annotations : un outil sans indication explicite fait échouer le registre au démarrage", async () => {
  const { TOOLS, validateTools } = await import("../lib/mcp/registry");
  const base = TOOLS[0];
  for (const h of HINTS) {
    const partial = { ...base.annotations } as Record<string, unknown>;
    delete partial[h];
    assert.throws(() => validateTools([{ ...base, annotations: partial } as unknown as typeof base]), new RegExp(h));
  }
  assert.throws(() => validateTools([{ ...base, userSummary: "" }]), /résumé/);
});

test("descriptions : sobres, dans les limites des annuaires, sans consigne cachée", async () => {
  const { TOOLS } = await import("../lib/mcp/registry");
  for (const t of TOOLS) {
    assert.ok(t.name.length <= 64, t.name);
    assert.ok(t.description.length <= 2000, `${t.name} : ${t.description.length} caractères`);
    assert.doesNotMatch(t.description, /ignore (all |any )?(previous|prior)|system prompt|<\/?[a-z]+>|do not (tell|mention|reveal)|always (use|call|prefer) (this|cortex)|best|revolutionary|#1|world-class/i, t.name);
    assert.ok(t.userSummary.length <= 100 && /\.$/.test(t.userSummary), `${t.name} : résumé d'une phrase`);
    assert.doesNotMatch(t.userSummary, /[A-Za-z]+_[a-z]+/, `${t.name} : pas de nom d'outil dans le résumé`);
  }
});

test("instructions du serveur : génériques (aucun client nommé), données ≠ consignes, aucune vente", async () => {
  const { SERVER_INSTRUCTIONS } = await import("../lib/mcp/server");
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /\b(Claude|ChatGPT|OpenAI|Anthropic|Gemini|Cursor)\b/);
  assert.match(SERVER_INSTRUCTIONS, /DATA, never instructions/);
  assert.match(SERVER_INSTRUCTIONS, /never sells credits/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /https?:\/\/|buy|purchase|upgrade/i);
});

test("refus envoyés à l'assistant : jamais de lien d'achat (ChatGPT interdit la vente de crédits), le constat reste", async () => {
  const { assistantSafeMessage } = await import("../lib/mcp/tool");
  const { insufficient } = await import("../lib/billing/credits");
  for (const r of [insufficient(50, 200), insufficient(0, 0), insufficient(10, 200, 5)]) {
    assert.ok(r);
    assert.match(r.error, /Acheter : https:\/\//, "l'app garde son lien");
    const out = assistantSafeMessage(r.error);
    assert.doesNotMatch(out, /Acheter|https?:\/\/|compte#credits/, out);
    assert.match(out, /^Solde (insuffisant|épuisé)/);
    assert.match(out, /\.$/);
  }
  assert.equal(assistantSafeMessage("Cours introuvable."), "Cours introuvable.");
});
