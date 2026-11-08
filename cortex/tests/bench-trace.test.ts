/**
 * Trace du banc (CORTEX_BENCH_TRACE) : chaque QCM rejeté à la vérification y est noté avec sa
 * raison, pour que le banc juge les faux rejets « hors cours ». Hors banc : rien n'est écrit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bench-trace-"));
process.env.CORTEX_DATA_DIR = tmp;

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.CORTEX_BENCH_TRACE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const positional = () => ({
  type: "scq" as const, topic: "t", stem: "Quel protocole garantit l'ordre ?", options: ["TCP", "UDP", "IP", "ICMP"], correct: [0],
  misconceptions: ["", "", "", ""], explanation: "La première option est la bonne : elle numérote les segments.", verified: 0 as const,
});

test("QCM rejeté à la vérification : noté dans la trace du banc avec sa raison", async () => {
  const file = path.join(tmp, "trace.jsonl");
  process.env.CORTEX_BENCH_TRACE = file;
  const { verifyQcmBatch } = await import("../lib/qcm");
  await verifyQcmBatch([positional()], () => {});
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; stem: string; options: string[]; correct: number[]; reason: string });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "qcm.rejected");
  assert.equal(lines[0].stem, "Quel protocole garantit l'ordre ?");
  assert.deepEqual(lines[0].correct, [0]);
  assert.match(lines[0].reason, /position ou sa lettre/);
});

test("hors banc : aucune trace écrite", async () => {
  delete process.env.CORTEX_BENCH_TRACE;
  const { verifyQcmBatch } = await import("../lib/qcm");
  await verifyQcmBatch([positional()], () => {});
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.endsWith(".jsonl")), ["trace.jsonl"]);
});
