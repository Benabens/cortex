/**
 * CORRECTIFS PROD — la sonde de sandbox (`unshare -rn true`) échoue chez
 * l'hébergeur : comportement attendu, mais son stderr remontait tel quel en
 * niveau error à chaque démarrage. La sonde capture désormais sa sortie et ne
 * journalise qu'une ligne info.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("sonde en échec : rien sur stderr, une seule ligne info « sandbox indisponible »", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-probe-"));
  // Faux `unshare` ET faux `sandbox-exec` (macOS) qui échouent bruyamment sur stderr, comme chez l'hébergeur.
  for (const name of ["unshare", "sandbox-exec"]) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${name}: ${name} failed: Permission denied" >&2\nexit 1\n`);
    fs.chmodSync(p, 0o755);
  }
  const origPath = process.env.PATH;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const errors: string[] = [];
  const infos: string[] = [];
  const origError = console.error; const origLog = console.log; const origWarn = console.warn;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { infos.push(a.map(String).join(" ")); };
  process.env.PATH = `${bin}:${origPath}`;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    delete require.cache[require.resolve("../lib/sandbox-exec")];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require("../lib/sandbox-exec") as typeof import("../lib/sandbox-exec");
    assert.equal(fresh.sandboxAvailable(), false);
    assert.equal(fresh.sandboxAvailable(), false, "seconde interrogation : rien de plus");
    assert.deepEqual(errors, [], "aucune ligne error/warn");
    const lines = infos.filter((l) => /sandbox indisponible/.test(l));
    assert.equal(lines.length, 1, infos.join("\n"));
    assert.match(lines[0], /exécution de code désactivée/);
    assert.match(lines[0], /Permission denied/, "la cause est gardée dans la ligne info");
  } finally {
    console.error = origError; console.log = origLog; console.warn = origWarn;
    process.env.PATH = origPath;
    Object.defineProperty(process, "platform", origPlatform);
    delete require.cache[require.resolve("../lib/sandbox-exec")];
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
