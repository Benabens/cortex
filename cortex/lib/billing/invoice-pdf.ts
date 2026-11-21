import { fmt } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import type { Order } from "./orders";
import { orderMoney, productName } from "./receipt-email";
import { PdfPage, A4, textWidth, type Rgb } from "./pdf-doc";

/**
 * FACTURE PDF DE CORTEX, téléchargée depuis Mon compte (route /api/billing/invoices/…).
 * Même vente, même numéro que la facture Stripe (./orders) : c'est sa mise en forme
 * à la marque Cortex, pas un second document. Les mentions du VENDEUR ne figurent
 * qu'ici, jamais dans l'e-mail de reçu (décision de Ben, 21/11/2026).
 *
 * Mentions d'une facture d'un entrepreneur individuel en franchise de TVA, vente à
 * un particulier (service-public.fr F31808, art. 242 nonies A ann. II CGI, L441-9 C. com.,
 * R526-26 C. com. pour « EI ») : numéro unique et chronologique (celui de Stripe, séquence
 * du compte), date d'émission, date de la vente, nom de l'entrepreneur suivi de « EI »,
 * adresse, SIREN/SIRET, immatriculation si elle existe, client (nom, adresse s'il l'a
 * donnée), désignation, quantité, prix unitaire et total HT, réduction, et « TVA non
 * applicable, art. 293 B du CGI ». Les pénalités de retard et l'indemnité de 40 € ne
 * visent que les clients professionnels : absentes (vente B2C, payée d'avance).
 *
 * Vendeur lu dans l'environnement (INVOICE_SELLER_*) : sans nom avec la mention EI,
 * adresse ou SIRET valides, aucune facture n'est émise (refus, pas un document incomplet).
 */

export type InvoiceSeller = { name: string; address: string[]; siret: string; registration: string | null; vatNote: string };

export const VAT_NOTE = "TVA non applicable, art. 293 B du CGI";

export function invoiceSeller(env: Partial<NodeJS.ProcessEnv> = process.env): { ok: true; seller: InvoiceSeller } | { ok: false; missing: string } {
  const name = env.INVOICE_SELLER_NAME?.trim() ?? "";
  const address = (env.INVOICE_SELLER_ADDRESS ?? "").split(/\||\n/).map((l) => l.trim()).filter(Boolean);
  const siret = env.INVOICE_SELLER_SIRET?.trim() ?? "";
  if (!name) return { ok: false, missing: "INVOICE_SELLER_NAME" };
  if (!/(^|[\s(])EI($|[\s)])|entrepreneur individuel/i.test(name)) return { ok: false, missing: "INVOICE_SELLER_NAME (mention « EI » ou « entrepreneur individuel »)" };
  if (!address.length) return { ok: false, missing: "INVOICE_SELLER_ADDRESS" };
  const digits = siret.replace(/\s/g, "");
  if (!/^(\d{9}|\d{14})$/.test(digits)) return { ok: false, missing: "INVOICE_SELLER_SIRET (9 ou 14 chiffres)" };
  return {
    ok: true,
    seller: { name, address, siret, registration: env.INVOICE_SELLER_REGISTRATION?.trim() || null, vatNote: env.INVOICE_VAT_NOTE?.trim() || VAT_NOTE },
  };
}

const L = {
  fr: {
    title: "Facture", number: "N°", issued: "Date d'émission", sale: "Date de la vente", seller: "Vendeur", customer: "Client",
    item: "Désignation", qty: "Qté", unit: "Prix unitaire HT", amount: "Montant HT", subtotal: "Sous-total HT", discount: "Réduction",
    total: "Total HT", paid: "Net payé", paidOn: (d: string) => `Payée le ${d}.`, vat: (note: string) => note,
    period: (a: string, b: string) => `Période du ${a} au ${b}`, idLabel: (digits: string) => (digits.length === 9 ? "SIREN" : "SIRET"),
    sep: " : ", quote: (s: string) => `« ${s} »`,
  },
  en: {
    title: "Invoice", number: "No.", issued: "Issue date", sale: "Date of sale", seller: "Seller", customer: "Customer",
    item: "Description", qty: "Qty", unit: "Unit price", amount: "Amount", subtotal: "Subtotal", discount: "Discount",
    total: "Total", paid: "Amount paid", paidOn: (d: string) => `Paid on ${d}.`, vat: (note: string) => `${note} (VAT not applicable)`,
    period: (a: string, b: string) => `Period ${a} to ${b}`, idLabel: (digits: string) => (digits.length === 9 ? "SIREN" : "SIRET"),
    sep: ": ", quote: (s: string) => `“${s}”`,
  },
} as const;

const INK: Rgb = [20, 21, 24];
const MUTED: Rgb = [88, 94, 108];
const RULE: Rgb = [222, 225, 231];
const ACCENT: Rgb = [39, 100, 236];
const M = 56; // marge
const RIGHT = A4.width - M;

/** Symbole « Dissolution v2 » (viewBox 256) : anneau ouvert en polygone, nœud bleu, deux points. */
function drawMark(page: PdfPage, x: number, y: number, size: number): void {
  const s = size / 256;
  const P = (px: number, py: number): [number, number] => [x + px * s, y + py * s];
  const ring: Array<[number, number]> = [];
  const arc = (r: number, from: number, to: number) => {
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (from + ((to - from) * i) / steps) * (Math.PI / 180);
      ring.push(P(128 + r * Math.cos(a), 128 + r * Math.sin(a)));
    }
  };
  // Extérieur : de (235.9, 158) au sommet (128, 16), sens horaire à l'écran ; intérieur : retour de (128, 58) à (191.2, 158).
  arc(112, (Math.atan2(30, 107.9) * 180) / Math.PI, 270);
  arc(70, 270, (Math.atan2(30, 63.2) * 180) / Math.PI);
  page.polygon(ring, INK);
  page.circle(...P(162.1, 43.6), 20 * s, ACCENT);
  page.circle(...P(198.7, 70.7), 14 * s, INK);
  page.circle(...P(215, 101.4), 9 * s, INK);
}

