"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

type Purchase = { id: string; type: "pack" | "subscription"; purchasedAt: string; label: string };

export function WithdrawalForm() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [selected, setSelected] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/account/withdrawal").then(async (r) => {
    if (!r.ok) throw new Error(`Erreur ${r.status}`);
    return r.json();
  }).then((d) => setPurchases(d.purchases ?? [])).catch(() => setError("Impossible de charger tes achats. Réessaie dans un instant.")); }, []);
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
      if (!res.ok) throw new Error(data.error ?? "La demande n’a pas pu être envoyée.");
      setReceipt(data.requestedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "La demande n’a pas pu être envoyée. Réessaie.");
    } finally {
      setBusy(false);
    }
  };
  if (!purchases.length && !receipt && !error) return null;
  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="withdrawal-title">
      <h2 id="withdrawal-title" className="text-xl font-semibold text-ink-1">Me rétracter d’un achat</h2>
      {receipt ? <p role="status" className="mt-2 text-[0.85rem] text-ink-2">Demande reçue le {new Date(receipt.replace(" ", "T") + "Z").toLocaleString("fr-FR")}. Un accusé de réception a été envoyé si l’e-mail est configuré. Le remboursement sera traité manuellement.</p> : !confirming ? <>
        <p className="mt-1 text-[0.85rem] text-ink-3">Choisis un achat effectué il y a moins de 14 jours.</p>
        <select aria-label="Achat concerné par la rétractation" className="mt-3 min-h-11 w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-ink-1" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choisir un achat</option>
          {purchases.map((p) => <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.label}, acheté le {new Date(p.purchasedAt).toLocaleDateString("fr-FR")}</option>)}
        </select>
        <Button className="mt-3" size="sm" disabled={!chosen} onClick={() => setConfirming(true)}>Continuer</Button>
      </> : <>
        <p className="mt-2 text-[0.85rem] text-ink-2">Confirme ta rétractation pour « {chosen?.label} ». Aucun remboursement n’est déclenché automatiquement.</p>
        <div className="mt-3 flex gap-2"><Button size="sm" loading={busy} onClick={() => void submit()}>Confirmer ma rétractation</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Revenir</Button></div>
      </>}
      {error && <p role="alert" className="mt-2 text-danger-hi">{error}</p>}
    </section>
  );
}
