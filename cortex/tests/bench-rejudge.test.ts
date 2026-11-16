import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareRejudgeOutput } from "../lib/bench/rejudge";

test("rejuge : copie seulement le run exporté dans un dossier de jugement distinct", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rejuge-"));
  try {
    const source = path.join(tmp, "run-source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "run.json"), JSON.stringify({ caseId: "rs-mixte", commit: "abc1234", db: "ancienne" }));
    fs.writeFileSync(path.join(source, "run.tape.jsonl"), "generation privee");

    const output = prepareRejudgeOutput(source, path.join(tmp, "jugement-1"), "nouvelle");

    assert.equal(output, path.join(tmp, "jugement-1"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "run.json"), "utf8")), {
      caseId: "rs-mixte", commit: "abc1234", db: "nouvelle",
    });
    assert.deepEqual(fs.readdirSync(output), ["run.json"], "la bande de génération n'est ni copiée ni rejouée");
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, "run.json"), "utf8")).db, "ancienne", "le run archivé reste intact");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rejuge : refuse d'écraser un jugement existant", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rejuge-"));
  try {
    fs.writeFileSync(path.join(tmp, "run.json"), JSON.stringify({ caseId: "x", db: "ancienne" }));
    const output = path.join(tmp, "sortie");
    fs.mkdirSync(output);
    assert.throws(() => prepareRejudgeOutput(tmp, output, "nouvelle"), /existe déjà/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
