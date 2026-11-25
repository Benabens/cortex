import { authRun } from "@/db/auth-store";
import { claimOnce, peekClaim, releaseClaim, settleClaim, STALE_CLAIM_MS } from "@/lib/claim-once";
import type { EmailOutcome } from "@/lib/email";
import { log } from "@/lib/metrics";
import { safeEqual } from "@/lib/oauth/secrets";
import { PayloadTooLarge, readText } from "@/lib/upload-limit";

/**
 * WEBHOOK RAILWAY → MAIL IMMÉDIAT (POST /api/ops/railway-webhook?token=…). Railway l'appelle à
 * chaque changement d'état d'un déploiement et à chaque alerte de monitor, dans tous les
 * environnements du projet. Quatre événements seulement déclenchent un mail court au
 * destinataire du bilan (lib/ops-digest) ; tout le reste est ignoré. Aucun appel au modèle,
 * rien d'autre n'est fait.
 *
 * - Désactivé (404) tant que RAILWAY_WEBHOOK_TOKEN n'est pas posée ; jeton de l'URL comparé en
 *   temps constant, 401 sinon — AVANT de lire le corps. Le jeton est en query string (décision
 *   de Ben, 25/11 ; Railway saurait aussi poser un en-tête, cf. /api/metrics qui le refuse en
 *   URL) : il peut apparaître dans les journaux d'accès, d'où un jeton propre à ce point, sans
 *   autre pouvoir. Sentry ne le voit pas (scrubEvent coupe la query string).
 * - Limite : un plantage de cortex-app est signalé… à cortex-app. Railway réessaie (3 fois) une
 *   réponse hors 2xx ; pendant une boucle de plantages, le mail peut ne jamais partir.
 * - Corps borné à 64 ko (octets réels, pas Content-Length).
 * - Anti-rafale : au plus un mail par environnement, service et type toutes les 15 min, entre
 *   process (claim-once sur une clé par quart d'heure + regard sur le quart d'heure précédent).
 *   Deux process à cheval sur la bascule du quart d'heure peuvent, rarement, envoyer chacun le
 *   leur. Les clés envoyées de plus d'un jour sont purgées à chaque envoi.
 * - Le mail ne reprend du corps que des noms nettoyés et bornés (service, environnement), des
 *   identifiants au format UUID (pour le lien) et la gravité : jamais l'auteur ni le message
 *   du commit, ni le nom de l'espace de travail.
 */

const MAX_BODY = 64 * 1024;
const WINDOW_MS = 15 * 60_000;

/** Une Map, pas un objet : `type: "constructor"` ne doit pas trouver un libellé hérité. */
const EVENTS = new Map<string, string>([
  ["Deployment.failed", "déploiement en échec"],
  ["Deployment.crashed", "service planté"],
  ["Deployment.oom_killed", "mémoire épuisée (OOM)"],
  ["Monitor.triggered", "alerte de monitor déclenchée"],
]);

type Mail = { to: string; subject: string; text: string; idempotencyKey?: string };
type Deps = { now?: Date; send?: (m: Mail) => Promise<EmailOutcome> };

