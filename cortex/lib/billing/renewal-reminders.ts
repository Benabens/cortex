/**
 * RAPPEL DE RECONDUCTION DE L'ABONNEMENT ANNUEL — art. L215-1 du Code de la
 * consommation (CGV, article 7). Un contrat à reconduction tacite impose
 * d'écrire au client, par un e-mail DÉDIÉ, au plus tôt trois mois et au plus
 * tard un mois avant la date limite de non-reconduction, pour lui dire qu'il
 * peut ne pas reconduire ; la date limite y figure dans un encadré apparent.
 * Sans cet e-mail, le client peut résilier sans frais à tout moment après la
 * reconduction, et se faire rembourser la période restante.
 *
 * QUI : les abonnements ANNUELS que Stripe reconduira (ni terminés, ni résiliés
 * en fin de période). Le mensuel n'est pas visé : sa période est plus courte
 * que le préavis.
 * QUAND : à partir de 60 jours avant la fin de la période PAYÉE, et tant qu'il
 * reste plus de 30 jours ET plus d'un mois calendaire. Trop tard, rien n'est
 * envoyé (il serait hors délai) : une erreur est journalisée, une seule fois.
 * D'OÙ : la table `subscriptions` (écrite par le webhook) désigne les candidats ;
 * au moment d'écrire, l'abonnement est RELU chez Stripe, qui fait foi pour ce
 * que l'e-mail annonce (reconduction encore prévue, date, montant de CET
 * abonnement). Stripe injoignable : pas d'e-mail, nouvelle tentative demain.
 *
 * UNE FOIS par abonnement et par période, même avec plusieurs instances :
 * marqueur réclamé dans `app_meta` (lib/claim-once), qui garde la date d'envoi.
 *  - refus net de Resend : rien n'est parti, le marqueur est rendu, nouvel essai
 *    au passage du lendemain ;
 *  - issue inconnue (pas de réponse) : la réclamation reste et le jour est
 *    rouvert ; le passage suivant (30 min) la reprend sous la MÊME clé
 *    d'idempotence Resend, retenue 24 h, qui écarte le doublon.
 *
 * TÂCHE QUOTIDIENNE lancée par le serveur lui-même (instrumentation.ts), comme
 * la sauvegarde : le jour UTC est réclamé dans `app_meta`, une seule instance
 * fait le passage. Active seulement avec la facturation (BILLING_ENABLED=1).
 */
import type Stripe from "stripe";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { claimOnce, isSent, releaseClaim, SENT, settleClaim } from "@/lib/claim-once";
import { contactEmail } from "@/lib/contact";
import { sendEmail } from "@/lib/email";
import { legalLinks } from "@/lib/legal";
import { log } from "@/lib/metrics";
import { publicOrigin } from "@/lib/public-url";
import { addMonthsClamped, isYearly, stillBilling } from "./subscription-windows";

const DAY_MS = 86_400_000;
/** Envoi visé : 60 jours avant l'échéance (la loi autorise de 3 mois à 1 mois avant). */
export const REMIND_FROM_DAYS = 60;
/** En deçà, l'e-mail serait hors délai : il doit rester PLUS de 30 jours (et plus d'un mois calendaire). */
export const REMIND_UNTIL_DAYS = 30;

const parse = (s: string) => new Date(s.replace(" ", "T") + "Z");
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

// ─────────────────────────── à qui, et quand ───────────────────────────

export type ReminderSub = {
  subscription_id: string | null; plan: string | null; status: string;
  period_start: string | null; period_end: string | null;
  cancel_at_period_end?: number | boolean | null;
};
export type ReminderVerdict = "due" | "too-early" | "too-late" | "not-yearly" | "not-renewing";

