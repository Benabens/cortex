/**
 * TUNNEL SENTRY — le navigateur envoie ses erreurs à /api/monitoring (même
 * origine) plutôt qu'à sentry.io : la CSP garde connect-src 'self', donc une
 * XSS ne peut toujours rien exfiltrer. Le tunnel ne relaie QU'AU projet du
 * SENTRY_DSN configuré, jamais à un projet choisi par l'expéditeur.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const env = process.env as Record<string, string | undefined>;
const realFetch = globalThis.fetch;
afterEach(() => { delete env.SENTRY_DSN; globalThis.fetch = realFetch; });

const DSN = "https://cle@o0.ingest.sentry.io/1";
const envelope = (dsn: string) => `${JSON.stringify({ event_id: "a".repeat(32), dsn })}\n{"type":"event"}\n{"message":"boum"}\n`;
const post = (body: string) => new Request("https://app.cortexexam.com/api/monitoring", {
  method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body,
});

function spyFetch(): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("sans SENTRY_DSN : le tunnel n'existe pas", async () => {
  const calls = spyFetch();
  const { POST } = await import("../app/api/monitoring/route");
  assert.equal((await POST(post(envelope(DSN)))).status, 404);
  assert.equal(calls.length, 0);
});

test("enveloppe du projet configuré : relayée telle quelle à l'ingestion Sentry de ce projet", async () => {
  env.SENTRY_DSN = DSN;
  const calls = spyFetch();
  const { POST } = await import("../app/api/monitoring/route");
  const body = envelope(DSN);
  assert.equal((await POST(post(body))).status, 200);
  assert.deepEqual(calls, [{ url: "https://o0.ingest.sentry.io/api/1/envelope/", body }]);
});

test("enveloppe destinée à un autre projet, illisible ou trop lourde : refusée, rien n'est relayé", async () => {
  env.SENTRY_DSN = DSN;
  const calls = spyFetch();
  const { POST } = await import("../app/api/monitoring/route");
  assert.equal((await POST(post(envelope("https://cle@o666.ingest.sentry.io/999")))).status, 400);
  assert.equal((await POST(post("pas du json\n{}"))).status, 400);
  assert.equal((await POST(post(envelope(DSN) + "x".repeat(300_000)))).status, 413);
  assert.equal(calls.length, 0);
});

test("configuration du navigateur lue au runtime (pages statiques comprises) : 204 sans SENTRY_DSN, sinon DSN + release + tunnel", async () => {
  const { GET } = await import("../app/api/monitoring/route");
  const off = await GET();
  assert.equal(off.status, 204);
  Object.assign(env, { SENTRY_DSN: DSN, RAILWAY_GIT_COMMIT_SHA: "87b646924b23386a100ebc1005a8d81b29115315", RAILWAY_ENVIRONMENT_NAME: "production" });
  const on = await GET();
  assert.equal(on.status, 200);
  assert.equal(on.headers.get("cache-control"), "no-store");
  assert.deepEqual(await on.json(), { dsn: DSN, environment: "production", release: "87b646924b23386a100ebc1005a8d81b29115315", tunnel: "/api/monitoring" });
  delete env.RAILWAY_GIT_COMMIT_SHA;
  delete env.RAILWAY_ENVIRONMENT_NAME;
});
