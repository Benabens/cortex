import { fmt } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import type { Order } from "./orders";
import type { PlanKey } from "./stripe-events";

/**
 * REÇU CORTEX envoyé après un paiement confirmé (./receipts), à la place de celui
 * de Stripe qui porte la marque du compte partagé. Sobre : ce qui a été acheté,
 * le montant payé, la date, le numéro de commande, la réduction éventuelle, puis
 * la facture PDF et la page Compte. AUCUNE mention du vendeur ici (nom, adresse,
 * SIREN) : elles sont sur la facture PDF seulement (décision de Ben, 21/11/2026).
 *
 * Rendu : tableaux et styles en ligne (messageries sans CSS), thème sombre de
 * l'app (refonte D2 : fond --color-bg, un seul accent bleu), texte brut en repli.
 */

export type ReceiptMail = { subject: string; text: string; html: string };

const PRODUCT: Record<Locale, Record<PlanKey, string>> = {
  fr: { credits_10: "Pack de 10 crédits", pro_monthly: "Cortex Pro mensuel", pro_yearly: "Cortex Pro annuel" },
  en: { credits_10: "10-credit pack", pro_monthly: "Cortex Pro monthly", pro_yearly: "Cortex Pro yearly" },
};

const COPY = {
  fr: {
    subject: { credits_10: "pack de 10 crédits", pro_monthly: "abonnement Pro mensuel", pro_yearly: "abonnement Pro annuel" } as Record<PlanKey, string>,
    subjectPrefix: "Votre reçu Cortex : ",
    title: "Paiement reçu",
    lead: (o: Order) => o.kind === "pack"
      ? "Merci pour votre achat : vos 10 crédits sont sur votre compte Cortex."
      : "Merci : le paiement de votre abonnement Cortex Pro est bien reçu.",
    product: "Produit", period: "Période", periodValue: (a: string, b: string) => `du ${a} au ${b}`, price: "Prix",
    discount: "Réduction", paid: "Montant payé", date: "Date", number: "N° de commande",
    invoice: "Télécharger la facture (PDF)", account: "Voir mon compte",
    accountHint: "Vos paiements et vos factures restent disponibles sur la page Compte.",
    help: (c: string) => `Une question sur ce paiement ? Écrivez-nous à ${c}.`,
    sign: "L'équipe Cortex",
    sep: " : ", quote: (s: string) => `« ${s} »`,
  },
  en: {
    subject: { credits_10: "10-credit pack", pro_monthly: "Pro monthly subscription", pro_yearly: "Pro yearly subscription" } as Record<PlanKey, string>,
    subjectPrefix: "Your Cortex receipt: ",
    title: "Payment received",
    lead: (o: Order) => o.kind === "pack"
      ? "Thank you for your purchase: your 10 credits are in your Cortex account."
      : "Thank you: we have received the payment for your Cortex Pro subscription.",
    product: "Product", period: "Period", periodValue: (a: string, b: string) => `${a} to ${b}`, price: "Price",
    discount: "Discount", paid: "Amount paid", date: "Date", number: "Order number",
    invoice: "Download the invoice (PDF)", account: "View my account",
    accountHint: "Your payments and invoices stay available on your Account page.",
    help: (c: string) => `A question about this payment? Write to us at ${c}.`,
    sign: "The Cortex team",
    sep: ": ", quote: (s: string) => `“${s}”`,
  },
} as const;

/** Montant toujours au centime sur un document de paiement : « 9,00 € », « €9.00 ». */
export function orderMoney(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(fmt(locale).tag, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function productName(plan: PlanKey, locale: Locale): string {
  return PRODUCT[locale][plan];
}

/** Lignes du détail de la commande, partagées par l'e-mail et la facture : [libellé, valeur, mise en avant]. */
export function orderRows(o: Order, locale: Locale): Array<[string, string, boolean?]> {
  const c = COPY[locale];
  const f = fmt(locale);
  const m = (cents: number) => orderMoney(cents, o.currency, locale);
  return [
    [c.product, productName(o.plan, locale)],
    ...(o.period ? [[c.period, c.periodValue(f.date(o.period.start * 1000), f.date(o.period.end * 1000))] as [string, string]] : []),
    ...(o.discounts.length ? [[c.price, m(o.subtotal)] as [string, string]] : []),
    ...o.discounts.map((d) => [d.name ? `${c.discount} ${c.quote(d.name)}` : c.discount, `−${m(d.amount)}`] as [string, string]),
    [c.paid, m(o.amountPaid), true],
    [c.date, f.date(o.paidAt * 1000)],
    [c.number, o.number ?? "—"],
  ];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Palette de l'e-mail : tokens sombres de l'app figés en hex (pas de CSS global dans une messagerie). */
const C = { bg: "#080c14", card: "#10151f", line: "#232b3a", ink: "#ececee", muted: "#a7adbb", accent: "#2764ec", link: "#9ebcff" } as const;

export function receiptEmail(o: Order, opts: { locale: Locale; accountUrl: string; invoiceUrl: string; contact: string }): ReceiptMail {
  const locale = opts.locale;
  const c = COPY[locale];
  const rows = orderRows(o, locale);
  const subject = `${c.subjectPrefix}${c.subject[o.plan]}`;

  const text = [
    c.title,
    c.lead(o),
    rows.map(([k, v]) => `${k}${c.sep}${v}`).join("\n"),
    `${c.invoice}${c.sep}${opts.invoiceUrl}`,
    `${c.account}${c.sep}${opts.accountUrl}`,
    c.help(opts.contact),
    c.sign,
  ].join("\n\n");

  const cell = "padding:10px 0;border-top:1px solid " + C.line;
  const table = rows.map(([k, v, strong]) =>
    `<tr><td style="${cell};padding-right:16px;white-space:nowrap;color:${C.muted};font-size:14px">${esc(k)}</td>`
    + `<td align="right" style="${cell};color:${C.ink};font-size:${strong ? "16px;font-weight:600" : "14px"};font-variant-numeric:tabular-nums">${esc(v)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:32px 12px;background:${C.bg};color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">`
    + `<tr><td style="padding:0 4px 20px;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${C.ink}">cortex<span style="color:${C.accent}">.</span></td></tr>`
    + `<tr><td style="padding:28px;background:${C.card};border:1px solid ${C.line};border-radius:12px">`
    + `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;font-weight:600;color:${C.ink}">${esc(c.title)}</h1>`
    + `<p style="margin:0 0 20px;color:${C.muted}">${esc(c.lead(o))}</p>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${table}</table>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr><td style="border-radius:8px;background:${C.accent}">`
    + `<a href="${esc(opts.invoiceUrl)}" style="display:inline-block;padding:11px 18px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${esc(c.invoice)}</a></td></tr></table>`
    + `<p style="margin:16px 0 0;font-size:14px;color:${C.muted}">${esc(c.accountHint)} <a href="${esc(opts.accountUrl)}" style="color:${C.link}">${esc(c.account)}</a></p>`
    + `</td></tr>`
    + `<tr><td style="padding:20px 4px 0;font-size:13px;color:${C.muted}">${esc(c.help(opts.contact)).replace(esc(opts.contact), `<a href="mailto:${esc(opts.contact)}" style="color:${C.link}">${esc(opts.contact)}</a>`)}<br>${esc(c.sign)}</td></tr>`
    + `</table></body></html>`;
  return { subject, text, html };
}