/** Le rappel est-il dû maintenant pour cette ligne ? Logique pure (dates « YYYY-MM-DD HH:MM:SS » UTC). */
export function reminderVerdict(sub: ReminderSub, now: string): ReminderVerdict {
  // Tant que Stripe tient l'abonnement pour vivant (même impayé ou suspendu), il le reconduira.
  if (!sub.subscription_id || !sub.period_end || !stillBilling(sub.status) || Number(sub.cancel_at_period_end ?? 0)) return "not-renewing";
  if (!isYearly(sub)) return "not-yearly";
  const end = parse(sub.period_end).getTime();
  if (now < fmt(new Date(end - REMIND_FROM_DAYS * DAY_MS))) return "too-early";
  // « Un mois » se compte en mois calendaire : 28 à 31 jours selon l'échéance. On tient les deux bornes.
  const byDays = fmt(new Date(end - REMIND_UNTIL_DAYS * DAY_MS));
  const byMonth = addMonthsClamped(sub.period_end, -1);
  return now < (byDays < byMonth ? byDays : byMonth) ? "due" : "too-late";
}

// ─────────────────────────── ce que dit Stripe ───────────────────────────

export type RenewalFacts = {
  /** Stripe reconduira-t-il cet abonnement ? (vivant, sans résiliation programmée) */
  renews: boolean;
  yearly: boolean;
  /** Fin de la période en cours chez Stripe : la date de reconduction. */
  periodEnd: string | null;
  /** Prix d'une période de CET abonnement (pas le tarif public du jour), ou null s'il n'est pas lisible. */
  amount: number | null;
  currency: string | null;
};

/** Lecture d'un abonnement Stripe, format récent (période sur l'item) ou ancien (sur l'abonnement). */
export function renewalFactsOf(sub: Stripe.Subscription): RenewalFacts {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const end = item?.current_period_end ?? (sub as { current_period_end?: number }).current_period_end;
  const canceling = !!sub.cancel_at_period_end || (typeof sub.cancel_at === "number" && sub.cancel_at > 0);
  const price = item?.price;
  return {
    renews: stillBilling(sub.status) && !canceling,
    yearly: price?.recurring?.interval === "year",
    periodEnd: typeof end === "number" && end > 0 ? fmt(new Date(end * 1000)) : null,
    amount: typeof price?.unit_amount === "number" ? (price.unit_amount * (item?.quantity ?? 1)) / 100 : null,
    currency: price?.currency?.toUpperCase() ?? null,
  };
}

/** État de l'abonnement chez Stripe ; null s'il n'y existe pas (rien ne sera reconduit). Lève si Stripe est injoignable. */
export async function stripeRenewalFacts(subscriptionId: string): Promise<RenewalFacts | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY absente");
  const { stripeClient } = await import("./stripe-client");
  try {
    return renewalFactsOf(await stripeClient(key).subscriptions.retrieve(subscriptionId));
  } catch (e) {
    if ((e as { code?: string }).code === "resource_missing") return null;
    throw e;
  }
}

// ─────────────────────────── l'e-mail ───────────────────────────

const PARIS = "Europe/Paris";
type Day = { y: number; m: number; d: number };
/** Jour civil à Paris d'un instant UTC : c'est la date que lit le client. */
function parisDay(at: Date): Day {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: PARIS, year: "numeric", month: "2-digit", day: "2-digit" }).format(at).split("-").map(Number);
  return { y, m, d };
}
const longDate = (day: Day, locale: string) =>
  new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(day.y, day.m - 1, day.d, 12)));
