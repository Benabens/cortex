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
 * QUAND : à partir de 60 jours avant la fin de la période PAYÉE, tant qu'il
 * reste plus de 30 jours avant l'échéance ET que le jour d'envoi précède d'au
 * moins un mois calendaire la date limite ANNONCÉE dans l'e-mail (la veille de
 * l'échéance). Trop tard, rien n'est envoyé (il serait hors délai) : une
 * erreur est journalisée, une seule fois.
 * D'OÙ : la table `subscriptions` (écrite par le webhook) désigne les candidats ;
 * au moment d'écrire, l'abonnement est RELU chez Stripe, qui fait foi pour ce
 * que l'e-mail annonce (reconduction encore prévue, date, montant de CET
 * abonnement). Stripe injoignable : pas d'e-mail, nouvelle tentative demain.
 *
 * UNE FOIS par abonnement et par période, même avec plusieurs instances :
 * marqueur réclamé dans `app_meta` (lib/claim-once), qui garde la date d'envoi.
 *  - refus net de Resend : rien n'est parti, le marqueur est rendu, nouvel essai
 *    au passage du lendemain ;
 *  - issue inconnue (pas de réponse de Resend, process tué en plein envoi) :
 *    la réclamation reste. Chaque tick (30 min) repasse alors sur CET abonnement
 *    seulement, et la reprend sous la MÊME clé d'idempotence Resend. Resend
 *    retient la clé 24 h : reprise le jour même, le doublon est écarté ; passé
 *    24 h, la reprise n'apporte plus rien et revient au passage quotidien.
 *
 * ÉCHECS : un rappel hors délai, un refus qui ne passera pas tout seul ou des
 * rappels désactivés sont écrits au propriétaire (./renewal-alerts), en plus du
 * journal.
 *
 * TÂCHE QUOTIDIENNE lancée par le serveur lui-même (instrumentation.ts), comme
 * la sauvegarde : le jour UTC est réclamé dans `app_meta`, une seule instance
 * fait le passage. Active seulement avec la facturation (BILLING_ENABLED=1).
 */
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { claimOnce, isSent, releaseClaim, SENT, settleClaim, STALE_CLAIM_MS } from "@/lib/claim-once";
import { contactEmail } from "@/lib/contact";
import { sendEmail } from "@/lib/email";
import { legalLinks } from "@/lib/legal";
import { log } from "@/lib/metrics";
import { publicOrigin } from "@/lib/public-url";
import { alertReminderProblems, alertRemindersDisabled, noteMissedReminder, warnIfReminderAlertsBlocked, type RefusedReminder } from "./renewal-alerts";
import { isYearly, stillBilling } from "./subscription-windows";

const DAY_MS = 86_400_000;
/** Envoi visé : 60 jours avant l'échéance (la loi autorise de 3 mois à 1 mois avant). */
export const REMIND_FROM_DAYS = 60;
/** En deçà, l'e-mail serait hors délai : il doit rester PLUS de 30 jours avant l'échéance. */
export const REMIND_UNTIL_DAYS = 30;

const parse = (s: string) => new Date(s.replace(" ", "T") + "Z");
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

// ─────────────────── les dates que lit le client (heure de Paris) ───────────────────

