import { fmt } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";
import { discountLabel, productName, type Order } from "./orders";

/**
 * REÇU CORTEX envoyé après un paiement confirmé (./receipts), à la place de celui
 * de Stripe qui porte la marque du compte partagé. Sobre : ce qui a été acheté,
 * le montant payé, la date, le numéro de commande, la réduction éventuelle, puis
 * la facture PDF et la page Compte. AUCUNE mention du vendeur ici (nom, adresse,
 * SIREN) : elles sont sur la facture PDF seulement (décision de Ben, 21/11/2026).
 * Textes : messages/*.json (`receipt.*`, `order.*`), vouvoiement comme les autres
 * e-mails de Cortex (rappel de reconduction).
 *
 * Rendu : tableaux et styles en ligne (messageries sans CSS), thème sombre de
 * l'app (refonte D2 : fond --color-bg, un seul accent bleu), texte brut en repli.
 */

export type ReceiptMail = { subject: string; text: string; html: string };

/** Lignes du détail de la commande : [libellé, valeur, mise en avant]. */
function orderRows(o: Order, locale: Locale): Array<[string, string, boolean?]> {
  const t = translator(locale);
  const f = fmt(locale);
  const m = (cents: number) => f.money(cents, o.currency);
  return [
    [t("receipt.product"), productName(o.plan, locale)],
    ...(o.period ? [[t("receipt.period"), t("receipt.periodValue", { start: f.date(o.period.start * 1000), end: f.date(o.period.end * 1000) })] as [string, string]] : []),
    ...(o.discounts.length ? [[t("receipt.price"), m(o.subtotal)] as [string, string]] : []),
    ...o.discounts.map((d) => [discountLabel(d.name, locale), `−${m(d.amount)}`] as [string, string]),
    [t("receipt.paid"), m(o.amountPaid), true],
    [t("receipt.date"), f.date(o.paidAt * 1000)],
    [t("receipt.number"), o.number ?? "—"],
  ];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Palette de l'e-mail : tokens sombres de l'app figés en hex (pas de CSS global dans une messagerie). */
const PALETTE = { bg: "#080c14", card: "#10151f", line: "#232b3a", ink: "#ececee", muted: "#a7adbb", accent: "#2764ec", link: "#9ebcff" } as const;

/** `contact` : adresse de support configurée, ou null (la ligne « une question ? » disparaît). */
export function receiptEmail(o: Order, opts: { locale: Locale; accountUrl: string; invoiceUrl: string; contact: string | null }): ReceiptMail {
  const { locale, contact } = opts;
  const t = translator(locale);
  const C = PALETTE;
  const rows = orderRows(o, locale);
  const subject = t(`receipt.subject.${o.plan}`);
  const lead = t(o.kind === "pack" ? "receipt.leadPack" : "receipt.leadSubscription");
  const row = (label: string, value: string) => t("receipt.row", { label, value });

  const text = [
    t("receipt.title"),
    lead,
    rows.map(([k, v]) => row(k, v)).join("\n"),
    row(t("receipt.invoice"), opts.invoiceUrl),
    row(t("receipt.account"), opts.accountUrl),
    ...(contact ? [t("receipt.help", { email: contact })] : []),
    t("receipt.sign"),
  ].join("\n\n");

  const cell = "padding:10px 0;border-top:1px solid " + C.line;
  const table = rows.map(([k, v, strong]) =>
    `<tr><td style="${cell};padding-right:16px;color:${C.muted};font-size:14px">${esc(k)}</td>`
    // Valeurs courtes (montant, date, numéro, produit) sur une ligne ; la période peut se couper.
    + `<td align="right" style="${cell};${v.length <= 24 ? "white-space:nowrap;" : ""}color:${C.ink};font-size:${strong ? "16px;font-weight:600" : "14px"};font-variant-numeric:tabular-nums">${esc(v)}</td></tr>`).join("");
  const help = contact
    ? esc(t("receipt.help", { email: contact })).replace(esc(contact), `<a href="mailto:${esc(contact)}" style="color:${C.link}">${esc(contact)}</a>`) + "<br>"
    : "";
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:32px 12px;background:${C.bg};color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">`
    + `<tr><td style="padding:0 4px 20px;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${C.ink}">cortex<span style="color:${C.accent}">.</span></td></tr>`
    + `<tr><td style="padding:28px;background:${C.card};border:1px solid ${C.line};border-radius:12px">`
    + `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;font-weight:600;color:${C.ink}">${esc(t("receipt.title"))}</h1>`
    + `<p style="margin:0 0 20px;color:${C.muted}">${esc(lead)}</p>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${table}</table>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr><td style="border-radius:8px;background:${C.accent}">`
    + `<a href="${esc(opts.invoiceUrl)}" style="display:inline-block;padding:11px 18px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${esc(t("receipt.invoice"))}</a></td></tr></table>`
    + `<p style="margin:16px 0 0;font-size:14px;color:${C.muted}">${esc(t("receipt.accountHint"))} <a href="${esc(opts.accountUrl)}" style="color:${C.link}">${esc(t("receipt.account"))}</a></p>`
    + `</td></tr>`
    + `<tr><td style="padding:20px 4px 0;font-size:13px;color:${C.muted}">${help}${esc(t("receipt.sign"))}</td></tr>`
    + `</table></body></html>`;
  return { subject, text, html };
}