const money = (amount: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type ReminderMail = { subject: string; text: string; html: string };

/**
 * L'e-mail dédié de l'art. L215-1 : échéance, montant, reconduction tacite,
 * moyen de s'y opposer, et la DATE LIMITE dans un encadré apparent. Cette date
 * est la veille de l'échéance (heure de Paris) : résilier ce jour-là arrive
 * toujours avant le prélèvement, quelle que soit l'heure de la reconduction.
 * En français (langue du contrat ; l'app ne connaît pas celle du client),
 * suivi d'un résumé en anglais.
 */
export function renewalReminderEmail(o: {
  /** Fin de la période payée : date de reconduction (« YYYY-MM-DD HH:MM:SS » UTC). */
  renewsAt: string; amount: number; currency: string;
  /** Page Compte de l'app : c'est là qu'on ouvre le portail Stripe. */
  accountUrl: string; contact: string; termsUrl?: string | null;
}): ReminderMail {
  const due = parisDay(parse(o.renewsAt));
  const last = parisDay(new Date(Date.UTC(due.y, due.m - 1, due.d - 1, 12)));
  const fr = { due: longDate(due, "fr-FR"), last: longDate(last, "fr-FR"), price: money(o.amount, o.currency, "fr-FR") };
  const en = { due: longDate(due, "en-GB"), last: longDate(last, "en-GB"), price: money(o.amount, o.currency, "en-GB") };
  const cgv = o.termsUrl ? ` : ${o.termsUrl}` : "";

  const subject = `Cortex Pro : votre abonnement annuel se renouvelle le ${fr.due}`;
  const intro = `Votre abonnement annuel Cortex Pro arrive à échéance le ${fr.due}.`;
  const tacit = `Il s'agit d'un contrat à reconduction tacite : sans action de votre part, il sera renouvelé automatiquement ce jour-là pour une nouvelle année, et ${fr.price} seront prélevés sur votre moyen de paiement.`;
  const boxLabel = "Date limite pour refuser la reconduction";
  const how = `Vous pouvez vous opposer à ce renouvellement, sans frais et sans avoir à vous justifier, jusqu'au ${fr.last} inclus :`;
  const step1 = "Ouvrez votre page Compte";
  const step2 = "Cliquez sur « Gérer mon abonnement » (portail sécurisé Stripe), puis annulez l'abonnement.";
  const effect = `La résiliation prend effet à la fin de la période déjà payée : vous gardez Cortex Pro et vos crédits mensuels jusqu'au ${fr.due}, et plus rien n'est prélevé ensuite.`;
  const byMail = `Vous pouvez aussi nous écrire à ${o.contact} : nous enregistrerons votre résiliation.`;
  const keep = "Si vous souhaitez continuer, vous n'avez rien à faire.";
  const why = `Pourquoi ce message ? L'article L215-1 du Code de la consommation nous demande de vous informer, au plus tôt trois mois et au plus tard un mois avant cette date limite, que vous pouvez ne pas reconduire un contrat conclu avec une clause de reconduction tacite. Les conditions de reconduction figurent à l'article 7 de nos conditions générales de vente`;
  const english = `In English: your annual Cortex Pro subscription renews automatically on ${en.due} for ${en.price}. To opt out, cancel by ${en.last} from your Account page (“Gérer mon abonnement”, then cancel the subscription), or write to ${o.contact}. Cancelling takes effect at the end of the period you have already paid for.`;

  const rule = "+" + "-".repeat(62) + "+";
  const text = [
    "Bonjour,", intro, tacit,
    `${rule}\n  ${boxLabel.toUpperCase()} : ${fr.last}\n${rule}`,
    `${how}\n\n1. ${step1} : ${o.accountUrl}\n2. ${step2}`,
    effect, byMail, keep, `${why}${cgv}`, "L'équipe Cortex", english,
  ].join("\n\n");

  const p = (body: string, style = "") => `<p style="margin:0 0 14px;${style}">${body}</p>`;
  const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:#c4b5fd">${esc(label)}</a>`;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:24px 12px;background:#0d0b14;color:#e7e5ef;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">`
    + `<div style="max-width:560px;margin:0 auto;padding:28px;background:#15121f;border:1px solid #2b2640;border-radius:12px">`
    + p("cortex.", "font-size:19px;font-weight:600;color:#ffffff")
    + p("Bonjour,") + p(esc(intro)) + p(esc(tacit))
    + `<div style="margin:20px 0;padding:16px 18px;border:2px solid #f5b544;border-radius:10px;background:#1c1830">`
    + `<div style="color:#f5b544;font-size:14px">${esc(boxLabel)}</div>`
    + `<div style="margin-top:4px;color:#ffffff;font-size:21px;font-weight:700">${esc(fr.last)}</div></div>`
    + p(esc(how))
    + `<ol style="margin:0 0 14px;padding-left:22px"><li style="margin-bottom:6px">${link(o.accountUrl, step1)}</li><li>${esc(step2)}</li></ol>`
    + p(esc(effect))
    + p(`Vous pouvez aussi nous écrire à ${link(`mailto:${o.contact}`, o.contact)} : nous enregistrerons votre résiliation.`)
    + p(esc(keep))
    + p(`${esc(why)}${o.termsUrl ? ` (${link(o.termsUrl, "lire les CGV")})` : ""}.`, "color:#a9a4bd;font-size:13px")
    + p("L'équipe Cortex")
    + `<p lang="en" style="margin:18px 0 0;padding-top:14px;border-top:1px solid #2b2640;color:#a9a4bd;font-size:13px">${esc(english)}</p>`
    + `</div></body></html>`;
  return { subject, text, html };
}

// ─────────────────────────── le passage ───────────────────────────

/** Marqueur d'un rappel hors délai, jamais parti : journalisé une fois, plus réexaminé. */
const MISSED = "missed";
const markerKey = (subscriptionId: string, periodEnd: string) => `renewal_reminder:${subscriptionId}:${periodEnd.replace(" ", "T")}`;
const readMarker = async (key: string) => (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, key))?.value;
const closed = (marker: string | undefined) => isSent(marker) || !!marker?.startsWith(MISSED);