const reply = (status: number, body?: Record<string, string>) => body ? Response.json(body, { status }) : new Response(null, { status });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
/** Nom affichable : une ligne, lettres, chiffres et « ._- » seulement, 60 caractères au plus. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return s || null;
}
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

/** « 25.11.2026 11:04 », heure de Zurich. */
function zurichTime(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** Le quart d'heure précédent a-t-il déjà envoyé (ou envoie-t-il) depuis moins de 15 min ? */
async function recentlySent(key: string, now: Date): Promise<boolean> {
  const held = await peekClaim(key);
  if (!held) return false;
  if (held.state === "sent") return held.at === null || now.getTime() - held.at < WINDOW_MS;
  // Envoi en cours ailleurs : récent tant que sa réclamation n'est pas celle d'un process mort
  // (même horloge que claimOnce pour en juger).
  return !(Date.now() - held.since > STALE_CLAIM_MS);
}

async function defaultSend(m: Mail): Promise<EmailOutcome> {
  const { sendEmail } = await import("@/lib/email");
  return sendEmail(m);
}

/** Traite un appel du webhook. Ne lève pas pour un corps invalide ; rend la réponse HTTP. */
export async function handleRailwayWebhook(req: Request, deps: Deps = {}): Promise<Response> {
  const expected = process.env.RAILWAY_WEBHOOK_TOKEN?.trim();
  if (!expected) return reply(404);
  if (!safeEqual(new URL(req.url).searchParams.get("token") ?? "", expected)) return reply(401);

  let raw: string;
  try {
    raw = await readText(req, MAX_BODY);
  } catch (e) {
    if (e instanceof PayloadTooLarge) return reply(413);
    throw e;
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return reply(400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400);

  const type = field(body, "type");
  const label = typeof type === "string" ? EVENTS.get(type) : undefined;
  if (!label) return reply(200, { status: "ignored" });

  const now = deps.now ?? new Date();
  const resource = field(body, "resource");
  const project = uuid(field(field(resource, "project"), "id"));
  const env = field(resource, "environment");
  const svc = field(resource, "service");
  const envId = uuid(field(env, "id"));
  const svcId = uuid(field(svc, "id"));
  const envName = cleanName(field(env, "name")) ?? "inconnu";
  const svcName = cleanName(field(svc, "name")) ?? "inconnu";
  const severity = String(field(body, "severity") ?? "").replace(/[^A-Z]/g, "").slice(0, 16);
  const stamp = Date.parse(String(field(body, "timestamp") ?? ""));
  const at = Number.isFinite(stamp) ? new Date(stamp) : now;

  const bucket = Math.floor(now.getTime() / WINDOW_MS);
  const base = `railway_webhook:${envId ?? "inconnu"}:${svcId ?? "inconnu"}:${type}`;
  const key = `${base}:${bucket}`;
  if (await recentlySent(`${base}:${bucket - 1}`, now)) return reply(200, { status: "throttled" });
  const claim = await claimOnce(key);
  if (claim.state !== "won") return reply(200, { status: "throttled" });

  const { opsRecipient } = await import("@/lib/ops-digest");
  const to = await opsRecipient();
  if (!to) {
    await releaseClaim(key, claim.token);
    log("warn", "railway_webhook.no_recipient", { type });
    return reply(503);
  }
  const link = project && svcId && envId
    ? `https://railway.com/project/${project}/service/${svcId}?environmentId=${envId}`
    : process.env.OPS_RAILWAY_URL?.trim() || "https://railway.com/dashboard";
  const text = [
    `Railway : ${label}`,
    "",
    `Service : ${svcName}`,
    `Environnement : ${envName}`,
    `Heure : ${zurichTime(at)} (Zurich)`,
    ...(severity ? [`Gravité : ${severity}`] : []),
    "",
    `Railway : ${link}`,
    "",
    "Au plus un mail par environnement, service et type d'événement toutes les 15 min.",
  ].join("\n");
  const subject = `Cortex — Railway : ${label} · ${svcName} (${envName})`;

  const out = await (deps.send ?? defaultSend)({ to, subject, text, idempotencyKey: `${key}:${claim.chain}` });
  if (out.ok) {
    await settleClaim(key, claim.token, `sent ${now.toISOString()}`);
    // Les clés envoyées de plus d'un jour ne servent plus (seul le quart d'heure précédent est relu).
    await authRun(`DELETE FROM app_meta WHERE key LIKE 'railway_webhook:%' AND value LIKE 'sent %' AND value < ?`, `sent ${new Date(now.getTime() - 86_400_000).toISOString()}`);
    return reply(200, { status: "sent" });
  }
  log("error", "railway_webhook.send_failed", { type, reason: out.reason.slice(0, 200), uncertain: !!out.uncertain, status: out.status });
  // Peut-être parti : la clé reste prise, aucun second mail dans ce quart d'heure.
  if (!out.uncertain) await releaseClaim(key, claim.token);
  return reply(502);
}
