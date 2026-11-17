"use client";

import { useCallback, useEffect, useState } from "react";
import { watchPageRestore } from "@/lib/ux/bfcache";
import { ExternalLink, RotateCw, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import type { Standing } from "@/lib/billing/subscription-windows";
import { cn } from "@/lib/ux/cn";
import { useLocale, useTranslations } from "use-intl/react";
import { translator } from "@/lib/i18n/translate";
import { useFmt } from "@/lib/i18n/use-fmt";
import { fmt } from "@/lib/i18n/format";

/**
 * ABONNEMENT & CRÉDITS — un seul écran pour comprendre son solde et payer :
 * les deux poches (abonnement du mois, crédits achetés), la date de recharge,
 * les offres au prix lu dans Stripe, l'historique, et la porte vers le portail
 * Stripe. Les offres, consentements et mouvements restent visibles dans leurs cartes dédiées.
 * On n'encaisse pas sans CGV acceptées ni sans documents légaux publiés : le
 * serveur le refuse et l'interface le dit avant que l'utilisateur ne clique.
 */

type Offer = {
  plan: "pro_monthly" | "pro_yearly" | "credits_10";
  kind: "subscription" | "pack";
  label: string;
  credits: number;
  interval: "month" | "year" | null;
  price: { amount: number; currency: string } | null;
};
type Tx = { delta: number; subAmount: number; reason: string; ref: string | null; created_at: string };
type Billing = {
  billing: boolean;
  purchase: { enabled: boolean; reason: string | null };
  legal: { terms: string | null; privacy: string | null; refund: string | null; notice: string | null };
  /** Version anglaise des documents (vitrine), si elle est connue. */
  legalEnglish?: string | null;
  /** Adresse de contact (lib/contact). */
  contact?: string;
  terms: {
    version: string; accepted: boolean; acceptedAt: string | null;
    /** accord exprès à l'exécution immédiate + perte du droit de rétractation (L221-28 13°) */
    withdrawalAccepted: boolean; withdrawalAcceptedAt: string | null;
  };
  balance: number | null;
  purchased: number | null;
  subscription: {
    status: string; live: boolean; plan: string | null; creditsThisMonth: number; monthlyCredits: number;
    periodEnd: string | null; nextRechargeAt: string | null; manageable: boolean;
    /** État lu par le serveur : en règle, paiement en cours, impayé, suspendu, terminé. */
    standing: Standing;
    cancelsAtPeriodEnd: boolean;
  } | null;
  costs: {
    exam: number; qcm: number; exercise: number; assist: number;
    /** Préparation d'un cours, et relecture du format de ses annales (lancée à la demande, le dépôt est gratuit). */
    prepare?: number; format?: number;
  };
  /** Limites quotidiennes appliquées au compte (null : levée). */
  quotas?: { gen: number | null; assist: number | null };
  /** Espace de stockage du compte, en Mo (null : pas de plafond). */
  storageQuotaMb?: number | null;
  transactions: Tx[];
  offers: Offer[];
};

/** Montant en français : « 14,90 € », « 149 € » (pas de décimales inutiles), « 9 € ». */
export const money = (amount: number, currency: string) => fmt("fr").price(amount, currency);

/**
 * Ce qui borne l'usage, dit au-dessus des offres. « Autant de cours que tu
 * veux » parle du NOMBRE de cours, qui n'a pas de plafond : un cours coûte des
 * crédits (sa préparation, puis la relecture du format de ses annales), ses générations aussi,
 * et le compte a des limites par jour et un espace de stockage. Seules les
 * limites citées ici sont nommées : la phrase ne se donne pas pour une liste complète.
 */
/** Chargement : pur, sans état — testable et réutilisable par le bouton « actualiser ». */
async function fetchBilling(): Promise<Billing> {
  const res = await fetch("/api/billing");
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return (await res.json()) as Billing;
}

/** Retour de Stripe (?achat=ok|annule), lu côté client seulement. */
function retourFromLocation(): "ok" | "annule" | null {
  try {
    const v = new URLSearchParams(window.location.search).get("achat");
    return v === "ok" || v === "annule" ? v : null;
  } catch { return null; }
}

export function BillingPanel() {
  const t = useTranslations("account.billing");
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retour, setRetour] = useState<"ok" | "annule" | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await fetchBilling();
        if (!alive) return;
        setData(d);
        setRetour(retourFromLocation());
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await fetchBilling());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Retour depuis Stripe par « précédent » : la page est restaurée depuis le cache
  // avec son état, donc avec le verrou de redirection encore posé. On le lève et on
  // relit le solde, l'achat ayant pu aboutir (cf. lib/ux/bfcache).
  useEffect(() => watchPageRestore(() => {
    setBusy(null);
    setRetour(retourFromLocation());
    void load();
  }), [load]);

  const acceptTerms = async () => {
    if (!data) return;
    setBusy("terms");
    setActionError(null);
    try {
      const res = await fetch("/api/billing/terms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: data.terms.version }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Erreur ${res.status}`);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const go = async (path: string, body: unknown, key: string) => {
    if (busy) return; // un seul départ vers Stripe à la fois (pas de double session)
    setBusy(key);
    setActionError(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !d.url) throw new Error(d.error ?? `Erreur ${res.status}`);
      window.location.assign(d.url);
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Panel className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <WifiOff className="size-6 text-danger-hi" strokeWidth={2} aria-hidden="true" />
        <p className="text-[0.95rem] font-medium text-ink-1">{t("loadFailed")}</p>
        <p className="max-w-xs text-[0.85rem] leading-relaxed text-ink-3">{t("serverUnavailable")}</p>
        <Button variant="secondary" size="sm" onClick={load}><RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />{t("retry")}</Button>
      </Panel>
    );
  }
  if (!data) return <div className="skeleton h-40 rounded-lg" role="status" aria-busy="true" aria-label={t("loading")} />;
  return (
    <BillingView
      data={data}
      busy={busy}
      actionError={actionError}
      retour={retour}
      onRefresh={() => { void load(); }}
      onAcceptTerms={() => { void acceptTerms(); }}
      onCheckout={(plan) => { void go("/api/billing/checkout", { plan, consent: true }, plan); }}
      onPortal={() => { void go("/api/billing/portal", {}, "portal"); }}
    />
  );
}