export function invoicePdf(o: Order, seller: InvoiceSeller, locale: Locale): Buffer {
  const t = L[locale];
  const f = fmt(locale);
  const money = (cents: number) => orderMoney(cents, o.currency, locale);
  const day = (unix: number) => f.date(unix * 1000);
  const page = new PdfPage();

  // En-tête : marque à gauche, titre et références à droite.
  drawMark(page, M, 52, 30);
  // Wordmark « cortex. » : le point final est bleu, comme le nœud (lockup v2).
  page.text(M + 38, 74, "cortex", { size: 20, font: "bold", color: INK });
  page.text(M + 38 + textWidth("cortex", 20, "bold"), 74, ".", { size: 20, font: "bold", color: ACCENT });
  page.text(RIGHT, 70, t.title, { size: 22, font: "bold", align: "right", color: INK });
  page.text(RIGHT, 90, `${t.number} ${o.number ?? "—"}`, { size: 10, align: "right", color: INK });
  page.text(RIGHT, 105, `${t.issued}${t.sep}${day(o.issuedAt)}`, { size: 9, align: "right", color: MUTED });
  page.text(RIGHT, 118, `${t.sale}${t.sep}${day(o.paidAt)}`, { size: 9, align: "right", color: MUTED });

  // Vendeur et client.
  const top = 160;
  const block = (x: number, label: string, lines: Array<[string, boolean?]>) => {
    page.text(x, top, label, { size: 8.5, font: "bold", color: MUTED });
    lines.forEach(([line, strong], i) => page.text(x, top + 17 + i * 13.5, line, { size: 10, font: strong ? "bold" : "regular", color: INK }));
  };
  const idDigits = seller.siret.replace(/\s/g, "");
  block(M, t.seller, [
    [seller.name, true], ...seller.address.map((l) => [l] as [string]),
    [`${t.idLabel(idDigits)} ${seller.siret}`], ...(seller.registration ? [[seller.registration] as [string]] : []),
  ]);
  const c = o.customer;
  block(A4.width / 2 + 20, t.customer, [
    [c.name ?? c.email ?? "—", true], ...(c.name && c.email ? [[c.email] as [string]] : []), ...c.address.map((l) => [l] as [string]),
  ]);

  // Lignes.
  let y = 300;
  const colQty = 360, colUnit = 455;
  page.text(M, y, t.item, { size: 8.5, font: "bold", color: MUTED });
  page.text(colQty, y, t.qty, { size: 8.5, font: "bold", color: MUTED, align: "right" });
  page.text(colUnit, y, t.unit, { size: 8.5, font: "bold", color: MUTED, align: "right" });
  page.text(RIGHT, y, t.amount, { size: 8.5, font: "bold", color: MUTED, align: "right" });
  page.line(M, y + 8, RIGHT, y + 8, RULE);
  y += 26;
  page.text(M, y, productName(o.plan, locale), { size: 10.5, font: "bold", color: INK });
  if (o.period) page.text(M, y + 14, t.period(day(o.period.start), day(o.period.end)), { size: 9, color: MUTED });
  page.text(colQty, y, "1", { size: 10.5, align: "right", color: INK });
  page.text(colUnit, y, money(o.subtotal), { size: 10.5, align: "right", color: INK });
  page.text(RIGHT, y, money(o.subtotal), { size: 10.5, align: "right", color: INK });
  y += o.period ? 30 : 18;
  page.line(M, y, RIGHT, y, RULE);

  // Totaux, alignés à droite.
  const labelX = colUnit;
  const row = (label: string, value: string, strong = false) => {
    y += strong ? 22 : 18;
    page.text(labelX, y, label, { size: strong ? 11 : 10, font: strong ? "bold" : "regular", color: strong ? INK : MUTED, align: "right" });
    page.text(RIGHT, y, value, { size: strong ? 11 : 10, font: strong ? "bold" : "regular", color: INK, align: "right" });
  };
  if (o.discounts.length) {
    row(t.subtotal, money(o.subtotal));
    for (const d of o.discounts) row(d.name ? `${t.discount} ${t.quote(d.name)}` : t.discount, `-${money(d.amount)}`);
  }
  row(t.total, money(o.total));
  row(t.paid, money(o.amountPaid), true);
  y += 26;
  page.text(M, y, t.paidOn(day(o.paidAt)), { size: 9.5, color: INK });
  page.text(M, y + 15, t.vat(seller.vatNote), { size: 9.5, color: INK });

  // Pied : identité légale, rappelée en petit.
  const foot = A4.height - 48;
  page.line(M, foot - 14, RIGHT, foot - 14, RULE);
  page.text(M, foot, [seller.name, `${t.idLabel(idDigits)} ${seller.siret}`, seller.vatNote].join("  ·  "), { size: 7.5, color: MUTED });
  page.text(RIGHT, foot, "Cortex", { size: 7.5, font: "bold", color: MUTED, align: "right" });

  return page.toPdf({ title: `${t.title} ${o.number ?? ""}`.trim(), author: "Cortex" });
}
