/**
 * ALERTE AU PROPRIÉTAIRE QUAND LE RAPPEL DE RECONDUCTION ÉCHOUE
 * (lib/billing/renewal-reminders). Un rappel manqué donne à l'abonné le droit
 * de résilier sans frais après la reconduction : il faut que quelqu'un le voie,
 * et les logs Railway ne préviennent personne. Même mécanisme que les alertes
 * de dépense (./spend-alerts) : un e-mail Resend à l'adresse d'alerte, sous une
 * clé réclamée dans `app_meta`.
 *
 * TROIS ALERTES, chacune au plus UNE fois par jour (UTC), même avec plusieurs
 * instances ou plusieurs passages :
 *  - hors délai (`renewal_reminder.missed`) : le délai légal est passé sans
 *    e-mail confirmé ;
 *  - en échec (`renewal_reminder.not_sent` en erreur) : le rappel n'est pas
 *    parti et réessayer demain ne suffira pas ;
 *  - désactivés (`renewal_reminder.disabled`) : il manque une variable, aucun
 *    rappel ne part.
 * Plusieurs abonnés le même jour : un seul e-mail, qui les nomme tous.
 *
 * Un échec qui dure est constaté à chaque passage, donc signalé de nouveau le
 * lendemain. Un rappel hors délai, lui, n'est constaté qu'une fois : il est
 * noté dans `app_meta` jusqu'à ce que son e-mail soit parti (plus bas).
 *
 * LIMITE : l'alerte passe par Resend. Si c'est Resend qui refuse (clé révoquée,
 * domaine non vérifié), elle ne part pas non plus, et il ne reste que le
 * journal (`renewal_alert.not_sent`). Rien ici ne lève : une alerte en panne ne
 * doit jamais coûter un rappel.
 */
import { createHash } from "node:crypto";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { claimOnce, releaseClaim, settleClaim } from "@/lib/claim-once";
import { sendEmail } from "@/lib/email";
import { log } from "@/lib/metrics";
import { ownerAlertBlocker, ownerAlertRecipient } from "./spend-alerts";

/** Un rappel que l'app n'a pas pu envoyer, et que réessayer demain ne suffira pas à faire partir. */
export type RefusedReminder = {
  subscription: string; user: string; email: string | null;
  /** Fin de la période payée : date de reconduction (« YYYY-MM-DD HH:MM:SS » UTC). */
  periodEnd: string;
  reason: string;
};

const PARIS_DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
/** Le jour de la reconduction, tel que le lit l'abonné (heure de Paris). */
const renewalDay = (periodEnd: string) => PARIS_DATE.format(new Date(periodEnd.replace(" ", "T") + "Z"));
const subscribers = (n: number) => `${n} abonné${n > 1 ? "s" : ""}`;
const who = (p: { subscription: string; user: string | null; email: string | null }) => `${p.email ?? "adresse inconnue"} (compte ${p.user ?? "inconnu"}, abonnement ${p.subscription})`;

const DETAIL = "Détail : docs/STRIPE-LIVE.md, § 12.";

function refusedMail(refused: RefusedReminder[]): { subject: string; text: string } {
  return {
    subject: `Cortex : rappel de reconduction en échec (${subscribers(refused.length)})`,
    text: [
      `Le rappel de reconduction de l'abonnement annuel (art. L215-1 du Code de la consommation) n'a pas pu partir aujourd'hui pour ${subscribers(refused.length)}, et réessayer ne suffira pas : il faut corriger la cause.`,
      refused.map((p) => `- ${who(p)} : reconduction le ${renewalDay(p.periodEnd)}. Cause : ${p.reason.replace(/\.$/, "")}.`).join("\n"),
      "L'app réessaie chaque jour. Le rappel doit partir au plus tard un mois avant la veille de la reconduction : ensuite il est hors délai, et l'abonné peut résilier sans frais après la reconduction.",
      [
        "À faire, selon la cause :",
        "- « Stripe refuse la lecture de l'abonnement » : la clé STRIPE_SECRET_KEY n'a pas le droit de lire les abonnements (Stripe, Développeurs, Clés API).",
        "- « abonnement inconnu de Stripe » : la clé en place n'est pas celle du mode (test ou live) de cet abonnement.",
        "- « montant de l'abonnement illisible » : le prix de cet abonnement n'a pas de montant fixe chez Stripe.",
        "- « compte sans adresse e-mail » : renseigne l'adresse du compte, ou préviens l'abonné toi-même.",
        "- « Resend a répondu HTTP 4… » : clé RESEND_API_KEY, domaine de l'expéditeur (AUTH_EMAIL_FROM) ou adresse du destinataire refusés (resend.com, Emails et Domains).",
      ].join("\n"),
      DETAIL,
    ].join("\n\n"),
  };
}