export type BillingViewProps = {
  data: Billing;
  busy: string | null;
  actionError: string | null;
  retour: "ok" | "annule" | null;
  onRefresh: () => void;
  onAcceptTerms: () => void;
  onCheckout: (plan: Offer["plan"]) => void;
  onPortal: () => void;
};

/** Rendu PUR de l'écran à partir des données — testé état par état sans navigateur. */
export function BillingView({ data, busy, actionError, retour, onRefresh, onAcceptTerms, onCheckout, onPortal }: BillingViewProps) {
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const t = useTranslations("account.billing");
  const locale = useLocale();
  const frenchT = translator("fr");
  const f = useFmt();
  const credits = (n: number) => t("credits", { count: Math.abs(n), formatted: f.number(n) });
  const price = (p: Offer["price"], interval: Offer["interval"]) => p ? t(interval === "month" ? "monthlyPrice" : interval === "year" ? "yearlyPrice" : "price", { price: f.price(p.amount, p.currency) }) : t("priceUnavailable");
  const usageNote = () => {
    const { prepare, format } = data.costs;
    const cost = prepare != null && format != null ? t("usageCosts", { prepare, prepareFormatted: f.number(prepare), format, formatFormatted: f.number(format) }) : t("usageCostsUnknown");
    const gen = data.quotas?.gen;
    const assist = data.quotas?.assist;
    const daily = gen != null && assist != null ? t("dailyBoth", { gen, genFormatted: f.number(gen), assist, assistFormatted: f.number(assist) }) : gen != null ? t("dailyGen", { gen, genFormatted: f.number(gen) }) : assist != null ? t("dailyAssist", { assist, assistFormatted: f.number(assist) }) : null;
    return [cost, daily, data.storageQuotaMb == null ? null : t("storage", { value: f.number(data.storageQuotaMb) })].filter(Boolean).join(" ");
  };
  if (!data.billing) {
    return (
      <Panel className="p-5 sm:p-6">
        <h2 className="text-xl font-semibold text-ink-1">{t("title")}</h2>
        <p className="mt-1.5 text-[0.85rem] leading-relaxed text-ink-2">
          {t("disabled")}
        </p>
      </Panel>
    );
  }

  const sub = data.subscription;
  const standing: Standing = sub?.standing ?? "none";
  const subLive = standing === "live";
  // Tant que Stripe tient l'abonnement pour vivant (même impayé), on n'en propose pas un second.
  const hasSub = standing !== "none";
  const canceling = subLive && !!sub?.cancelsAtPeriodEnd;
  const canBuy = data.purchase.enabled && data.terms.accepted;
  const legalOk = !!(data.legal.terms && data.legal.refund);
  // La case suit la décision de l'API (purchase.enabled) : en production sans
  // documents publiés l'achat est fermé côté serveur ; hors production
  // (staging), on peut accepter et acheter en test même sans liens.
  const canAccept = data.purchase.enabled;

  return (
    <section id="credits" className="flex scroll-mt-24 flex-col gap-4" aria-labelledby="billing-title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="billing-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">
            {t("costSummary", { exam: data.costs.exam, examFormatted: f.number(data.costs.exam), qcm: data.costs.qcm, qcmFormatted: f.number(data.costs.qcm), assist: f.number(data.costs.assist) })}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} aria-label={t("refresh")}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </Button>
      </div>

      {retour === "ok" && (
        <p role="status" className="rounded-lg border border-[color-mix(in_oklch,var(--color-success)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-success)_8%,transparent)] px-4 py-3 text-[0.85rem] text-ink-1">
          {t("paymentConfirmed")}
        </p>
      )}
      {retour === "annule" && (
        <p role="status" className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-[0.85rem] text-ink-2">
          {t("paymentCanceled")}
        </p>
      )}

      {/* ── Solde : deux poches ── */}
      <Panel className="overflow-hidden divide-y divide-line p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-6 py-6">
          <div>
            <div className="text-sm text-ink-3">{t("availableBalance")}</div>
            <div className="mt-2 font-display text-4xl font-semibold leading-none tracking-tight text-ink-1 sm:text-5xl">{credits(data.balance ?? 0)}</div>
          </div>
          {(data.balance ?? 0) < 0 && (
            <Badge tone="danger" emphasis>{t("negativeBalance")}</Badge>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[0.85rem] sm:grid-cols-2">
          <div>
            <dt className="flex items-center gap-2 text-ink-3">
              {t("subscription")}
              {standing === "live" && <Badge tone={canceling ? "warning" : "success"} size="xs">{t(canceling ? "cancelScheduled" : "active")}</Badge>}
              {standing === "renewing" && <Badge tone="neutral" size="xs">{t("paymentPending")}</Badge>}
              {standing === "unpaid" && <Badge tone="danger" size="xs">{t("paymentFailed")}</Badge>}
              {standing === "suspended" && <Badge tone="warning" size="xs">{t("suspended")}</Badge>}
            </dt>
            <dd className="mt-0.5 text-ink-1">
              {sub && subLive && (
                <>
                  {t.rich("monthlyCredits", { current: f.number(sub.creditsThisMonth), total: f.number(sub.monthlyCredits), num: (chunks) => <span className="font-medium">{chunks}</span> })}
                  {sub.nextRechargeAt && <span className="text-ink-3">{t("rechargesOn", { date: f.date(sub.nextRechargeAt) })}</span>}
                  {canceling && sub.periodEnd && <span className="text-ink-3">{t("endsOn", { date: f.date(sub.periodEnd) })}</span>}
                  {!canceling && !sub.nextRechargeAt && sub.periodEnd && <span className="text-ink-3">{t("until", { date: f.date(sub.periodEnd) })}</span>}
                  <div className="mt-2 text-xs leading-relaxed text-ink-3">{t("nonRollover")}</div>
                  {canceling && (
                    <div className="mt-1 text-xs leading-relaxed text-ink-3">
                      {t("afterPremium")}
                    </div>
                  )}
                </>
              )}
              {standing === "renewing" && (
                <span className="text-ink-2">
                  {t("renewingHint")}
                </span>
              )}
              {standing === "unpaid" && (
                <span className="text-ink-2">
                  {t("unpaidHint")}
                </span>
              )}
              {standing === "suspended" && (
                <span className="text-ink-2">{t("suspendedHint")}</span>
              )}
              {standing === "none" && <span className="text-ink-3">{t("noSubscription")}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{t("purchasedCredits")}</dt>
            <dd className="mt-0.5 text-ink-1">
              {t.rich("permanentCredits", { count: Math.abs(data.purchased ?? 0), formatted: f.number(data.purchased ?? 0), num: (chunks) => <span className="font-medium">{chunks}</span>, muted: (chunks) => <span className="text-ink-3">{chunks}</span> })}
            </dd>
          </div>
        </dl>
        {sub?.manageable && (
          <div className="px-5 py-3">
            <Button variant="subtle" size="sm" onClick={onPortal} loading={busy === "portal"}>
              {t("manageSubscription")} <ExternalLink className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            </Button>
            <span className="ml-3 text-[0.78rem] text-ink-4">{t("manageHint")}</span>
          </div>
        )}
      </Panel>

      {/* ── Offres ── */}
      <Panel className="p-0">
        <div className="px-5 pt-4">
          <h3 className="text-xl font-semibold text-ink-1">{t("topUp")}</h3>
          <p className="mt-1 max-w-3xl text-[0.8rem] leading-relaxed text-ink-3">{usageNote()}</p>
          {!data.purchase.enabled && (
            <p role="status" className="mt-1.5 text-[0.85rem] text-warning">{data.purchase.reason}</p>
          )}
        </div>
        <ul className="grid gap-3 p-4 lg:grid-cols-3">
          {data.offers.map((o) => {
            const isSub = o.kind === "subscription";
            // `busy` couvre TOUTES les offres : pendant une redirection vers Stripe,
            // aucune autre ne doit pouvoir ouvrir une seconde session de paiement.
            const disabled = !canBuy || !consents[o.plan] || !!busy || (isSub && hasSub);
            return (
              <li key={o.plan} className="flex min-w-0 flex-col gap-5 rounded-2xl border border-line bg-surface-2/40 p-5">
                <div className="min-w-0">
                  <div className="font-display text-xl font-semibold text-ink-1">{o.label}</div>
                  <div className="mt-2 text-sm leading-relaxed text-ink-2">
                    {isSub ? t("subscriptionOffer", { count: o.credits, formatted: f.number(o.credits) }) : t("packOffer", { count: o.credits, formatted: f.number(o.credits) })}
                    {isSub && hasSub && <span>{t("alreadySubscribed")}</span>}
                  </div>
                  {/* Conditions de reconduction, à côté du bouton et AVANT tout achat :
                      elles ne vivaient que dans le bloc « Gérer mon abonnement », invisible
                      pour un compte neuf (audit de pré-lancement). */}
                  {isSub && (
                    <div className="mt-2 text-xs leading-relaxed text-ink-3">
                      {t(o.interval === "year" ? "yearlyRenewal" : "monthlyRenewal")}
                    </div>
                  )}
                  <label className="mt-4 flex max-w-xl items-start gap-3 rounded-xl bg-bg/40 p-3 text-xs leading-relaxed text-ink-2">
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" checked={!!consents[o.plan]}
                      disabled={!data.purchase.enabled || !!busy || (isSub && hasSub)}
                      onChange={(e) => setConsents((current) => ({ ...current, [o.plan]: e.target.checked }))} />
                    <span>
                      {t(isSub ? "subscriptionConsent" : "packConsent")}
                      {/* Consentement juridique (L221-28 13°) : hors français, la version qui fait foi est montrée aussi. */}
                      {locale !== "fr" && (
                        <span className="mt-1 block text-ink-3">
                          {t("consentBinding")} <q lang="fr">{frenchT(isSub ? "account.billing.subscriptionConsent" : "account.billing.packConsent")}</q>
                        </span>
                      )}
                    </span>
                  </label>
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <span className={cn("text-lg font-semibold tabular-nums", o.price ? "text-ink-1" : "text-ink-4")}>{price(o.price, o.interval)}</span>
                  <Button
                    variant={isSub ? "primary" : "secondary"}
                    size="sm"
                    disabled={disabled || !o.price}
                    loading={busy === o.plan}
                    onClick={() => onCheckout(o.plan)}
                  >
                    {t(isSub ? "subscribe" : "buy")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-5 py-4 text-[0.82rem]">
          {data.terms.accepted ? (
            <p className="text-ink-3">
              {t("termsAccepted", { date: f.date(data.terms.acceptedAt ?? ""), version: data.terms.version })}
              {data.legal.terms && <> <a className="underline underline-offset-2 hover:text-ink-1" href={data.legal.terms} target="_blank" rel="noreferrer">{t("rereadTerms")}</a>.</>}
              {data.legal.refund && <> <a className="underline underline-offset-2 hover:text-ink-1" href={data.legal.refund} target="_blank" rel="noreferrer">{t("refundPolicy")}</a>.</>}
            </p>
          ) : (
            <TermsConsent data={data} busy={busy} canAccept={canAccept} legalOk={legalOk} onAcceptTerms={onAcceptTerms} />
          )}
          {actionError && <p role="alert" className="mt-2 text-danger-hi">{actionError}</p>}
        </div>
      </Panel>

      {/* ── Historique ── */}
      <Panel className="p-0">
        <h3 className="px-5 pt-5 text-xl font-semibold text-ink-1">{t("history")}</h3>
        {data.transactions.length === 0 ? (
          <p className="px-5 pb-4 pt-1.5 text-[0.85rem] text-ink-3">{t("historyEmpty")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-b-[18px]" role="region" aria-label={t("historyLabel")} tabIndex={0}>
            <table className="w-full text-[0.82rem]">
              <thead className="bg-surface-2/50 text-left text-ink-3">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">{t("date")}</th>
                  <th scope="col" className="px-2 py-3 font-medium">{t("movement")}</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">{t("purchased")}</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">{t("subscription")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.transactions.map((t, i) => (
                  <tr key={t.ref ?? i} className="text-ink-2">
                    <td className="whitespace-nowrap px-5 py-3 tabular-nums text-ink-3">{f.date(t.created_at)}</td>
                    <td className="px-2 py-3">{t.reason}</td>
                    <td className={cn("px-2 py-3 text-right tabular-nums", t.delta > 0 ? "text-emerald-hi" : t.delta < 0 ? "text-ink-1" : "text-ink-4")}>
                      {t.delta === 0 ? "—" : `${t.delta > 0 ? "+" : ""}${f.number(t.delta)}`}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-3">{t.subAmount > 0 ? `−${f.number(t.subAmount)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <LegalLine legal={data.legal} english={data.legalEnglish} contact={data.contact} />
    </section>
  );
}

/**
 * CONSENTEMENTS AVANT LE PREMIER PAIEMENT — deux cases, une confirmation :
 *  1. CGV + politique de remboursement (version courante) ;
 *  2. demande d'accès immédiat au service et reconnaissance de la perte du droit
 *     de rétractation dès l'utilisation des crédits (art. L221-28 13° C. conso) —
 *     sans elle, le droit de 14 jours ne s'éteint pas et le paiement est refusé.
 * Un compte ayant accepté les CGV avant l'arrivée de la seconde case ne voit
 * que celle-ci. Rien n'est envoyé tant que les cases requises ne sont pas cochées.
 */
function TermsConsent({ data, busy, canAccept, legalOk, onAcceptTerms }: {
  data: Billing; busy: string | null; canAccept: boolean; legalOk: boolean; onAcceptTerms: () => void;
}) {
  const [terms, setTerms] = useState(data.terms.accepted);
  const t = useTranslations("account.billing");
  const f = useFmt();
  const ready = terms;
  const link = (href: string | null, label: string) =>
    href ? <a className="underline underline-offset-2 hover:text-ink-1" href={href} target="_blank" rel="noreferrer">{label}</a> : label;
  return (
    <div className="flex flex-col gap-3 text-ink-2">
      {data.terms.accepted ? (
        <p className="text-ink-3">
          {t("termsAcceptedExtra", { date: f.date(data.terms.acceptedAt ?? ""), version: data.terms.version })}
        </p>
      ) : (
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
            disabled={busy === "terms" || !canAccept}
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            aria-describedby="terms-help"
          />
          <span id="terms-help">
            {t.rich("acceptTerms", { terms: () => link(data.legal.terms, t("termsLink")), refund: () => link(data.legal.refund, t("refundLink")), version: data.terms.version })}
          </span>
        </label>
      )}
      <p className="text-ink-4">
        {t("purchaseConsents")}
        {!legalOk && (canAccept
          ? t("legalTest")
          : t("legalMissing"))}
      </p>
      <div>
        <Button size="sm" variant="primary" aria-label={t("confirmConsents")} disabled={!ready || !canAccept} loading={busy === "terms"} onClick={onAcceptTerms}>
          {t("confirm")}
        </Button>
      </div>
    </div>
  );
}

export function LegalLine({ legal, english, contact, className }: { legal: Billing["legal"]; english?: string | null; contact?: string; className?: string }) {
  const t = useTranslations("account.billing");
  const items: Array<[string, string | null]> = [
    [t("terms"), legal.terms],
    [t("privacy"), legal.privacy],
    [t("refunds"), legal.refund],
    [t("legalNotice"), legal.notice],
  ];
  const present = items.filter(([, href]) => href);
  if (!present.length && !contact) return null;
  return (
    <p className={cn("flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-ink-4", className)}>
      {present.map(([label, href]) => (
        <a key={label} href={href!} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink-2 hover:underline">{label}</a>
      ))}
      {present.length > 0 && english && (
        <a href={english} hrefLang="en" lang="en" target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink-2 hover:underline">{t("englishVersion")}</a>
      )}
      {contact && <a href={`mailto:${contact}`} className="underline-offset-2 hover:text-ink-2 hover:underline">{t("contact")}</a>}
    </p>
  );
}
