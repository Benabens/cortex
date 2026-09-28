/**
 * PRÉ-LANCEMENT 10 — aucun suivi d'erreurs : un plantage de nuit passait
 * inaperçu. Sentry devient OPTIONNEL : rien ne change sans SENTRY_DSN, et quand
 * la variable est posée, aucune donnée personnelle ne part — ni e-mail, ni
 * contenu de cours, ni en-têtes de requête.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

after(() => {
  for (const k of ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"]) delete process.env[k];
});

test("sans SENTRY_DSN : désactivé, et le module du SDK n'est même pas chargé", async () => {
  const { initErrorTracking } = await import("../lib/observability");
  delete process.env.SENTRY_DSN;
  let loaded = false;
  const r = await initErrorTracking({ load: async () => { loaded = true; return { init: () => {} }; } });
  assert.equal(r, "disabled");
  assert.equal(loaded, false, "aucun coût quand la variable est absente");
});

test("avec SENTRY_DSN : initialisé sans données personnelles, sur le bon service", async () => {
  const { initErrorTracking } = await import("../lib/observability");
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  process.env.SENTRY_ENVIRONMENT = "production";
  let options: Record<string, unknown> | null = null;
  const r = await initErrorTracking({ load: async () => ({ init: (o: Record<string, unknown>) => { options = o; } }), service: "worker" });
  assert.equal(r, "enabled");
  assert.equal(options!.dsn, "https://exemple@o0.ingest.sentry.io/1");
  assert.equal(options!.environment, "production");
  assert.equal(options!.sendDefaultPii, false, "jamais d'IP ni d'en-têtes par défaut");
  assert.equal(options!.tracesSampleRate, 0, "pas de traces de performance par défaut");
  assert.equal(typeof options!.beforeSend, "function");
  assert.deepEqual(options!.initialScope, { tags: { service: "worker" } });
});

test("SDK absent du projet : l'app démarre quand même (dégradation silencieuse)", async () => {
  const { initErrorTracking } = await import("../lib/observability");
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  const r = await initErrorTracking({ load: async () => { throw new Error("Cannot find module '@sentry/nextjs'"); } });
  assert.equal(r, "unavailable");
});

test("scrubEvent : garde l'erreur, retire e-mail, identité, en-têtes, cookies et contenu de cours", async () => {
  const { scrubEvent } = await import("../lib/observability");
  const event = scrubEvent({
    exception: { values: [{ type: "Error", value: "pg_dump a échoué (1)" }] },
    user: { id: "11f5d6de", email: "etudiant@epfl.ch", ip_address: "128.178.1.1" },
    request: {
      url: "https://cortex.app/api/exams/generate?course=cs-202&token=secret",
      headers: { cookie: "authjs.session-token=abc", authorization: "Bearer x" },
      data: { focus: "les inodes du lab 4" },
      cookies: { "authjs.session-token": "abc" },
    },
    extra: { prompt: "═══ COURS ═══ contenu du poly…", statement_tex: "\\subq{1}" },
    breadcrumbs: [{ message: "GET /api/revision?course=cs-202" }],
  } as never) as Record<string, Record<string, unknown> & { values?: Array<{ value: string }> }>;
  assert.equal(event.exception.values?.[0]?.value, "pg_dump a échoué (1)", "l'erreur elle-même est conservée");
  assert.equal(event.user, undefined, "aucune identité");
  assert.equal(event.request.headers, undefined);
  assert.equal(event.request.cookies, undefined);
  assert.equal(event.request.data, undefined, "aucun corps de requête (il contient du contenu de cours)");
  assert.equal(event.request.url, "https://cortex.app/api/exams/generate", "URL sans paramètres");
  assert.equal(event.extra, undefined, "aucun prompt, aucun énoncé");
  assert.deepEqual(event.breadcrumbs, [], "aucune miette d'URL avec paramètres");
});

test("scrubEvent : le message d'une compilation LaTeX ratée ne sort ni chemin d'étudiant ni énoncé", async () => {
  const { scrubEvent } = await import("../lib/observability");
  // Message réel produit par lib/exam-latex.ts : jusqu'à 800 caractères de
  // journal tectonic, qui cite le chemin du corpus ET le texte de l'énoncé.
  const msg =
    "Échec compilation LaTeX. ! Undefined control sequence. | " +
    "l.42 \\subq{Soit un réseau de Petri modélisant le protocole vu au lab 4 de Martin} | " +
    "! I can't find file `/srv/data/u/martin-dupont/cs-202/refs/annales-2024.tex'.";
  const event = scrubEvent({
    message: msg,
    exception: { values: [{ type: "Error", value: msg }] },
  } as never) as { message?: string; exception: { values: Array<{ value: string }> } };
  const sortie = JSON.stringify(event);
  assert.ok(!sortie.includes("martin-dupont"), "aucun identifiant d'étudiant, même dans un chemin");
  assert.ok(!sortie.includes("réseau de Petri"), "aucun énoncé");
  assert.ok(!sortie.includes("annales-2024"), "aucun nom de document de cours");
  assert.match(event.exception.values[0].value, /Échec compilation LaTeX/, "la nature de la panne reste lisible");
  assert.match(String(event.message), /Échec compilation LaTeX/);
});

test("avec SENTRY_DSN : traces et spans passent par le même nettoyage que les erreurs", async () => {
  const { initErrorTracking } = await import("../lib/observability");
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  process.env.SENTRY_TRACES_SAMPLE_RATE = "1";
  let options: Record<string, unknown> | null = null;
  await initErrorTracking({ load: async () => ({ init: (o: Record<string, unknown>) => { options = o; } }) });
  const o = options as unknown as Record<string, (e: unknown) => unknown>;
  assert.equal(typeof o.beforeSendTransaction, "function", "une transaction porte l'URL complète et les données de requête");
  assert.equal(typeof o.beforeSendSpan, "function");
  const tx = o.beforeSendTransaction({
    transaction: "POST /api/exams/generate",
    request: { url: "https://cortex.app/api/exams/generate?course=cs-202", data: { focus: "les inodes" } },
    user: { email: "etudiant@epfl.ch" },
  }) as { request: Record<string, unknown>; user?: unknown };
  assert.equal(tx.user, undefined);
  assert.equal(tx.request.data, undefined);
  assert.equal(tx.request.url, "https://cortex.app/api/exams/generate");
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});
