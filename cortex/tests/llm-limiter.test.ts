import assert from "node:assert/strict";
import { test } from "node:test";
import { Semaphore } from "../lib/llm/limiter";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("Semaphore : jamais plus de `max` tâches simultanées", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const job = () =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    });
  await Promise.all(Array.from({ length: 8 }, job));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("Semaphore : une tâche qui throw libère son slot", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error("boom"); }));
  const out = await sem.run(async () => "après");
  assert.equal(out, "après");
  assert.equal(sem.active, 0);
  assert.equal(sem.pending, 0);
});

test("Semaphore : FIFO — les tâches passent dans l'ordre d'arrivée", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3, 4].map((i) => sem.run(async () => { order.push(i); await tick(); }))
  );
  assert.deepEqual(order, [1, 2, 3, 4]);
});
