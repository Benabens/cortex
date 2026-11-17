/**
 * Garde-fou : plus aucune route ne fabrique une erreur à la main (phrase sans code, dans
 * une seule langue) ; toutes passent par apiError (lib/i18n/api-error).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(__dirname, "..");
function routeFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(rel) : rel.endsWith(".ts") ? [rel] : [];
  });
}

test("garde-fou : aucune route ne renvoie une erreur sans code (toutes passent par apiError)", () => {
  const files = [...routeFiles("app/api"), "proxy.ts", "lib/req.ts", "lib/upload-limit.ts"];
  const offenders: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/\b(NextResponse|Response)\.json\(\s*\{\s*(\.\.\.[\w.]+,\s*)?error\s*:/.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, []);
});
