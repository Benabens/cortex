/**
 * PAGE « CONNECTER TON ASSISTANT » — les liens d'installation se décodent en la
 * bonne configuration, les commandes sont celles des documentations, la consigne
 * à coller contient tout ce qu'il faut (adresse, transport, OAuth, premier appel).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const URL_MCP = "https://app.cortexexam.com/mcp";

test("liens d'installation : Cursor (config base64) et VS Code (config JSON) pointent sur l'adresse MCP", async () => {
  const { cursorInstallLink, vscodeInstallLink } = await import("../lib/mcp/install-guide");
  const cursor = new URL(cursorInstallLink(URL_MCP));
  assert.equal(`${cursor.protocol}//${cursor.host}${cursor.pathname}`, "cursor://anysphere.cursor-deeplink/mcp/install");
  assert.equal(cursor.searchParams.get("name"), "cortex");
  assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString("utf8")), { url: URL_MCP });
  const vscode = new URL(vscodeInstallLink(URL_MCP));
  assert.equal(`${vscode.origin}${vscode.pathname}`, "https://insiders.vscode.dev/redirect/mcp/install");
  assert.equal(vscode.searchParams.get("name"), "cortex");
  assert.deepEqual(JSON.parse(vscode.searchParams.get("config")!), { type: "http", url: URL_MCP });
});

test("marche à suivre : un bloc par client, commandes exactes, rien de propre au serveur d'un client", async () => {
  const { clientGuides } = await import("../lib/mcp/install-guide");
  const guides = clientGuides(URL_MCP);
  assert.deepEqual(guides.map((g) => g.id), ["claude", "chatgpt", "claude-code", "cursor", "vscode", "codex", "gemini-cli", "other"]);
  const codes = guides.flatMap((g) => g.steps.map((s) => s.code).filter(Boolean));
  for (const cmd of [
    `claude mcp add --transport http cortex ${URL_MCP}`,
    `codex mcp add cortex --url ${URL_MCP}`,
    "codex mcp login cortex",
    `gemini mcp add --transport http cortex ${URL_MCP}`,
    "/mcp auth cortex",
    `code --add-mcp '{"name":"cortex","type":"http","url":"${URL_MCP}"}'`,
  ]) assert.ok(codes.includes(cmd), cmd);
  for (const g of guides) {
    assert.ok(g.steps.length >= 2, g.id);
    for (const s of g.steps) if (s.link?.href.startsWith("http")) assert.match(s.link.href, /^https:\/\//, g.id);
  }
});

test("consigne pour l'assistant : adresse, transport, OAuth sans clé, premier appel list_courses, accord avant dépense", async () => {
  const { assistantPrompt } = await import("../lib/mcp/install-guide");
  const p = assistantPrompt(URL_MCP);
  assert.ok(p.includes(URL_MCP));
  assert.match(p, /Streamable HTTP/);
  assert.match(p, /OAuth/);
  assert.match(p, /aucune clé/);
  assert.match(p, /list_courses/);
  assert.match(p, /coût en crédits et attends mon accord/);
});
