"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RotateCw, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/ux/cn";

/**
 * ABONNEMENT & CRÉDITS — un seul écran pour comprendre son solde et payer :
 * les deux poches (abonnement du mois, crédits achetés), la date de recharge,
 * les offres au prix lu dans Stripe, l'historique, et la porte vers le portail
 * Stripe. Dense et sobre : composants existants, aucun style nouveau.
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
  terms: { version: string; accepted: boolean; acceptedAt: string | null };
  balance: number | null;
  purchased: number | null;
  subscription: {
    status: string; live: boolean; plan: string | null; creditsThisMonth: number; monthlyCredits: number;
    periodEnd: string | null; nextRechargeAt: string | null; manageable: boolean;
  } | null;
  costs: { exam: number; qcm: number; exercise: number; assist: number };
  transactions: Tx[];
  offers: Offer[];
};

const nf = new Intl.NumberFormat("fr-CH", { maximumFractionDigits: 2 });
const credits = (n: number) => `${nf.format(n)} crédit${Math.abs(n) >= 2 ? "s" : ""}`;
const price = (p: Offer["price"], interval: Offer["interval"]) =>
  p ? `${new Intl.NumberFormat("fr-CH", { style: "currency", currency: p.currency }).format(p.amount)}${interval === "month" ? " / mois" : interval === "year" ? " / an" : ""}` : "prix indisponible";
const dateFr = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + (iso.length <= 10 ? "T00:00:00Z" : "Z"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-CH", { day: "numeric", month: "long", year: "numeric" });
};

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
        <p className="text-[0.95rem] font-medium text-ink-1">Impossible de charger ton solde</p>
        <p className="max-w-xs text-[0.85rem] leading-relaxed text-ink-3">Le serveur ne répond pas. Réessaie dans un instant.</p>
        <Button variant="secondary" size="sm" onClick={load}><RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />Réessayer</Button>
      </Panel>
    );
  }
  if (!data) return <div className="skeleton h-40 rounded-lg" aria-busy="true" aria-label="Chargement du solde" />;
  return (
    <BillingView
      data={data}
      busy={busy}
      actionError={actionError}
      retour={retour}
      onRefresh={() => { void load(); }}
      onAcceptTerms={() => { void acceptTerms(); }}
      onCheckout={(plan) => { void go("/api/billing/checkout", { plan }, plan); }}
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
  if (!data.billing) {
    return (
      <Panel className="p-5">
        <h2 className="text-[0.95rem] font-semibold text-ink-1">Abonnement & crédits</h2>
        <p className="mt-1.5 text-[0.85rem] leading-relaxed text-ink-2">
          La facturation n’est pas activée sur cette instance : les générations ne consomment pas de crédits.
        </p>
      </Panel>
    );
  }

  const sub = data.subscription;
  const subLive = !!sub?.live;
  const canBuy = data.purchase.enabled && data.terms.accepted;
  const legalOk = !!(data.legal.terms && data.legal.refund);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="billing-title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="billing-title" className="text-[0.95rem] font-semibold text-ink-1">Abonnement & crédits</h2>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">
            Un examen coûte {credits(data.costs.exam)}, un mock QCM ou un exercice {credits(data.costs.qcm)}, une aide (drill, correction) {nf.format(data.costs.assist)}.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Actualiser le solde">
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </Button>
      </div>

      {retour === "ok" && (
        <p role="status" className="rounded-lg border border-[color-mix(in_oklch,var(--color-success)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-success)_8%,transparent)] px-4 py-3 text-[0.85rem] text-ink-1">
          Paiement confirmé. Tes crédits apparaissent dès que Stripe nous l’a notifié — quelques secondes en général. Actualise si besoin.
        </p>
      )}
      {retour === "annule" && (
        <p role="status" className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-[0.85rem] text-ink-2">
          Paiement annulé. Rien n’a été débité.
        </p>
      )}

      {/* ── Solde : deux poches ── */}
      <Panel className="divide-y divide-line p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-4">
          <div>
            <div className="text-[0.8rem] text-ink-3">Solde disponible</div>
            <div className="mt-0.5 font-display text-[1.6rem] font-semibold leading-none text-ink-1">{credits(data.balance ?? 0)}</div>
          </div>
          {(data.balance ?? 0) < 0 && (
            <Badge tone="danger" emphasis>Solde négatif : un paiement a été repris. Recharge pour continuer.</Badge>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[0.85rem] sm:grid-cols-2">
          <div>
            <dt className="flex items-center gap-2 text-ink-3">
              Abonnement
              {sub && subLive && <Badge tone={sub.status === "canceled" ? "warning" : "success"} size="xs">{sub.status === "canceled" ? "résilié — actif jusqu’à la fin de période" : "actif"}</Badge>}
            </dt>
            <dd className="mt-0.5 text-ink-1">
              {sub && subLive ? (
                <>
                  <span className="font-medium">{nf.format(sub.creditsThisMonth)} / {nf.format(sub.monthlyCredits)}</span> crédits ce mois-ci
                  {sub.nextRechargeAt && <span className="text-ink-3"> · recharge le {dateFr(sub.nextRechargeAt)}</span>}
                  {!sub.nextRechargeAt && sub.periodEnd && <span className="text-ink-3"> · jusqu’au {dateFr(sub.periodEnd)}</span>}
                  <div className="mt-0.5 text-[0.78rem] text-ink-4">Non reportables : ce qui n’est pas utilisé dans le mois est perdu. Consommés avant tes crédits achetés.</div>
                </>
              ) : (
                <span className="text-ink-3">Aucun abonnement.</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Crédits achetés</dt>
            <dd className="mt-0.5 text-ink-1">
              <span className="font-medium">{nf.format(data.purchased ?? 0)}</span> crédit{Math.abs(data.purchased ?? 0) >= 2 ? "s" : ""}
              <span className="text-ink-3"> · permanents</span>
            </dd>
          </div>
        </dl>
        {sub?.manageable && (
          <div className="px-5 py-3">
            <Button variant="subtle" size="sm" onClick={onPortal} loading={busy === "portal"}>
              Gérer mon abonnement <ExternalLink className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            </Button>
            <span className="ml-3 text-[0.78rem] text-ink-4">Changer de moyen de paiement, télécharger tes factures, résilier (effet en fin de période).</span>
          </div>
        )}
      </Panel>

      {/* ── Offres ── */}
      <Panel className="p-0">
        <div className="px-5 pt-4">
          <h3 className="text-[0.9rem] font-semibold text-ink-1">Recharger</h3>
          {!data.purchase.enabled && (
            <p role="status" className="mt-1.5 text-[0.85rem] text-warning">{data.purchase.reason}</p>
          )}
        </div>
        <ul className="mt-3 divide-y divide-line">
          {data.offers.map((o) => {
            const isSub = o.kind === "subscription";
            const disabled = !canBuy || (isSub && subLive);
            return (
              <li key={o.plan} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="text-[0.9rem] font-medium text-ink-1">{o.label}</div>
                  <div className="text-[0.8rem] text-ink-3">
                    {isSub ? `${nf.format(o.credits)} crédits par mois, non reportables` : `${nf.format(o.credits)} crédits, sans date d’expiration`}
                    {isSub && subLive && <span> · tu as déjà un abonnement</span>}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className={cn("text-[0.9rem] tabular-nums", o.price ? "text-ink-1" : "text-ink-4")}>{price(o.price, o.interval)}</span>
                  <Button
                    variant={isSub ? "primary" : "secondary"}
                    size="sm"
                    disabled={disabled || !o.price}
                    loading={busy === o.plan}
                    onClick={() => onCheckout(o.plan)}
                  >
                    {isSub ? "S’abonner" : "Acheter"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-5 py-4 text-[0.82rem]">
          {data.terms.accepted ? (
            <p className="text-ink-3">
              Conditions générales de vente acceptées le {dateFr(data.terms.acceptedAt)} (version {data.terms.version}).
              {data.legal.terms && <> <a className="underline underline-offset-2 hover:text-ink-1" href={data.legal.terms} target="_blank" rel="noreferrer">Les relire</a>.</>}
            </p>
          ) : (
            <label className="flex items-start gap-3 text-ink-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-violet)]"
                disabled={busy === "terms" || !legalOk}
                onChange={(e) => { if (e.target.checked) onAcceptTerms(); }}
                aria-describedby="terms-help"
              />
              <span id="terms-help">
                J’ai lu et j’accepte les{" "}
                {data.legal.terms ? <a className="underline underline-offset-2 hover:text-ink-1" href={data.legal.terms} target="_blank" rel="noreferrer">conditions générales de vente</a> : "conditions générales de vente"}
                {" "}et la{" "}
                {data.legal.refund ? <a className="underline underline-offset-2 hover:text-ink-1" href={data.legal.refund} target="_blank" rel="noreferrer">politique de remboursement</a> : "politique de remboursement"}
                {" "}(version {data.terms.version}). Obligatoire avant le premier achat.
                {!legalOk && <span className="block text-ink-4">Les documents ne sont pas encore publiés : l’acceptation sera possible dès qu’ils le seront.</span>}
              </span>
            </label>
          )}
          {actionError && <p role="alert" className="mt-2 text-danger-hi">{actionError}</p>}
        </div>
      </Panel>

      {/* ── Historique ── */}
      <Panel className="p-0">
        <h3 className="px-5 pt-4 text-[0.9rem] font-semibold text-ink-1">Historique</h3>
        {data.transactions.length === 0 ? (
          <p className="px-5 pb-4 pt-1.5 text-[0.85rem] text-ink-3">Aucun mouvement pour l’instant. Tes crédits offerts apparaîtront ici dès ta première génération.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[0.82rem]">
              <thead className="text-left text-ink-4">
                <tr>
                  <th scope="col" className="px-5 py-1.5 font-medium">Date</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Mouvement</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Achetés</th>
                  <th scope="col" className="px-5 py-1.5 text-right font-medium">Abonnement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.transactions.map((t, i) => (
                  <tr key={t.ref ?? i} className="text-ink-2">
                    <td className="whitespace-nowrap px-5 py-1.5 tabular-nums text-ink-3">{dateFr(t.created_at)}</td>
                    <td className="px-2 py-1.5">{t.reason}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", t.delta > 0 ? "text-emerald-hi" : t.delta < 0 ? "text-ink-1" : "text-ink-4")}>
                      {t.delta === 0 ? "—" : `${t.delta > 0 ? "+" : ""}${nf.format(t.delta)}`}
                    </td>
                    <td className="px-5 py-1.5 text-right tabular-nums text-ink-3">{t.subAmount > 0 ? `−${nf.format(t.subAmount)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <LegalLine legal={data.legal} />
    </section>
  );
}

export function LegalLine({ legal, className }: { legal: Billing["legal"]; className?: string }) {
  const items: Array<[string, string | null]> = [
    ["Conditions générales de vente", legal.terms],
    ["Confidentialité", legal.privacy],
    ["Remboursements", legal.refund],
    ["Mentions légales", legal.notice],
  ];
  const present = items.filter(([, href]) => href);
  if (!present.length) return null;
  return (
    <p className={cn("flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-ink-4", className)}>
      {present.map(([label, href]) => (
        <a key={label} href={href!} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink-2 hover:underline">{label}</a>
      ))}
    </p>
  );
}
