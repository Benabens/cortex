/**
 * LOT 2b-10 — annuler un job doit tuer TOUT son arbre de processus (tsx re-spawne
 * le script). Le groupe était trouvé via `ps` ; sans `ps` (image minimale), on ne
 * tuait que le PID enregistré et les enfants survivaient. Le worker étant lancé
 * détaché (leader de son groupe), kill(-pid) suffit sans `ps`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { killProcessGroup } from "../lib/process-group";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childrenOfGroup = (pgid: number) => {
  try { return execFileSync("ps", ["-o", "pid=", "-g", String(pgid)]).toString().trim().split("\n").filter(Boolean).length; }
  catch { return 0; } // ps sort en erreur quand le groupe est vide
};

test("sans `ps` : le groupe entier (parent détaché + enfant) est tué", async () => {
  const child = spawn(process.execPath, ["-e", "require('child_process').spawn('sleep',['60'],{stdio:'ignore'});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  await sleep(400);
  assert.ok(childrenOfGroup(pid) >= 2, "le groupe contient le parent et le sleep");
  const target = killProcessGroup(pid, { pgidLookup: () => null });
  assert.equal(target, -pid, "repli : groupe = pid (spawn détaché)");
  await sleep(400);
  assert.equal(alive(pid), false);
  assert.equal(childrenOfGroup(pid), 0, "l'enfant sleep est mort avec le groupe");
});

test("avec `ps` : le groupe réel est visé", async () => {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  await sleep(200);
  const target = killProcessGroup(pid);
  assert.equal(target, -pid);
  await sleep(300);
  assert.equal(alive(pid), false);
});
