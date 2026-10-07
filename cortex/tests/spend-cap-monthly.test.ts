/**
 * Plafond de dépense GLOBAL par MOIS CALENDAIRE (UTC). Avant, SPEND_CAP_USD se
 * comparait à la dépense cumulée depuis la création de l'instance : une fois
 * atteint, la génération restait coupée pour toujours. Il se compare désormais
 * à la dépense du mois en cours et repart de zéro le 1er.
 *
 * Base : PGlite (le dialecte de la prod). L'horloge est pilotée, le réseau
 * (Resend) est remplacé par un faux `fetch`.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-plafond-mois-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

const ENV_KEYS = ["SPEND_CAP_USD", "SPEND_CAP_PER_USER_USD", "AUTH_ENABLED", "BILLING_ENABLED", "RESEND_API_KEY", "CORTEX_OWNER_EMAIL", "PUBLISHER_EMAIL", "AUTH_EMAIL_FROM"];

let usage: typeof import("../lib/billing/usage");
let authRun: typeof import("../db/auth-store").authRun;

before(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  usage = await import("../lib/billing/usage");
  ({ authRun } = await import("../db/auth-store"));
  await authRun("SELECT 1");
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of [...ENV_KEYS, "DB_DRIVER", "DATABASE_URL", "CORTEX_DATA_DIR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  usage.resetSpendCache();
});

/** Un appel payant de `usd` dollars, daté de l'horloge courante (Sonnet : 2 $ par MTok en entrée). */
const spend = (usd: number) => usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: usd * 500_000 });
const isSpendCap = (e: unknown) => (e as { code?: string }).code === "SPEND_CAP";

test("le plafond global ne compte que le mois UTC en cours : atteint le 31, rouvert le 1er", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 31, 23, 59, 50) });
  process.env.SPEND_CAP_USD = "10";
  await spend(12);
  await assert.rejects(
    () => usage.assertSpendCap("anthropic"),
    (e: Error) => isSpendCap(e) && /du mois/.test(e.message) && e.message.includes("12.00 $"),
  );

  // Quinze secondes plus tard, on est le 1er novembre : la dépense d'octobre ne compte plus.
  t.mock.timers.setTime(Date.UTC(2026, 10, 1, 0, 0, 5));
  await usage.assertSpendCap("anthropic");
  assert.equal(await usage.monthSpendUsd(), 0);

  await spend(4);
  assert.equal(await usage.monthSpendUsd(), 4);
  await usage.assertSpendCap("anthropic");
});

type Mail = { from: string; to: string; subject: string; text: string; idempotencyKey?: string };
/** Remplace `fetch` : collecte les e-mails remis à Resend, répond `status`. */
function fakeResend(t: import("node:test").TestContext, status = 200): Mail[] {
  const sent: Mail[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    sent.push({ ...(JSON.parse(String(init?.body)) as Mail), idempotencyKey: new Headers(init?.headers).get("idempotency-key") ?? undefined });
    return new Response("{}", { status });
  });
  return sent;
}
/** Un process neuf : ni cache de dépense, ni mémoire des alertes déjà traitées. */
const freshProcess = () => usage.resetSpendCache();

test("à 80 % du plafond du mois, un seul e-mail part au propriétaire", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 0, 10, 12, 0, 0) });
  const sent = fakeResend(t);
  process.env.SPEND_CAP_USD = "10";
  process.env.RESEND_API_KEY = "re_test";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
  process.env.AUTH_EMAIL_FROM = "Cortex <noreply@exemple.test>";

  await spend(7);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 0, "70 % : rien");

  await spend(1.5);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ben@exemple.test");
  assert.equal(sent[0].from, "Cortex <noreply@exemple.test>");
  assert.match(sent[0].subject, /80 %/);
  assert.ok(sent[0].text.includes("8.50 $") && sent[0].text.includes("2027-01"), sent[0].text);

  // Les appels suivants, ici ou depuis une autre instance, ne renvoient rien.
  await usage.assertSpendCap("anthropic");
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);
});

/** Propriétaire joignable et Resend configuré ; plafond global de 10 $. */
function alertsConfigured(): void {
  process.env.SPEND_CAP_USD = "10";
  process.env.RESEND_API_KEY = "re_test";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
}