type Day = { y: number; m: number; d: number };
const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
/** Jour civil à Paris d'un instant UTC. */
function parisDay(at: Date): Day {
  const [y, m, d] = PARIS_DAY.format(at).split("-").map(Number);
  return { y, m, d };
}
/** Jour civil construit par arithmétique de calendrier (un jour 0 ou un mois 0 reculent d'un cran). */
function day(y: number, m: number, d: number): Day {
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
const rank = (x: Day) => x.y * 10_000 + x.m * 100 + x.d;

/**
 * Le jour de la reconduction, et la DATE LIMITE pour la refuser : la veille.
 * Résilier ce jour-là arrive toujours avant le prélèvement, quelle que soit
 * l'heure de la reconduction. C'est la date de l'encadré, et celle dont la
 * fenêtre d'envoi compte son mois.
 */
function renewalDays(periodEnd: string): { due: Day; last: Day } {
  const due = parisDay(parse(periodEnd));
  return { due, last: day(due.y, due.m, due.d - 1) };
}
/** Un mois calendaire avant un jour : même quantième du mois précédent, ramené à son dernier jour (30 mars → 28 février). */
function monthBefore(x: Day): Day {
  const lastOfPrevious = day(x.y, x.m, 0);
  return x.d < lastOfPrevious.d ? day(x.y, x.m - 1, x.d) : lastOfPrevious;
}

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
  // Deux bornes, tenues ensemble : plus de 30 jours avant l'échéance, et un envoi
  // au plus tard un mois calendaire (28 à 31 jours) avant la date limite annoncée.
  const inDays = now < fmt(new Date(end - REMIND_UNTIL_DAYS * DAY_MS));
  const inMonth = rank(parisDay(parse(now))) <= rank(monthBefore(renewalDays(sub.period_end).last));
  return inDays && inMonth ? "due" : "too-late";
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
  /** Une remise est posée sur l'abonnement : le prélèvement peut être inférieur au prix. */
  discounted: boolean;
};

/** Lecture d'un abonnement Stripe, format récent (période sur l'item) ou ancien (sur l'abonnement). */
export function renewalFactsOf(sub: Stripe.Subscription): RenewalFacts {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const end = item?.current_period_end ?? (sub as { current_period_end?: number }).current_period_end;
  const canceling = !!sub.cancel_at_period_end || (typeof sub.cancel_at === "number" && sub.cancel_at > 0);
  const price = item?.price;
  const discounts = (sub as { discounts?: unknown[] | null; discount?: unknown }).discounts;
  return {
    discounted: (Array.isArray(discounts) && discounts.length > 0) || !!(sub as { discount?: unknown }).discount,
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

const longDate = (x: Day, locale: string) =>
  new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(x.y, x.m - 1, x.d, 12)));
