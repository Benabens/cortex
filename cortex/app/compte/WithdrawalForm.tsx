"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useLocale, useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

export type Purchase = { id: string; type: "pack" | "subscription"; purchasedAt: string; label: string };

export function WithdrawalForm({ initialPurchases = [], initialSelected = "", initialConfirming = false }: { initialPurchases?: Purchase[]; initialSelected?: string; initialConfirming?: boolean } = {}) {
  const t = useTranslations("account.withdrawal");
  const locale = useLocale();
  const f = useFmt();
  const [purchases, setPurchases] = useState<Purchase[]>(initialPurchases);
  const [selected, setSelected] = useState(initialSelected);
  const [confirming, setConfirming] = useState(initialConfirming);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/account/withdrawal").then(async (r) => {
    if (!r.ok) throw new Error(t("errorStatus", { status: r.status }));
    return r.json();
  }).then((d) => setPurchases(d.purchases ?? [])).catch(() => setError(t("loadFailed"))); }, [t]);
  const chosen = purchases.find((p) => `${p.type}:${p.id}` === selected);
  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/withdrawal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: chosen.type, purchaseId: chosen.id, confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("sendFailed"));
      setReceipt(data.requestedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sendRetry"));
    } finally {
      setBusy(false);
    }
  };
  if (!purchases.length && !receipt && !error) return null;
  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="withdrawal-title">
      <h2 id="withdrawal-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
      {receipt ? <p role="status" className="mt-2 text-[0.85rem] text-ink-2">{t("receipt", { date: f.dateTime(receipt) })}</p> : !confirming ? <>
        <p className="mt-1 text-[0.85rem] text-ink-3">{t("hint")}</p>
        <select aria-label={t("purchaseLabel")} className="mt-3 min-h-11 w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-ink-1" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{t("choose")}</option>
          {purchases.map((p) => <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{t("option", { label: t(`purchaseType.${p.type}`), date: f.date(p.purchasedAt) })}</option>)}
        </select>
        <Button className="mt-3" size="sm" disabled={!chosen} onClick={() => setConfirming(true)}>{t("continue")}</Button>
      </> : <>
        <p className="mt-2 text-[0.85rem] text-ink-2">{t("confirm", { label: chosen ? t(`purchaseType.${chosen.type}`) : "" })}</p>
        {locale === "en" && <><p className="mt-3 text-[0.8rem] text-ink-3">{t("binding")}</p><details lang="fr" className="mt-2 text-[0.8rem] text-ink-3"><summary>{t("frenchVersion")}</summary><p className="mt-2">{t("frenchLegal", { label: chosen!.label })}</p></details></>}
        <div className="mt-3 flex gap-2"><Button size="sm" loading={busy} onClick={() => void submit()}>{t("submit")}</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>{t("back")}</Button></div>
      </>}
      {error && <p role="alert" className="mt-2 text-danger-hi">{error}</p>}
    </section>
  );
}