test("à 100 %, un second e-mail part et l'appel est refusé", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 1, 10, 12, 0, 0) });
  const sent = fakeResend(t);
  alertsConfigured();

  await spend(8.5);
  await usage.assertSpendCap("anthropic");
  await spend(2);
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  assert.deepEqual(sent.map((m) => m.subject), [
    "Cortex : 80 % du plafond de dépense IA du mois",
    "Cortex : plafond de dépense IA du mois atteint, génération coupée",
  ]);

  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  freshProcess();
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  assert.equal(sent.length, 2, "chaque seuil n'est signalé qu'une fois");
});

test("le mois suivant, les seuils sont de nouveau signalés", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 2, 31, 22, 0, 0) });
  const sent = fakeResend(t);
  alertsConfigured();

  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);

  t.mock.timers.setTime(Date.UTC(2027, 3, 1, 1, 0, 0));
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1, "avril repart de zéro : pas d'alerte");
  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes("2027-04") && sent[1].text.includes("9.00 $"), sent[1].text);
});

test("le seuil est signalé dès la fin de l'appel qui le franchit, sans attendre le suivant", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 4, 10, 12, 0, 0) });
  const sent = fakeResend(t);
  alertsConfigured();

  const call = { provider: "anthropic", model: "claude-sonnet-5" };
  const pending = await usage.openUsage({ ...call, tokensIn: 0, tokensOut: 0 });
  await usage.closeUsage(pending, { ...call, tokensIn: 4_500_000 }); // 9 $
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /80 %/);
});

test("deux instances franchissent le seuil en même temps : un seul e-mail", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 5, 10, 12, 0, 0) });
  alertsConfigured();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let sends = 0;
  // Seul le premier envoi est retenu : un second, s'il partait, se verrait au compte.
  t.mock.method(globalThis, "fetch", async () => { if (++sends === 1) await held; return new Response("{}", { status: 200 }); });

  await spend(9);
  const first = usage.assertSpendCap("anthropic"); // réclame le seuil, envoi en cours
  await new Promise((r) => setImmediate(r));
  while (sends === 0) await new Promise((r) => setImmediate(r));
  freshProcess(); // une autre instance, qui ne sait rien de la première
  await usage.assertSpendCap("anthropic");
  release();
  await first;
  assert.equal(sends, 1);
});

test("envoi impossible : avertissement explicite, aucun refus, nouvel essai une heure plus tard", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 6, 10, 12, 0, 0) });
  const warnings: string[] = [];
  t.mock.method(console, "error", (line: string) => { warnings.push(String(line)); });
  const sent = fakeResend(t);
  process.env.SPEND_CAP_USD = "10";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";

  await spend(9);
  await usage.assertSpendCap("anthropic"); // sous le plafond : l'appel passe, sans clé Resend
  assert.equal(sent.length, 0);
  const warned = warnings.filter((w) => w.includes("spend_alert.not_sent"));
  assert.equal(warned.length, 1);
  assert.ok(warned[0].includes("RESEND_API_KEY absente"), warned[0]);

  // La clé arrive : pas de rafale d'essais, le suivant attend une heure.
  process.env.RESEND_API_KEY = "re_test";
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 0);
  t.mock.timers.setTime(Date.UTC(2027, 6, 10, 13, 0, 1));
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);
});

test("Resend en panne : l'appel passe, le seuil sera signalé plus tard", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 7, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  alertsConfigured();
  const refused = fakeResend(t, 500);
  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(refused.length, 1);

  t.mock.restoreAll();
  const sent = fakeResend(t);
  freshProcess(); // un autre process reprend le seuil rendu
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);
});

test("sans destinataire configuré : avertissement, aucun envoi", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 8, 10, 12, 0, 0) });
  const warnings: string[] = [];
  t.mock.method(console, "error", (line: string) => { warnings.push(String(line)); });
  const sent = fakeResend(t);
  process.env.SPEND_CAP_USD = "10";
  process.env.RESEND_API_KEY = "re_test";

  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 0);
  assert.ok(warnings.some((w) => w.includes("CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL")), warnings.join("\n"));

  // À défaut de propriétaire, l'adresse de l'éditeur reçoit l'alerte.
  process.env.PUBLISHER_EMAIL = "editeur@exemple.test";
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.deepEqual(sent.map((m) => m.to), ["editeur@exemple.test"]);
});