export type ReminderReport = {
  /** e-mails partis pendant ce passage */
  sent: number;
  /** à refaire demain : refus de Resend, Stripe injoignable, compte sans adresse, montant illisible */
  failed: number;
  /** issue inconnue ou envoi en cours ailleurs : à reprendre au passage suivant, le jour même */
  pending: number;
  /** candidats en base que Stripe ne reconduira pas à la date prévue */
  skipped: number;
};

type Row = ReminderSub & { user_id: string; email: string | null };
type Lookup = (subscriptionId: string) => Promise<RenewalFacts | null>;

/** Un passage : envoie les rappels dus. Ne lève que si la base ou la configuration manquent. */
export async function sendRenewalReminders(opts: { now?: Date; lookup?: Lookup } = {}): Promise<ReminderReport> {
  const now = fmt(opts.now ?? new Date());
  const origin = publicOrigin();
  if (!origin) throw new Error("AUTH_URL absente : impossible d'écrire le lien vers la page Compte");
  const rows = await authAll<Row>(
    `SELECT s.user_id, s.subscription_id, s.plan, s.status, s.period_start, s.period_end, s.cancel_at_period_end, u.email
       FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.subscription_id IS NOT NULL AND s.period_end IS NOT NULL`,
  );
  const report: ReminderReport = { sent: 0, failed: 0, pending: 0, skipped: 0 };
  for (const row of rows) {
    try {
      await remindOne(row, now, `${origin}/compte`, opts.lookup ?? stripeRenewalFacts, report);
    } catch (e) {
      // Un abonnement en panne ne prive pas les autres de leur rappel.
      report.failed++;
      log("error", "renewal_reminder.failed", { subscription: row.subscription_id, user: row.user_id, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return report;
}

async function remindOne(row: Row, now: string, accountUrl: string, lookup: Lookup, report: ReminderReport): Promise<void> {
  const subscription = row.subscription_id!;
  const verdict = reminderVerdict(row, now);
  if (verdict === "too-late") return flagMissed(row, now);
  if (verdict !== "due") return;
  if (closed(await readMarker(markerKey(subscription, row.period_end!)))) return;

  const context: Record<string, unknown> = { subscription, user: row.user_id, periodEnd: row.period_end };
  const retryTomorrow = (reason: string, level: "warn" | "error" = "warn") => {
    report.failed++;
    log(level, "renewal_reminder.not_sent", { ...context, reason, message: `Rappel de reconduction non envoyé (${reason}) : nouvelle tentative demain.` });
  };

  let facts: RenewalFacts | null;
  try {
    facts = await lookup(subscription);
  } catch (e) {
    // Un droit manquant sur la clé ne se répare pas tout seul : c'est une erreur, pas une panne passagère.
    const denied = (e as { type?: string }).type === "StripePermissionError";
    return retryTomorrow(`${denied ? "Stripe refuse la lecture de l'abonnement" : "Stripe injoignable"} : ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`, denied ? "error" : "warn");
  }
  // La base désigne un candidat, Stripe dit ce qui arrivera : un événement perdu
  // (résiliation, changement d'échéance) ne doit pas faire annoncer une reconduction fausse.
  if (!facts || !facts.renews || !facts.yearly) {
    report.skipped++;
    log("info", "renewal_reminder.skipped", { ...context, reason: !facts ? "abonnement inconnu de Stripe" : !facts.renews ? "Stripe ne le reconduira pas (terminé ou résiliation programmée)" : "abonnement non annuel chez Stripe" });
    return;
  }
  const periodEnd = facts.periodEnd ?? row.period_end!;
  if (periodEnd !== row.period_end) {
    context.periodEnd = periodEnd;
    context.periodEndInDb = row.period_end;
    if (reminderVerdict({ ...row, period_end: periodEnd }, now) !== "due") {
      report.skipped++;
      log("warn", "renewal_reminder.skipped", { ...context, reason: "échéance différente chez Stripe : hors fenêtre d'envoi à cette date" });
      return;
    }
    if (closed(await readMarker(markerKey(subscription, periodEnd)))) return;
  }
  if (facts.amount === null || !facts.currency) return retryTomorrow("montant de l'abonnement illisible chez Stripe", "error");
  if (!row.email) return retryTomorrow("compte sans adresse e-mail", "error");

  const key = markerKey(subscription, periodEnd);
  const claimed = await claimOnce(key);
  if (claimed.state === "sent") return;
  if (claimed.state === "busy") { report.pending++; return; }
  const mail = renewalReminderEmail({
    renewsAt: periodEnd, amount: facts.amount, currency: facts.currency,
    accountUrl, contact: contactEmail(), termsUrl: legalLinks().terms,
  });
  const outcome = await sendEmail({ to: row.email, ...mail, idempotencyKey: `${key}:${claimed.chain}` });
  if (outcome.ok) {
    await settleClaim(key, claimed.token, `${SENT} ${new Date().toISOString()}`);
    report.sent++;
    log("info", "renewal_reminder.sent", { ...context, daysLeft: Math.floor((parse(periodEnd).getTime() - parse(now).getTime()) / DAY_MS) });
  } else if (outcome.uncertain) {
    report.pending++;
    log("warn", "renewal_reminder.not_sent", { ...context, reason: outcome.reason, message: `Rappel de reconduction : issue inconnue (${outcome.reason}). Reprise au prochain passage, sans doublon possible.` });
  } else {
    await releaseClaim(key, claimed.token);
    retryTomorrow(outcome.reason);
  }
}

/** Délai légal dépassé sans qu'aucun rappel soit parti : on le dit fort, une seule fois, et on n'envoie rien hors délai. */
async function flagMissed(row: Row, now: string): Promise<void> {
  if (now >= row.period_end!) return; // période échue : plus rien à annoncer
  const created = await authAll<{ key: string }>(
    `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
    markerKey(row.subscription_id!, row.period_end!), `${MISSED} ${new Date().toISOString()}`,
  );
  if (!created.length) return;
  log("error", "renewal_reminder.missed", {
    subscription: row.subscription_id, user: row.user_id, periodEnd: row.period_end,
    message: "Rappel de reconduction (art. L215-1) hors délai et jamais envoyé : après la reconduction, ce client peut résilier sans frais à tout moment et être remboursé de la période restante.",
  });
}

// ─────────────────────────── la tâche quotidienne ───────────────────────────

const DAY_KEY = "renewal_reminders:daily";
export const REMINDER_TICK_MS = 30 * 60_000;
/** Heure (UTC) à partir de laquelle le passage du jour a lieu : le matin à Paris, pas en pleine nuit. */
export const REMINDER_HOUR_UTC = 7;

/** Ce qui empêche d'envoyer les rappels avec la configuration courante, ou null. */
export function renewalRemindersBlocker(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY absente";
  if (!env.STRIPE_SECRET_KEY) return "STRIPE_SECRET_KEY absente";
  if (!publicOrigin(env)) return "AUTH_URL absente";
  return null;
}

/** Réclame le jour : vrai pour UNE seule instance (même UPSERT conditionnel que la sauvegarde quotidienne). */
async function claimDay(day: string): Promise<boolean> {
  const rows = await authAll<{ key: string }>(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_meta.value <> excluded.value
     RETURNING key`,
    DAY_KEY, day,
  );
  return rows.length === 1;
}
/** Rouvre le jour : le prochain tick refera un passage. */
async function reopenDay(day: string): Promise<void> {
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, `${day}:retry`, DAY_KEY, day);
}

export type ReminderTick = "skipped:billing-off" | "skipped:not-configured" | "skipped:too-early" | "skipped:done" | "ok" | "retry" | "failed";

export async function renewalReminderTick(opts: {
  now?: Date; env?: Partial<NodeJS.ProcessEnv>; run?: (now: Date) => Promise<ReminderReport>;
} = {}): Promise<ReminderTick> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  if (env.BILLING_ENABLED !== "1") return "skipped:billing-off";
  if (renewalRemindersBlocker(env)) return "skipped:not-configured";
  if (now.getUTCHours() < REMINDER_HOUR_UTC) return "skipped:too-early";
  const day = now.toISOString().slice(0, 10);
  if (!(await claimDay(day))) return "skipped:done";
  let report: ReminderReport;
  try {
    report = await (opts.run ?? ((at) => sendRenewalReminders({ now: at })))(now);
  } catch (e) {
    await reopenDay(day);
    log("error", "renewal_reminder.sweep_failed", { day, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return "failed";
  }
  log("info", "renewal_reminder.sweep", { day, ...report });
  if (report.pending === 0) return "ok";
  // Une issue inconnue se reprend le jour même : demain, la clé d'idempotence de Resend aurait expiré.
  await reopenDay(day);
  return "retry";
}

/** Démarre la tâche (une minuterie par process, hot-reload safe). null sans facturation ou si l'envoi est impossible. */
export function startRenewalReminderScheduler(): NodeJS.Timeout | null {
  if (process.env.BILLING_ENABLED !== "1") return null;
  const blocker = renewalRemindersBlocker();
  if (blocker) {
    log("error", "renewal_reminder.disabled", { reason: blocker, message: `Rappels de reconduction de l'abonnement annuel (art. L215-1) NON envoyés : ${blocker}.` });
    return null;
  }
  const g = globalThis as { __cortexRenewalTimer?: NodeJS.Timeout };
  if (g.__cortexRenewalTimer) clearInterval(g.__cortexRenewalTimer);
  const tick = () => renewalReminderTick().catch((e) => log("error", "renewal_reminder.sweep_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
  // Premier passage différé : laisser la base et les jobs démarrer.
  setTimeout(tick, 90_000).unref?.();
  g.__cortexRenewalTimer = setInterval(tick, REMINDER_TICK_MS);
  g.__cortexRenewalTimer.unref?.();
  console.log(`[renewal] rappels de reconduction de l'abonnement annuel actifs (passage quotidien à partir de ${REMINDER_HOUR_UTC} h UTC)`);
  return g.__cortexRenewalTimer;
}
