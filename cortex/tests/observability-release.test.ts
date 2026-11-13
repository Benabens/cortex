/**
 * SENTRY, SUITE (13/11) — les erreurs réelles des utilisateurs, serveur ET
 * navigateur. Toujours rien sans SENTRY_DSN ; avec, chaque événement porte le
 * commit déployé (release) et l'environnement (production / preview), et le
 * navigateur passe par le tunnel de l'app (CSP connect-src 'self' intacte).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "CORTEX_PREVIEW"];
afterEach(async () => {
  for (const k of KEYS) delete env[k];
  const { resetErrorTrackingForTests } = await import("../lib/observability");
  resetErrorTrackingForTests();
});
const DSN = "https://cle@o0.ingest.sentry.io/1";
const SHA = "87b646924b23386a100ebc1005a8d81b29115315";

async function serverOptions(): Promise<Record<string, unknown>> {
  const { initErrorTracking } = await import("../lib/observability");
  let options: Record<string, unknown> = {};
  await initErrorTracking({ load: async () => ({ init: (o: Record<string, unknown>) => { options = o; } }) });
  return options;
}

test("serveur : release = commit déployé par Railway, environnement production", async () => {
  Object.assign(env, { SENTRY_DSN: DSN, RAILWAY_GIT_COMMIT_SHA: SHA, RAILWAY_ENVIRONMENT_NAME: "production" });
  const o = await serverOptions();
  assert.equal(o.release, SHA);
  assert.equal(o.environment, "production");
});

test("serveur : une preview de PR est étiquetée preview, même avec SENTRY_ENVIRONMENT=production copié de la prod", async () => {
  Object.assign(env, { SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "production", RAILWAY_ENVIRONMENT_NAME: "cortex-pr-66" });
  assert.equal((await serverOptions()).environment, "preview");
});

test("navigateur : sans SENTRY_DSN, aucune configuration n'est transmise et le SDK n'est jamais chargé", async () => {
  const { clientErrorTrackingConfig } = await import("../lib/observability");
  const { startClientErrorTracking } = await import("../lib/observability-browser");
  assert.equal(clientErrorTrackingConfig({}), null);
  let loaded = false;
  assert.equal(await startClientErrorTracking(null, async () => { loaded = true; return { init: () => {} }; }), "disabled");
  assert.equal(loaded, false);
});

test("navigateur : avec SENTRY_DSN, passe par le tunnel, sans données perso, sans miettes ni sessions", async () => {
  const { clientErrorTrackingConfig } = await import("../lib/observability");
  const { startClientErrorTracking } = await import("../lib/observability-browser");
  const config = clientErrorTrackingConfig({ SENTRY_DSN: DSN, RAILWAY_GIT_COMMIT_SHA: SHA, RAILWAY_ENVIRONMENT_NAME: "production" });
  assert.deepEqual(config, { dsn: DSN, environment: "production", release: SHA, tunnel: "/api/monitoring" });
  let o: Record<string, unknown> = {};
  assert.equal(await startClientErrorTracking(config, async () => ({ init: (opts: Record<string, unknown>) => { o = opts; } })), "enabled");
  assert.equal(o.sendDefaultPii, false);
  assert.equal(o.tracesSampleRate, 0);
  assert.equal(o.tunnel, "/api/monitoring");
  assert.equal(o.release, SHA);
  const kept = (o.integrations as (d: Array<{ name: string }>) => Array<{ name: string }>)(
    ["Breadcrumbs", "BrowserSession", "GlobalHandlers", "LinkedErrors"].map((name) => ({ name })),
  ).map((i) => i.name);
  assert.deepEqual(kept, ["GlobalHandlers", "LinkedErrors"], "ni clics/console (texte d'énoncés), ni suivi de session");
  const scrubbed = (o.beforeSend as (e: unknown) => Record<string, unknown>)({
    user: { email: "etudiant@epfl.ch" }, request: { url: "https://app.cortexexam.com/cours/x?course=cs-202", headers: { Referer: "r" } },
  });
  assert.equal(scrubbed.user, undefined);
  assert.deepEqual(scrubbed.request, { url: "https://app.cortexexam.com/cours/x" });
});

test("navigateur : la configuration vient de /api/monitoring ; 204, réponse invalide ou réseau coupé = suivi éteint", async () => {
  const { loadClientErrorTrackingConfig } = await import("../lib/observability-browser");
  const config = { dsn: DSN, environment: "production", release: SHA, tunnel: "/api/monitoring" };
  const urls: string[] = [];
  const answer = (r: () => Response) => (async (url: string) => { urls.push(String(url)); return r(); }) as unknown as typeof fetch;
  assert.deepEqual(await loadClientErrorTrackingConfig(answer(() => Response.json(config))), config);
  assert.deepEqual(urls, ["/api/monitoring"]);
  assert.equal(await loadClientErrorTrackingConfig(answer(() => new Response(null, { status: 204 }))), null);
  assert.equal(await loadClientErrorTrackingConfig(answer(() => Response.json({ dsn: 42 }))), null);
  assert.equal(await loadClientErrorTrackingConfig(answer(() => Response.json({ ...config, tunnel: "https://o0.ingest.sentry.io" }))), null, "jamais un envoi direct hors de l'origine");
  assert.equal(await loadClientErrorTrackingConfig((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), null);
});

test("erreur non gérée d'une route (onRequestError) : remontée avec la route, sans la requête ; rien sans SENTRY_DSN", async () => {
  const { initErrorTracking, captureRequestError } = await import("../lib/observability");
  const context = { routerKind: "App Router", routePath: "/api/drill", routeType: "route" } as const;
  captureRequestError(new Error("hors suivi"), context); // aucun SDK chargé : ne doit rien faire ni lever
  env.SENTRY_DSN = DSN;
  const sent: Array<{ e: unknown; hint: Record<string, unknown> }> = [];
  await initErrorTracking({ load: async () => ({ init: () => {}, captureException: (e: unknown, hint?: Record<string, unknown>) => { sent.push({ e, hint: hint ?? {} }); } }) });
  captureRequestError(new Error("boum"), context);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].hint, { tags: { kind: "request", route: "/api/drill", routeType: "route" } });
});