test("relever le plafond en cours de mois réarme les alertes sur la nouvelle valeur", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 9, 10, 12, 0, 0) });
  const sent = fakeResend(t);
  alertsConfigured();

  await spend(10);
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  assert.equal(sent.length, 1);

  process.env.SPEND_CAP_USD = "20";
  await usage.assertSpendCap("anthropic"); // 50 % du nouveau plafond
  assert.equal(sent.length, 1);
  await spend(7);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes("SPEND_CAP_USD = 20 $"), sent[1].text);
});

test("fail-closed inchangé : défaut de 50 $, « unlimited », kill-switch « 0 », base injoignable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 10, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  const sent = fakeResend(t);
  process.env.RESEND_API_KEY = "re_test";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
  process.env.SPEND_CAP_PER_USER_USD = "unlimited";
  const { LlmError } = await import("../lib/llm/types");
  const unavailable = (e: unknown) => e instanceof LlmError && e.code === "UNAVAILABLE";

  // Kill-switch : coupe tout, même sans un centime dépensé ce mois-ci, et ce n'est pas une alerte.
  process.env.SPEND_CAP_USD = "0";
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  await usage.assertSpendCap("claude-code");
  assert.equal(sent.length, 0);

  // Variable oubliée sur une instance gardée : 50 $ pour le mois.
  delete process.env.SPEND_CAP_USD;
  process.env.AUTH_ENABLED = "1";
  await spend(39);
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 0);
  await spend(11);
  freshProcess();
  await assert.rejects(() => usage.assertSpendCap("anthropic"), (e: Error) => isSpendCap(e) && e.message.includes("SPEND_CAP_USD=50 $"));
  assert.equal(sent.length, 1);

  // Levée explicite : plus de plafond, donc plus de seuil.
  process.env.SPEND_CAP_USD = "unlimited";
  await spend(100);
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 1);

  // Dépense illisible : refus sur une instance gardée, passage en dev.
  process.env.SPEND_CAP_USD = "1000";
  await authRun("ALTER TABLE llm_usage RENAME TO llm_usage_off");
  try {
    freshProcess();
    await assert.rejects(() => usage.assertSpendCap("anthropic"), unavailable);
    delete process.env.AUTH_ENABLED;
    freshProcess();
    await usage.assertSpendCap("anthropic");
  } finally {
    await authRun("ALTER TABLE llm_usage_off RENAME TO llm_usage");
  }
});

test("une alerte impossible à enregistrer ne refuse pas l'appel", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 11, 10, 12, 0, 0) });
  const warnings: string[] = [];
  t.mock.method(console, "error", (line: string) => { warnings.push(String(line)); });
  const sent = fakeResend(t);
  alertsConfigured();
  process.env.AUTH_ENABLED = "1";
  process.env.SPEND_CAP_PER_USER_USD = "unlimited";

  await spend(9);
  await authRun("ALTER TABLE app_meta RENAME TO app_meta_off");
  try {
    freshProcess();
    await usage.assertSpendCap("anthropic");
  } finally {
    await authRun("ALTER TABLE app_meta_off RENAME TO app_meta");
  }
  assert.equal(sent.length, 0);
  assert.ok(warnings.some((w) => w.includes("spend_alert.failed")), warnings.join("\n"));
});

test("les deux seuils franchis d'un coup : un seul e-mail, celui du plafond atteint, et le 80 % reste acquis", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 0, 10, 12, 0, 0) });
  const sent = fakeResend(t);
  alertsConfigured();

  // 7 $ dépensés, puis deux appels en vol estimés à 1,50 $ et 2,50 $ : 11 $, plafond dépassé d'un coup.
  const call = { provider: "anthropic", model: "claude-sonnet-5" };
  await spend(7);
  await usage.openUsage({ ...call, tokensIn: 750_000, tokensOut: 0 });
  const second = await usage.openUsage({ ...call, tokensIn: 1_250_000, tokensOut: 0 });
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
  assert.deepEqual(sent.map((m) => m.subject), ["Cortex : plafond de dépense IA du mois atteint, génération coupée"]);

  // Le second appel est refusé par le fournisseur : le total retombe à 85 %. Le seuil de
  // 80 % a été couvert par l'e-mail du plafond : ni ce process ni un autre ne le signale après coup.
  await usage.discardUsage(second);
  await usage.assertSpendCap("anthropic");
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(await usage.monthSpendUsd(), 8.5);
  assert.equal(sent.length, 1);
});

