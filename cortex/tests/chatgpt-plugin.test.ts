import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MCP_SERVER_VERSION } from "../lib/mcp/identity";

/**
 * PAQUET CHATGPT (docs/annuaires/chatgpt-plugin + scripts/build-chatgpt-plugin.sh) :
 * manifestes conformes au formulaire, aucun coût chiffré, et une archive
 * reproductible qui contient exactement plugin.json, mcp.json et le logo.
 */

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "annuaires", "chatgpt-plugin");
const SCRIPT = path.join(ROOT, "scripts", "build-chatgpt-plugin.sh");
const plugin = JSON.parse(fs.readFileSync(path.join(SRC, "plugin.json"), "utf8"));
const ui = plugin.extensions["com.openai"].interface;
const hasZip = spawnSync("zip", ["-v"]).status === 0;

function strings(v: unknown, at = "plugin", out: [string, string][] = []): [string, string][] {
  if (typeof v === "string") out.push([at, v]);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, `${at}.${k}`, out);
  return out;
}

const build = (out: string, env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, out], { encoding: "utf8", env: { ...process.env, ...env } });

test("plugin.json : nom affiché, éditeur, version et limites du formulaire", () => {
  assert.equal(ui.displayName, "Cortex Exam");
  assert.ok(ui.displayName.length <= 30 && ui.shortDescription.length <= 30);
  assert.equal(ui.developerName, "Benjamin Abensur EI (Benabens)");
  assert.equal(plugin.author.name, ui.developerName);
  assert.equal(plugin.version, MCP_SERVER_VERSION);
  assert.equal(ui.logo, "./assets/logo.png");
  for (const p of ui.defaultPrompt) assert.ok(p.length <= 128, p);
});

test("plugin.json : aucun TODO, vidéo de démo renseignée", () => {
  const todos = strings(plugin).filter(([, s]) => /\bTODO\b/.test(s)).map(([at]) => at);
  assert.deepEqual(todos, []);
});

test("plugin.json : aucun coût chiffré (le coût exact vient du premier appel)", () => {
  for (const [at, s] of strings(plugin)) {
    assert.doesNotMatch(s, /\d+(?:[.,]\d+)?\s*credits?\b|\bby default\b/i, at);
  }
  const drill = plugin.extensions["com.openai"].review.test_cases.positive.find(
    (c: { tools_triggered: string }) => c.tools_triggered.includes("generate_drill"),
  );
  assert.match(drill.expected_behavior, /the exact cost quoted by the first call/);
});

test("archive : plugin.json, mcp.json et le logo à la racine, identique d'une construction à l'autre", { skip: !hasZip && "zip absent" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plugin-"));
  try {
    const a = build(path.join(dir, "a.zip"));
    assert.equal(a.status, 0, a.stderr);
    const b = build(path.join(dir, "b.zip"));
    assert.equal(b.status, 0, b.stderr);
    const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    assert.equal(sha(path.join(dir, "a.zip")), sha(path.join(dir, "b.zip")));
    const names = execFileSync("unzip", ["-Z1", path.join(dir, "a.zip")], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(names, ["plugin.json", "mcp.json", "assets/logo.png"]);
    const logo = execFileSync("unzip", ["-p", path.join(dir, "a.zip"), "assets/logo.png"]);
    assert.ok(logo.equals(fs.readFileSync(path.join(ROOT, "public", "mcp-icon-512.png"))));
    assert.doesNotMatch(a.stderr, /encore un TODO/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("archive refusée : TODO hors de la vidéo, nom affiché trop long, version différente", { skip: !hasZip && "zip absent" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plugin-"));
  try {
    const variant = (name: string, edit: (p: typeof plugin) => void) => {
      const src = path.join(dir, name);
      fs.mkdirSync(src);
      const p = structuredClone(plugin);
      edit(p);
      fs.writeFileSync(path.join(src, "plugin.json"), JSON.stringify(p));
      fs.copyFileSync(path.join(SRC, "mcp.json"), path.join(src, "mcp.json"));
      return build(path.join(dir, `${name}.zip`), { CHATGPT_PLUGIN_SRC: src });
    };
    const todo = variant("todo", (p) => { p.extensions["com.openai"].interface.developerName = "TODO: publisher legal name"; });
    assert.notEqual(todo.status, 0);
    assert.match(todo.stderr, /TODO à remplir : .*developerName/);
    const long = variant("long", (p) => { p.extensions["com.openai"].interface.displayName = "Cortex Exam Preparation Assistant"; });
    assert.notEqual(long.status, 0);
    assert.match(long.stderr, /displayName/);
    const version = variant("version", (p) => { p.version = "0.0.1"; });
    assert.notEqual(version.status, 0);
    assert.match(version.stderr, /MCP_SERVER_VERSION/);
    assert.ok(!fs.existsSync(path.join(dir, "todo.zip")), "rien n'est écrit quand c'est refusé");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