// ─────────────────── rappel hors délai : constaté une fois, signalé à coup sûr ───────────────────

/**
 * Un rappel hors délai n'est constaté qu'UNE fois (renewal-reminders, flagMissed) :
 * si l'alerte ne part pas ce jour-là (Resend en panne, alerte du jour déjà partie),
 * rien ne la rejouerait. Le constat est donc noté dans `app_meta`, et la ligne
 * n'est retirée qu'une fois l'e-mail parti : chaque passage suivant réessaie.
 * Au pire un doublon, si Resend avait accepté un envoi resté sans réponse la
 * veille. Sans donnée personnelle : identifiant d'abonnement et échéance, comme
 * le marqueur du rappel ; l'adresse est relue en base au moment d'écrire.
 */
const PENDING = "renewal_alert_pending:";
const UNCONFIRMED = "unconfirmed";

type MissedReminder = { key: string; subscription: string; user: string | null; email: string | null; periodEnd: string; unconfirmed: boolean };

/** Note un rappel hors délai à signaler au propriétaire. `unconfirmed` : un essai est resté sans réponse de Resend. */
export async function noteMissedReminder(subscription: string, periodEnd: string, unconfirmed: boolean): Promise<void> {
  await contained(() => authRun(
    `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
    `${PENDING}${subscription}:${periodEnd.replace(" ", "T")}`, unconfirmed ? UNCONFIRMED : "unsent",
  ));
}

async function pendingMissed(): Promise<MissedReminder[]> {
  const rows = await authAll<{ key: string; value: string }>(`SELECT key, value FROM app_meta WHERE key LIKE ? ORDER BY key`, `${PENDING}%`);
  const missed: MissedReminder[] = [];
  for (const row of rows) {
    const [subscription, ...end] = row.key.slice(PENDING.length).split(":");
    const account = await authGet<{ user_id: string; email: string | null }>(
      `SELECT s.user_id, u.email FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id WHERE s.subscription_id = ?`, subscription,
    );
    missed.push({ key: row.key, subscription, user: account?.user_id ?? null, email: account?.email ?? null, periodEnd: end.join(":").replace("T", " "), unconfirmed: row.value === UNCONFIRMED });
  }
  return missed;
}

function missedMail(missed: MissedReminder[]): { subject: string; text: string } {
  return {
    subject: `Cortex : rappel de reconduction hors délai (${subscribers(missed.length)})`,
    text: [
      `Le rappel de reconduction de l'abonnement annuel (art. L215-1 du Code de la consommation) n'est pas parti à temps pour ${subscribers(missed.length)}. Le délai légal est dépassé : l'app n'enverra plus rien pour cette période.`,
      missed.map((m) => `- ${who(m)} : reconduction le ${renewalDay(m.periodEnd)}. ${m.unconfirmed ? "Un essai est resté sans réponse de Resend : l'e-mail est peut-être parti à temps." : "Aucun e-mail n'est parti."}`).join("\n"),
      "Conséquence : après la reconduction, l'abonné peut résilier sans frais à tout moment et se faire rembourser la période restante.",
      [
        "À faire :",
        "1. Essai resté sans réponse : cherche l'adresse de l'abonné dans le journal de Resend (resend.com, Emails). Si l'e-mail y figure, il est parti à temps et il n'y a rien d'autre à faire.",
        "2. Sinon, tu peux prévenir l'abonné toi-même : cela ne rattrape pas le délai légal, mais il sait que son abonnement se reconduit. S'il résilie après la reconduction, rembourse-lui la période restante.",
        "3. Cherche la cause dans les logs Railway : événements renewal_reminder.not_sent des jours précédents.",
      ].join("\n"),
      DETAIL,
    ].join("\n\n"),
  };
}

// ─────────────────────────── l'envoi ───────────────────────────

/**
 * L'alerte est un filet : aucune de ses pannes (base, ligne illisible) ne doit
 * remonter dans la tâche du rappel, qui a un e-mail légal à envoyer.
 */
async function contained(alert: () => Promise<void>): Promise<void> {
  try {
    await alert();
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
    log("warn", "renewal_alert.not_sent", { reason, message: `Alerte du rappel de reconduction en panne (${reason}).` });
  }
}

type Kind = "missed" | "not_sent" | "disabled";

/**
 * Envoie l'alerte de ce type pour ce jour (UTC), si elle n'est pas déjà partie :
 * la clé est RÉCLAMÉE dans `app_meta` (lib/claim-once), comme un seuil de
 * dépense. Rend vrai si l'e-mail est parti pendant cet appel.
 */
async function sendOnce(kind: Kind, day: string, mail: { subject: string; text: string }, count?: number): Promise<boolean> {
  const context = { kind, day, ...(count ? { subscribers: count } : {}) };
  const blocker = ownerAlertBlocker();
  if (blocker) {
    log("warn", "renewal_alert.not_sent", { ...context, reason: blocker, message: `Alerte du rappel de reconduction non envoyée (${blocker}).` });
    return false;
  }
  const key = `renewal_alert:${kind}:${day}`;
  const claimed = await claimOnce(key);
  // Déjà signalé aujourd'hui, ou une autre instance s'en occupe.
  if (claimed.state !== "won") return false;
  // Le contenu fait partie de la clé d'idempotence : la reprise d'un envoi resté sans réponse peut
  // nommer un abonné de plus. Sous la clé du premier essai, Resend répondrait « déjà envoyé » (409)
  // et cet abonné ne serait jamais signalé ; à contenu identique, la clé est la même et le doublon écarté.
  const content = createHash("sha256").update(mail.text).digest("hex").slice(0, 16);
  const outcome = await sendEmail({ to: ownerAlertRecipient(process.env)!, ...mail, idempotencyKey: `${key}:${claimed.chain}:${content}` });
  if (!outcome.ok) {
    // Refus net : la clé est rendue, le prochain passage réessaiera. Issue inconnue : la réclamation
    // reste, et sa reprise (un quart d'heure plus tard) repart de la même chaîne.
    if (!outcome.uncertain) await releaseClaim(key, claimed.token);
    log("warn", "renewal_alert.not_sent", { ...context, reason: outcome.reason, message: `Alerte du rappel de reconduction non envoyée (${outcome.reason}) : nouvel essai au prochain passage.` });
    return false;
  }
  await settleClaim(key, claimed.token);
  log("info", "renewal_alert.sent", context);
  return true;
}

/**
 * Fin d'un passage du rappel : signale au propriétaire les rappels hors délai
 * qui restent à signaler, et les refus persistants de ce passage.
 */
export async function alertReminderProblems(refused: RefusedReminder[], now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await contained(async () => {
    const missed = await pendingMissed();
    if (missed.length && (await sendOnce("missed", day, missedMail(missed), missed.length))) {
      for (const m of missed) await authRun(`DELETE FROM app_meta WHERE key = ?`, m.key);
    }
  });
  await contained(async () => {
    if (refused.length) await sendOnce("not_sent", day, refusedMail(refused), refused.length);
  });
}

/**
 * Démarrage du serveur : les rappels sont désactivés (il manque une variable).
 * Un e-mail par jour au plus, même si chaque redéploiement relance le serveur.
 */
export async function alertRemindersDisabled(reason: string, now: Date = new Date()): Promise<void> {
  await contained(async () => {
    await sendOnce("disabled", now.toISOString().slice(0, 10), {
      subject: "Cortex : rappels de reconduction désactivés",
      text: [
        `Les rappels de reconduction de l'abonnement annuel (art. L215-1 du Code de la consommation) sont désactivés : ${reason}. Tant que rien ne change, aucun rappel ne part, et un abonné annuel qui ne reçoit pas le sien à temps peut résilier sans frais après la reconduction.`,
        "À faire : Railway, service cortex-app, Variables : pose la variable qui manque, puis redéploie. Au démarrage, les logs doivent dire « [renewal] rappels de reconduction de l'abonnement annuel actifs ».",
        DETAIL,
      ].join("\n\n"),
    });
  });
}

/** Démarrage du serveur : si rien ne peut être écrit au propriétaire, le dire maintenant, pas le jour où un rappel échoue. */
export function warnIfReminderAlertsBlocked(): void {
  const reason = ownerAlertBlocker();
  if (reason) log("warn", "renewal_alert.disabled", { reason, message: `Les échecs du rappel de reconduction ne seront signalés par e-mail à personne (${reason}) : ils ne se liront que dans les logs.` });
}