test("un autre process dépasse le plafond juste après la fin d'un appel : l'appel suivant est refusé", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 1, 10, 12, 0, 0) });
  fakeResend(t);
  alertsConfigured();

  const call = { provider: "anthropic", model: "claude-sonnet-5" };
  const pending = await usage.openUsage({ ...call, tokensIn: 0, tokensOut: 0 });
  await usage.closeUsage(pending, { ...call, tokensIn: 500_000 }); // 1 $
  // Dépense d'un worker de job, écrite sans passer par ce process.
  await authRun(
    "INSERT INTO llm_usage (user_id, course, provider, model, cost_usd, created_at) VALUES (?,?,?,?,?,?)",
    "autre", "cs-202", "anthropic", "claude-sonnet-5", 20, "2028-02-10 12:00:01",
  );
  t.mock.timers.setTime(Date.UTC(2028, 1, 10, 12, 0, 5));
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);
});

test("à minuit le 1er, la somme lue et le mois annoncé sont ceux du même mois", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 2, 31, 23, 59, 59) });
  const sent = fakeResend(t);
  alertsConfigured();
  await spend(12);

  // La somme de mars est demandée à 23:59:59 ; quand elle revient, on est en avril.
  const refused = assert.rejects(
    () => usage.assertSpendCap("anthropic"),
    (e: Error) => isSpendCap(e) && e.message.includes("pour 2028-03"),
  );
  t.mock.timers.setTime(Date.UTC(2028, 3, 1, 0, 0, 0));
  await refused;
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("2028-03"), sent[0].text);

  // Avril n'a rien perdu : ses seuils seront signalés quand ils seront franchis.
  await usage.assertSpendCap("anthropic");
  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes("2028-04") && sent[1].text.includes("9.00 $"), sent[1].text);
});

test("réponse de Resend perdue : la reprise porte la même clé d'idempotence, et Resend qui la reconnaît vaut envoi fait", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 4, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  alertsConfigured();
  const keys: string[] = [];
  let answer: () => Response = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    return answer();
  });

  await spend(9);
  await usage.assertSpendCap("anthropic"); // envoi sans réponse : l'appel passe quand même
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith("spend_alert:2028-05:80:10:"), keys[0]);

  // On ne sait pas si l'e-mail est parti : le seuil n'est pas rendu, personne ne renvoie tout de suite.
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 1);

  // Un quart d'heure plus tard, un autre process reprend sous la MÊME clé. Resend la reconnaît
  // (contenu différent : le total a bougé) : le premier essai avait été accepté, on s'arrête là.
  answer = () => new Response(JSON.stringify({ statusCode: 409, name: "invalid_idempotent_request" }), { status: 409 });
  t.mock.timers.setTime(Date.UTC(2028, 4, 10, 12, 16, 0));
  await spend(0.5);
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);

  t.mock.timers.setTime(Date.UTC(2028, 4, 10, 15, 0, 0));
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 2, "seuil tenu pour signalé");
});

test("premier essai encore en cours chez Resend (409) : pas tenu pour envoyé, repris plus tard sous la même clé", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 6, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  alertsConfigured();
  const keys: string[] = [];
  let status = 409;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    return new Response(JSON.stringify(status === 409 ? { statusCode: 409, name: "concurrent_idempotent_requests" } : { id: "x" }), { status });
  });

  await spend(9);
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 1);

  // Le même process reprend sa propre réclamation au bout d'un quart d'heure, pas d'une heure.
  t.mock.timers.setTime(Date.UTC(2028, 6, 10, 12, 16, 0));
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 2, "le 409 « en cours » n'a pas clos le seuil");

  // La clé suit la réclamation de reprise en reprise, jusqu'à ce que Resend réponde.
  status = 200;
  t.mock.timers.setTime(Date.UTC(2028, 6, 10, 12, 32, 0));
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);

  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 3);
});

