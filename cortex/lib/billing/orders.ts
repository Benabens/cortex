import type Stripe from "stripe";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";
import type { PlanKey } from "./stripe-events";

/**
 * COMMANDE CORTEX, lue sur la FACTURE STRIPE du paiement : c'est elle que le reçu
 * (./receipt-email) et la facture PDF (./invoice-pdf) mettent en forme. Un seul
 * document comptable par vente : la facture PDF de Cortex reprend le NUMÉRO de la
 * facture Stripe (séquence unique du compte, au niveau du compte), elle n'en crée
 * pas une seconde. Un pack a sa facture grâce à `invoice_creation` (checkout-params),
 * un abonnement par nature.
 *
 * Une réduction s'affiche par son NOM (coupon.name, que Ben pose dans Stripe), sinon
 * par le code promo saisi ; à défaut, null (« Réduction » à l'affichage). Jamais par
 * l'id du coupon ou de la remise, illisible pour l'acheteur.
 */

export type OrderKind = "pack" | "subscription";

export type Order = {
  /** Numéro de la facture Stripe (null tant qu'elle n'est pas finalisée). */
  number: string | null;
  kind: OrderKind;
  plan: PlanKey;
  currency: string;
  /** Avant réduction, puis réductions, puis payé — en unités mineures (centimes). */
  subtotal: number;
  discounts: Array<{ name: string | null; amount: number }>;
  total: number;
  amountPaid: number;
  /** Secondes Unix : paiement, et émission (finalisation) de la facture. */
  paidAt: number;
  issuedAt: number;
  /** Période facturée d'un abonnement (secondes Unix). */
  period: { start: number; end: number } | null;
  customer: { name: string | null; email: string | null; address: string[] };
};

/** Champs d'une facture que la commande lit (le format épinglé, plus l'ancien `discount.coupon`). */
type InvoiceLike = Pick<Stripe.Invoice, "number" | "currency" | "subtotal" | "total" | "amount_paid" | "created" | "customer_name" | "customer_email" | "customer_address"> & {
  status_transitions?: { paid_at?: number | null; finalized_at?: number | null } | null;
  lines?: { data?: Array<{ period?: { start: number; end: number } | null }> } | null;
  total_discount_amounts?: Array<{ amount: number; discount: unknown }> | null;
};

/** Expansions à demander à Stripe pour lire le nom des réductions (4 niveaux au plus). */
export const ORDER_INVOICE_EXPAND = [
  "total_discount_amounts.discount.source.coupon",
  "total_discount_amounts.discount.promotion_code",
];

const DAY_S = 86_400;

/** Nom lisible d'une remise Stripe déployée, sinon null. */
export function discountName(discount: unknown): string | null {
  if (!discount || typeof discount !== "object") return null;
  const d = discount as { source?: { coupon?: unknown } | null; coupon?: unknown; promotion_code?: unknown };
  const coupon = (d.source?.coupon ?? d.coupon) as { name?: string | null } | string | null | undefined;
  const name = typeof coupon === "object" && coupon ? coupon.name?.trim() : "";
  if (name) return name;
  const promo = d.promotion_code as { code?: string | null } | string | null | undefined;
  const code = typeof promo === "object" && promo ? promo.code?.trim() : "";
  return code || null;
}

export function orderFromInvoice(inv: InvoiceLike, o: { kind: OrderKind; plan?: PlanKey | null }): Order {
  const lines = inv.lines?.data ?? [];
  const period = o.kind === "subscription" ? lines.find((l) => l.period && l.period.end > l.period.start)?.period ?? null : null;
  // Le plan connu du webhook prime ; sinon : un pack est le pack, un abonnement de plus de deux mois l'annuel.
  const plan: PlanKey = o.plan ?? (o.kind === "pack" ? "credits_10" : period && period.end - period.start > 60 * DAY_S ? "pro_yearly" : "pro_monthly");
  const a = inv.customer_address;
  const cityLine = [a?.postal_code, a?.city].filter(Boolean).join(" ");
  return {
    number: inv.number ?? null,
    kind: o.kind,
    plan,
    currency: inv.currency,
    subtotal: inv.subtotal,
    discounts: (inv.total_discount_amounts ?? []).filter((d) => d.amount > 0).map((d) => ({ name: discountName(d.discount), amount: d.amount })),
    total: inv.total,
    amountPaid: inv.amount_paid,
    paidAt: inv.status_transitions?.paid_at ?? inv.created,
    issuedAt: inv.status_transitions?.finalized_at ?? inv.created,
    period: period ? { start: period.start, end: period.end } : null,
    customer: {
      name: inv.customer_name ?? null,
      email: inv.customer_email ?? null,
      address: [a?.line1, a?.line2, cityLine, a?.state, a?.country].filter((x): x is string => !!x && !!x.trim()),
    },
  };
}

/** Nom du produit acheté, tel que l'impriment le reçu et la facture. */
export function productName(plan: PlanKey, locale: Locale): string {
  return translator(locale)(`order.product.${plan}`);
}

/** « Réduction « Bienvenue -30 % » », ou « Réduction » quand la remise n'a pas de nom. */
export function discountLabel(name: string | null, locale: Locale): string {
  const t = translator(locale);
  return name ? t("order.discountNamed", { name }) : t("order.discount");
}