const money = (amount: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type ReminderMail = { subject: string; text: string; html: string };

/**
 * L'e-mail dédié de l'art. L215-1 : échéance, montant, reconduction tacite,
 * moyen de s'y opposer, et la DATE LIMITE dans un encadré apparent (la veille
 * de l'échéance, heure de Paris : `renewalDays`). En français (langue du contrat ; l'app ne connaît pas celle du client),
 * suivi d'un résumé en anglais.
 */
export function renewalReminderEmail(o: {
  /** Fin de la période payée : date de reconduction (« YYYY-MM-DD HH:MM:SS » UTC). */
  renewsAt: string; amount: number; currency: string;
  /** Une remise s'applique : le montant annoncé est un maximum, pas une promesse. */
  discounted?: boolean;
  /** Page Compte de l'app : c'est là qu'on ouvre le portail Stripe. */
  accountUrl: string; contact: string; termsUrl?: string | null;
}): ReminderMail {
  const { due, last } = renewalDays(o.renewsAt);
  const fr = { due: longDate(due, "fr-FR"), last: longDate(last, "fr-FR"), price: money(o.amount, o.currency, "fr-FR") };
  const en = { due: longDate(due, "en-GB"), last: longDate(last, "en-GB"), price: money(o.amount, o.currency, "en-GB") };
  const cgv = o.termsUrl ? ` : ${o.termsUrl}` : "";

  const subject = `Cortex Pro : votre abonnement annuel se renouvelle le ${fr.due}`;
  const intro = `Votre abonnement annuel Cortex Pro arrive à échéance le ${fr.due}.`;
  const tacit = `Il s'agit d'un contrat à reconduction tacite : sans action de votre part, il sera renouvelé automatiquement ce jour-là pour une nouvelle année, et ${o.discounted
    ? `${fr.price} au plus seront prélevés sur votre moyen de paiement (une remise s'applique à votre abonnement : le montant exact figurera sur votre facture).`
    : `${fr.price} seront prélevés sur votre moyen de paiement.`}`;
  const boxLabel = "Date limite pour refuser la reconduction";
  const how = `Vous pouvez vous opposer à ce renouvellement, sans frais et sans avoir à vous justifier, jusqu'au ${fr.last} inclus :`;
  const step1 = "Ouvrez votre page Compte";
  const step2 = "Cliquez sur « Gérer mon abonnement » (portail sécurisé Stripe), puis annulez l'abonnement.";
  const effect = `La résiliation prend effet à la fin de la période déjà payée : vous gardez Cortex Pro et vos crédits mensuels jusqu'au ${fr.due}, et plus rien n'est prélevé ensuite.`;
  const byMail = `Vous pouvez aussi nous écrire à ${o.contact} : nous enregistrerons votre résiliation.`;
  const keep = "Si vous souhaitez continuer, vous n'avez rien à faire.";
  const why = `Pourquoi ce message ? L'article L215-1 du Code de la consommation nous demande de vous informer, au plus tôt trois mois et au plus tard un mois avant cette date limite, que vous pouvez ne pas reconduire un contrat conclu avec une clause de reconduction tacite. Les conditions de reconduction figurent à l'article 7 de nos conditions générales de vente`;
  const english = `In English: your annual Cortex Pro subscription renews automatically on ${en.due} for ${o.discounted ? `up to ${en.price} (a discount applies)` : en.price}. To opt out, cancel by ${en.last} from your Account page (“Gérer mon abonnement”, then cancel the subscription), or write to ${o.contact}. Cancelling takes effect at the end of the period you have already paid for.`;

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
  /** à refaire demain : refus de Resend, Stripe injoignable ou qui ne connaît pas l'abonnement, compte sans adresse, montant illisible */
  failed: number;
  /** issue inconnue ou envoi en cours ailleurs : repris au tick suivant, le jour même */
  pending: number;
  /** candidats en base que Stripe ne reconduira pas à la date prévue */
  skipped: number;
};

type Row = ReminderSub & { user_id: string; email: string | null };
type Lookup = (subscriptionId: string) => Promise<RenewalFacts | null>;

/**
 * Un passage : envoie les rappels dus. `only` le restreint à quelques
 * abonnements (reprise d'un envoi interrompu, sans rejouer les autres). Ne lève
 * que si la base ou la configuration manquent.
 */
export async function sendRenewalReminders(opts: { now?: Date; lookup?: Lookup; only?: ReadonlySet<string> } = {}): Promise<ReminderReport> {
  const date = opts.now ?? new Date();
  const now = fmt(date);
  const origin = publicOrigin();
  if (!origin) throw new Error("AUTH_URL absente : impossible d'écrire le lien vers la page Compte");
  const rows = await authAll<Row>(
    `SELECT s.user_id, s.subscription_id, s.plan, s.status, s.period_start, s.period_end, s.cancel_at_period_end, u.email
       FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.subscription_id IS NOT NULL AND s.period_end IS NOT NULL`,
  );
  const report: ReminderReport = { sent: 0, failed: 0, pending: 0, skipped: 0 };
  const refused: RefusedReminder[] = [];
  for (const row of rows) {
    if (opts.only && !opts.only.has(row.subscription_id!)) continue;
    try {
      await remindOne(row, now, `${origin}/compte`, opts.lookup ?? stripeRenewalFacts, report, refused);
    } catch (e) {
      // Un abonnement en panne ne prive pas les autres de leur rappel.
      report.failed++;
      log("error", "renewal_reminder.failed", { subscription: row.subscription_id, user: row.user_id, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  // Refus persistants et rappels hors délai : le propriétaire en est prévenu par e-mail (./renewal-alerts).
  await alertReminderProblems(refused, date);
  return report;
}

async function remindOne(row: Row, now: string, accountUrl: string, lookup: Lookup, report: ReminderReport, refused: RefusedReminder[]): Promise<void> {
  const subscription = row.subscription_id!;
  const verdict = reminderVerdict(row, now);
  if (verdict !== "due" && verdict !== "too-late") return;
  if (now >= row.period_end!) return; // période payée échue : plus rien à annoncer
  if (closed(await readMarker(markerKey(subscription, row.period_end!)))) return;

  const context: Record<string, unknown> = { subscription, user: row.user_id, periodEnd: row.period_end };
  const retryTomorrow = (reason: string, level: "warn" | "error" = "warn") => {
    report.failed++;
    log(level, "renewal_reminder.not_sent", { ...context, reason, message: `Rappel de reconduction non envoyé (${reason}) : nouvelle tentative demain.` });
    if (level === "error") refused.push({ subscription, user: row.user_id, email: row.email, periodEnd: String(context.periodEnd), reason });
  };

  let facts: RenewalFacts | null;
  try {
    facts = await lookup(subscription);
  } catch (e) {
    // Un droit manquant sur la clé ne se répare pas tout seul : c'est une erreur, pas une panne passagère.
    const denied = (e as { type?: string }).type === "StripePermissionError";
    return retryTomorrow(`${denied ? "Stripe refuse la lecture de l'abonnement" : "Stripe injoignable"} : ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`, denied ? "error" : "warn");
  }
  // Vivant en base, inconnu de Stripe : la clé n'est pas celle du mode de cet abonnement, ou la base a dérivé.
  if (!facts) return retryTomorrow("abonnement inconnu de Stripe avec la clé en place", "error");
  // La base désigne un candidat, Stripe dit ce qui arrivera : un événement perdu
  // (résiliation, changement d'échéance) ne doit pas faire annoncer une reconduction fausse.
  if (!facts.renews || !facts.yearly) {
    report.skipped++;
    log("info", "renewal_reminder.skipped", { ...context, reason: facts.renews ? "abonnement non annuel chez Stripe" : "Stripe ne le reconduira pas (terminé ou résiliation programmée)" });
    return;
  }
  const periodEnd = facts.periodEnd ?? row.period_end!;
  let timing: ReminderVerdict = verdict;
  if (periodEnd !== row.period_end) {
    context.periodEnd = periodEnd;
    context.periodEndInDb = row.period_end;
    if (closed(await readMarker(markerKey(subscription, periodEnd)))) return;
    timing = reminderVerdict({ ...row, period_end: periodEnd }, now);
  }
  if (timing === "too-late") return flagMissed(subscription, row.user_id, periodEnd);
  if (timing !== "due") {
    report.skipped++;
    log("warn", "renewal_reminder.skipped", { ...context, reason: "échéance différente chez Stripe : pas encore dans la fenêtre d'envoi" });
    return;
  }
  if (facts.amount === null || !facts.currency) return retryTomorrow("montant de l'abonnement illisible chez Stripe", "error");
  if (!row.email) return retryTomorrow("compte sans adresse e-mail", "error");

  const key = markerKey(subscription, periodEnd);
  const claimed = await claimOnce(key);
  if (claimed.state === "sent") return;
  if (claimed.state === "busy") { report.pending++; return; }
  const mail = renewalReminderEmail({
    renewsAt: periodEnd, amount: facts.amount, currency: facts.currency, discounted: facts.discounted,
    accountUrl, contact: contactEmail(), termsUrl: legalLinks().terms,
  });
  const outcome = await sendEmail({ to: row.email, ...mail, idempotencyKey: `${key}:${claimed.chain}` });
  if (outcome.ok) {
    await settleClaim(key, claimed.token, `${SENT} ${new Date().toISOString()}`);
    report.sent++;
    log("info", "renewal_reminder.sent", { ...context, daysLeft: Math.floor((parse(periodEnd).getTime() - parse(now).getTime()) / DAY_MS) });
  } else if (outcome.uncertain) {
    report.pending++;
    log("warn", "renewal_reminder.not_sent", { ...context, reason: outcome.reason, message: `Rappel de reconduction : issue inconnue (${outcome.reason}). Reprise au prochain tick, sous la même clé d'idempotence.` });
  } else {
    await releaseClaim(key, claimed.token);
    // Un 4xx (clé, expéditeur, destinataire refusé) se répétera demain à l'identique : il faut le voir.
    // Sauf 429 : une limite de débit passe toute seule.
    const lasting = !!outcome.status && outcome.status < 500 && outcome.status !== 429;
    retryTomorrow(outcome.reason, lasting ? "error" : "warn");
  }
}

/**
 * Délai légal dépassé sans qu'aucun rappel soit CONFIRMÉ, pour un abonnement que
 * Stripe reconduira bien : on le dit fort, une seule fois, et on n'envoie rien
 * hors délai. Écriture puis relecture, comme une réclamation (lib/claim-once).
 * Une réclamation restée sans suite (Resend n'a jamais répondu) est close ici :
 * l'e-mail est peut-être parti, mais rien ne le prouve.
 */
async function flagMissed(subscription: string, user: string, periodEnd: string): Promise<void> {
  const key = markerKey(subscription, periodEnd);
  const mine = `${MISSED} ${new Date().toISOString()} ${randomUUID()}`;
  await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, mine);
  let held = await readMarker(key);
  let unconfirmed = false;
  if (held && held !== mine && !closed(held) && Date.now() - Date.parse(held.split(" ")[0]) > STALE_CLAIM_MS) {
    await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, mine, key, held);
    held = await readMarker(key);
    unconfirmed = true;
  }
  if (held !== mine) return;
  log("error", "renewal_reminder.missed", {
    subscription, user, periodEnd, unconfirmed,
    message: `Rappel de reconduction (art. L215-1) hors délai et ${unconfirmed ? "jamais confirmé (un essai est resté sans réponse de Resend)" : "jamais envoyé"} : après la reconduction, ce client peut résilier sans frais à tout moment et être remboursé de la période restante.`,
  });
  // Constaté une seule fois : noté pour que l'alerte parte même si Resend est en panne aujourd'hui.
  await noteMissedReminder(subscription, periodEnd, unconfirmed);
}

// ─────────────────────────── la tâche quotidienne ───────────────────────────

const DAY_KEY = "renewal_reminders:daily";
export const REMINDER_TICK_MS = 30 * 60_000;
/** Heure (UTC) à partir de laquelle le passage du jour a lieu : le matin à Paris, pas en pleine nuit. */
export const REMINDER_HOUR_UTC = 7;

/** Tout ce qui empêche d'envoyer les rappels avec la configuration courante. */
function renewalRemindersBlockers(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  return [
    !env.RESEND_API_KEY && "RESEND_API_KEY absente",
    // Sans expéditeur, lib/email retombe sur l'adresse d'essai de Resend, qui n'écrit pas aux clients.
    !env.AUTH_EMAIL_FROM?.trim() && "AUTH_EMAIL_FROM absente",
    !env.STRIPE_SECRET_KEY && "STRIPE_SECRET_KEY absente",
    !publicOrigin(env) && "AUTH_URL absente",
  ].filter((missing): missing is string => !!missing);
}

/** Ce qui empêche d'envoyer les rappels avec la configuration courante (la première cause), ou null. */
export function renewalRemindersBlocker(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  return renewalRemindersBlockers(env)[0] ?? null;
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
/** Rouvre le jour après une panne du passage : le prochain tick le refera. */
async function reopenDay(day: string): Promise<void> {
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, `${day}:retry`, DAY_KEY, day);
}
/**
 * Abonnements dont une réclamation attend sa reprise : jamais conclue (issue
 * inconnue chez Resend, process tué entre l'envoi et son marquage), et dont le
 * DERNIER essai a moins de 24 h. Le jeton commence par la date de cet essai,
 * réécrite à chaque reprise : tant que Resend reste muet, la reprise continue
 * donc toutes les 30 minutes. Une réclamation que plus personne ne reprend
 * (abonnement résilié depuis, donc plus candidat) cesse d'elle-même de
 * provoquer des passages au bout de 24 h : le temps que Resend garde la clé
 * d'idempotence, au-delà duquel le passage quotidien suffit.
 */
async function unsettledSubscriptions(now: Date): Promise<string[]> {
  const rows = await authAll<{ key: string }>(
    `SELECT key FROM app_meta WHERE key LIKE ? AND value NOT LIKE ? AND value NOT LIKE ? AND value > ?`,
    "renewal_reminder:%", `${SENT}%`, `${MISSED}%`, new Date(now.getTime() - DAY_MS).toISOString(),
  );
  return rows.map((r) => r.key.split(":")[1]).filter(Boolean);
}

export type ReminderTick = "skipped:billing-off" | "skipped:not-configured" | "skipped:too-early" | "skipped:done" | "ok" | "retry" | "failed";

export async function renewalReminderTick(opts: {
  now?: Date; env?: Partial<NodeJS.ProcessEnv>;
  /** Le passage ; `only` : la reprise ne porte que sur ces abonnements. */
  run?: (now: Date, only?: ReadonlySet<string>) => Promise<ReminderReport>;
} = {}): Promise<ReminderTick> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  if (env.BILLING_ENABLED !== "1") return "skipped:billing-off";
  if (renewalRemindersBlocker(env)) return "skipped:not-configured";
  if (now.getUTCHours() < REMINDER_HOUR_UTC) return "skipped:too-early";
  const day = now.toISOString().slice(0, 10);
  const fresh = await claimDay(day);
  let only: ReadonlySet<string> | undefined;
  if (!fresh) {
    // Le passage du jour est fait : on n'y revient que pour les envois restés sans
    // suite, et pour eux seuls. Un refus net, lui, attend bien demain.
    const pending = await unsettledSubscriptions(now);
    if (!pending.length) return "skipped:done";
    only = new Set(pending);
  }
  let report: ReminderReport;
  try {
    report = await (opts.run ?? ((at, subset) => sendRenewalReminders({ now: at, only: subset })))(now, only);
  } catch (e) {
    if (fresh) await reopenDay(day);
    log("error", "renewal_reminder.sweep_failed", { day, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return "failed";
  }
  log("info", "renewal_reminder.sweep", { day, ...report, ...(only ? { resumed: only.size } : {}) });
  return report.pending === 0 ? "ok" : "retry";
}

/**
 * Démarre la tâche (une minuterie par process, hot-reload safe). null sans
 * facturation ou si l'envoi est impossible : il ne tourne alors que l'alerte
 * au propriétaire.
 */
export function startRenewalReminderScheduler(): NodeJS.Timeout | null {
  const g = globalThis as { __cortexRenewalTimer?: NodeJS.Timeout };
  if (g.__cortexRenewalTimer) clearInterval(g.__cortexRenewalTimer);
  if (process.env.BILLING_ENABLED !== "1") return null;
  const mute = warnIfReminderAlertsBlocked();
  const blockers = renewalRemindersBlockers();
  if (blockers.length) {
    const reason = blockers.join(", ");
    log("error", "renewal_reminder.disabled", { reason, message: `Rappels de reconduction de l'abonnement annuel (art. L215-1) NON envoyés : ${reason}.` });
    // Rien à qui l'écrire : le journal vient de le dire, et la configuration ne changera pas avant un redémarrage.
    if (mute) return null;
    // Le propriétaire en est prévenu par e-mail, sans attendre (l'alerte ne retient pas le démarrage
    // et ne lève jamais), puis à chaque tick : un e-mail par jour tant que la variable manque, et un
    // nouvel essai si Resend était en panne au démarrage.
    const alert = () => void alertRemindersDisabled(reason);
    alert();
    g.__cortexRenewalTimer = setInterval(alert, REMINDER_TICK_MS);
    g.__cortexRenewalTimer.unref?.();
    return null;
  }
  const tick = () => renewalReminderTick().catch((e) => log("error", "renewal_reminder.sweep_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
  // Premier passage différé : laisser la base et les jobs démarrer.
  setTimeout(tick, 90_000).unref?.();
  g.__cortexRenewalTimer = setInterval(tick, REMINDER_TICK_MS);
  g.__cortexRenewalTimer.unref?.();
  console.log(`[renewal] rappels de reconduction de l'abonnement annuel actifs (passage quotidien à partir de ${REMINDER_HOUR_UTC} h UTC)`);
  return g.__cortexRenewalTimer;
}