test("refus net de Resend : rien n'est parti, l'essai suivant prend une clé d'idempotence neuve", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 7, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  alertsConfigured();
  const keys: string[] = [];
  let status = 403;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    return new Response("{}", { status });
  });

  await spend(9);
  await usage.assertSpendCap("anthropic");
  status = 200;
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(keys.length, 2);
  // Une clé qui a servi à un essai refusé peut rester retenue par Resend : on n'y revient pas.
  assert.notEqual(keys[1], keys[0]);
  assert.ok(keys[1].startsWith("spend_alert:2028-08:80:10:"), keys[1]);
});

test("le plafond réclamé par un autre process ne couvre pas le 80 % tant que son e-mail n'est pas parti", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 8, 10, 12, 0, 0) });
  t.mock.method(console, "error", () => {});
  alertsConfigured();
  const subjects: string[] = [];
  let release!: (r: Response) => void;
  const held = new Promise<Response>((r) => { release = r; });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    subjects.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return subjects.length === 1 ? held : new Response("{}", { status: 200 });
  });

  // 8,50 $ fermes et un appel en vol estimé à 2,50 $ : 110 % d'un coup.
  const call = { provider: "anthropic", model: "claude-sonnet-5" };
  await spend(8.5);
  const inflight = await usage.openUsage({ ...call, tokensIn: 1_250_000, tokensOut: 0 });
  const first = assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap); // réclame le 100 %, envoi en cours
  while (subjects.length === 0) await new Promise((r) => setImmediate(r));

  freshProcess(); // un autre process voit le 100 % pris : il ne doit pas en déduire que le 80 % est signalé
  await assert.rejects(() => usage.assertSpendCap("anthropic"), isSpendCap);

  // L'envoi du premier est refusé, puis l'appel en vol aussi : le total retombe à 85 %.
  release(new Response("{}", { status: 500 }));
  await first;
  await usage.discardUsage(inflight);
  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.deepEqual(subjects, [
    "Cortex : plafond de dépense IA du mois atteint, génération coupée",
    "Cortex : 80 % du plafond de dépense IA du mois",
  ]);
});

test("un process tué entre la réclamation du seuil et l'envoi : un autre reprend l'alerte un quart d'heure plus tard", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2028, 5, 10, 12, 0, 0) });
  alertsConfigured();
  let sends = 0;
  // Le premier envoi ne revient jamais : c'est le process tué en plein envoi.
  t.mock.method(globalThis, "fetch", async () => (++sends === 1 ? new Promise<Response>(() => {}) : new Response("{}", { status: 200 })));

  await spend(9);
  void usage.assertSpendCap("anthropic");
  while (sends === 0) await new Promise((r) => setImmediate(r));

  freshProcess();
  t.mock.timers.setTime(Date.UTC(2028, 5, 10, 12, 5, 0));
  await usage.assertSpendCap("anthropic");
  assert.equal(sends, 1, "cinq minutes : la réclamation est peut-être encore en cours");

  freshProcess();
  t.mock.timers.setTime(Date.UTC(2028, 5, 10, 12, 16, 0));
  await usage.assertSpendCap("anthropic");
  assert.equal(sends, 2);

  freshProcess();
  await usage.assertSpendCap("anthropic");
  assert.equal(sends, 2);
});

test("au démarrage, un plafond dont les alertes ne peuvent pas partir est signalé dans les logs", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "error", (line: string) => { warnings.push(String(line)); });
  process.env.SPEND_CAP_USD = "50";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
  usage.warnIfSpendAlertsBlocked();
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("spend_alert.disabled") && warnings[0].includes("RESEND_API_KEY absente"), warnings[0]);

  process.env.RESEND_API_KEY = "re_test";
  usage.warnIfSpendAlertsBlocked();
  process.env.SPEND_CAP_USD = "unlimited";
  delete process.env.RESEND_API_KEY;
  usage.warnIfSpendAlertsBlocked();
  assert.equal(warnings.length, 1, "alertes prêtes, ou pas de plafond : rien à signaler");
});
