"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

type App = { id: string; name: string | null; host: string | null; scopes: string[]; connectedAt: string; lastUsedAt: string | null };

const fmt = (s: string | null) => {
  if (!s) return "jamais";
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
};

/**
 * Applications connectées au compte par le connecteur MCP (Claude…) : ce
 * qu'elles peuvent faire, depuis quand, dernière utilisation, et « Révoquer »
 * qui coupe immédiatement tous leurs jetons. Affiché seulement si le
 * connecteur est activé sur l'instance (MCP_ENABLED=1).
 */
export function ConnectedApps() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/account/connected-apps", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ apps: App[] }>) : Promise.reject(new Error(String(res.status)))))
      .then((d) => { if (alive) setApps(d.apps); })
      .catch(() => { if (alive) setError("Impossible de charger les applications connectées. Recharge la page."); });
    return () => { alive = false; };
  }, []);

  const revoke = async (app: App) => {
    setBusy(app.id);
    setError(null);
    try {
      const res = await fetch(`/api/account/connected-apps?id=${encodeURIComponent(app.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setApps((list) => (list ?? []).filter((a) => a.id !== app.id));
    } catch {
      setError("La révocation a échoué. Réessaie.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface-2/40 p-5" aria-labelledby="apps-title">
      <h2 id="apps-title" className="text-[1.05rem] font-semibold text-ink-1">Applications connectées</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
        Les assistants que tu as branchés sur ton compte (par exemple Claude, avec l’adresse <code className="text-ink-1">/mcp</code>).
        Révoquer coupe leur accès immédiatement.
      </p>
      {error && <p role="alert" className="mt-3 text-[0.85rem] text-[#f7b6ae]">{error}</p>}
      {apps && apps.length === 0 && <p className="mt-3 text-[0.88rem] text-ink-3">Aucune application connectée.</p>}
      {apps && apps.length > 0 && (
        <ul className="mt-4 flex flex-col divide-y divide-line rounded-md border border-line">
          {apps.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[0.92rem] font-medium text-ink-1">
                  {a.name ?? a.host ?? "Application"}
                  {a.host && a.name && <span className="ml-2 text-[0.8rem] font-normal text-ink-3">{a.host}</span>}
                </div>
                <div className="mt-0.5 text-[0.8rem] text-ink-3">
                  {a.scopes.includes("cortex.generate") ? "Lecture et génération" : "Lecture seule"} · connectée le {fmt(a.connectedAt)} · utilisée {a.lastUsedAt ? `le ${fmt(a.lastUsedAt)}` : "jamais"}
                </div>
              </div>
              <Button size="sm" variant="subtle" loading={busy === a.id} onClick={() => void revoke(a)} aria-label={`Révoquer ${a.name ?? a.host ?? "l'application"}`}>
                Révoquer
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
