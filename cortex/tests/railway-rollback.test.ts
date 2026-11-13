/**
 * ROLLBACK APRÈS UN SMOKE RATÉ (.github/workflows/post-deploy.yml) — on remet
 * en ligne le dernier déploiement sain AVANT le commit fautif, et on refuse
 * tout ce qui ressemble à une cascade : rollback d'un rollback, commit déjà
 * remplacé par un déploiement plus récent, rien de réutilisable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const BAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GOOD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLDER = "cccccccccccccccccccccccccccccccccccccccc";
const d = (id: string, status: string, createdAt: string, commitHash: string, extra: Record<string, unknown> = {}) =>
  ({ id, status, createdAt, canRollback: true, meta: { commitHash, reason: "deploy" }, ...extra });

const history = [
  d("dep-bad", "SUCCESS", "2026-11-13T15:15:00Z", BAD),
  d("dep-skipped", "SKIPPED", "2026-11-13T14:50:00Z", OLDER, { canRollback: false }),
  d("dep-crashed", "CRASHED", "2026-11-13T14:40:00Z", OLDER),
  d("dep-good", "REMOVED", "2026-11-13T14:15:00Z", GOOD),
  d("dep-older", "REMOVED", "2026-11-08T21:23:00Z", OLDER),
];

test("cible = dernier déploiement sain antérieur au commit fautif", async () => {
  const { pickRollbackTarget } = await import("../scripts/railway-rollback");
  const plan = pickRollbackTarget([...history].reverse(), BAD);
  assert.equal(plan.refusal, undefined);
  assert.equal(plan.target?.id, "dep-good");
});

test("refus : commit inconnu, rollback d'un rollback, déploiement plus récent en ligne, rien de réutilisable", async () => {
  const { pickRollbackTarget } = await import("../scripts/railway-rollback");
  assert.match(pickRollbackTarget(history, "dddddddddddddddddddddddddddddddddddddddd").refusal ?? "", /aucun déploiement/);
  const rolledBack = [d("dep-bad", "SUCCESS", "2026-11-13T15:15:00Z", BAD, { meta: { commitHash: BAD, reason: "rollback" } }), ...history.slice(1)];
  assert.match(pickRollbackTarget(rolledBack, BAD).refusal ?? "", /rollback/);
  const superseded = [d("dep-next", "SUCCESS", "2026-11-13T16:00:00Z", OLDER), { ...history[0], status: "REMOVED" }, ...history.slice(1)];
  assert.match(pickRollbackTarget(superseded, BAD).refusal ?? "", /plus récent/);
  assert.match(pickRollbackTarget([history[0], { ...history[3], canRollback: false }], BAD).refusal ?? "", /réutilisable/);
});

test("rollback via l'API Railway avec le jeton de projet ; --dry-run ne modifie rien", async () => {
  const { rollback } = await import("../scripts/railway-rollback");
  const calls: Array<{ query: string; variables: Record<string, unknown>; token: string | null }> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    calls.push({ query, variables, token: new Headers(init.headers).get("project-access-token") });
    const data = query.includes("projectToken") ? { projectToken: { projectId: "p1", environmentId: "e1" } }
      : query.includes("services") ? { project: { services: { edges: [{ node: { id: "s-pg", name: "Postgres" } }, { node: { id: "s1", name: "cortex-app" } }] } } }
      : query.includes("deployments") ? { deployments: { edges: history.map((node) => ({ node })) } }
      : { deploymentRollback: true };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;

  const dry = await rollback({ token: "tok", sha: BAD, dryRun: true, fetch: fakeFetch });
  assert.equal(dry.target?.id, "dep-good");
  assert.ok(!calls.some((c) => c.query.includes("deploymentRollback")), "dry-run : aucune mutation");
  assert.ok(calls.every((c) => c.token === "tok"));
  assert.deepEqual(calls.find((c) => c.query.includes("deployments"))?.variables, { p: "p1", e: "e1", s: "s1" });

  calls.length = 0;
  const done = await rollback({ token: "tok", sha: BAD, dryRun: false, fetch: fakeFetch });
  assert.equal(done.rolledBack, true);
  assert.deepEqual(calls.find((c) => c.query.includes("deploymentRollback"))?.variables, { id: "dep-good" });
});
