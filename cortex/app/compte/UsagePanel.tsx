"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { formatReset, type KindUsage, type LaunchKind, type UsageLimit, type UsageLimits } from "@/lib/billing/limits-text";
import { watchPageRestore } from "@/lib/ux/bfcache";
import { cn } from "@/lib/ux/cn";

/**
 * MON USAGE — ce qu'on peut encore lancer, type par type, et chaque limite qui
 * peut bloquer, avec sa remise à zéro. Les chiffres viennent de GET /api/usage,
 * c'est-à-dire de la fonction qui décide aussi au lancement (lib/billing/limits) :
 * ce qui est écrit ici est ce que la génération appliquera.
 */

const ORDER: LaunchKind[] = ["exam", "qcm", "exercise", "prepare", "check", "drill"];
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function remainingText(u: KindUsage): string {
  if (u.remaining === null) return "Sans limite";
  return `${nf.format(u.remaining)} restant${u.remaining >= 2 ? "s" : ""}`;
}

function limitValue(l: UsageLimit): string {
  if (l.key === "credits") return `${nf.format(l.remaining ?? 0)} ${l.unit}`;
  if (l.unit === "%") return `${nf.format(l.used ?? 0)} % utilisé`;
  return `${nf.format(l.used ?? 0)} / ${nf.format(l.limit ?? 0)} ${l.unit}`;
}

function resetText(l: UsageLimit, now: string): string | null {
  if (!l.resetAt) return null;
  if (l.key === "credits") return `recharge ${formatReset(l.resetAt, now)}`;
  return `remise à 0 ${formatReset(l.resetAt, now)}`;
}

export function UsageView({ data }: { data: UsageLimits }) {
  const kinds = ORDER.map((k) => data.generations[k]).filter(Boolean);
  return (
    <Panel className="overflow-hidden divide-y divide-line p-0">
      <div className="px-5 py-4">
        <h3 className="text-base font-semibold text-ink-1">Ce que tu peux encore lancer</h3>
        {data.owner && (
          <p className="mt-1 text-[0.8rem] text-ink-3">Compte propriétaire : pas de crédits ni de limite par compte. Seule la capacité de Cortex s’applique.</p>
        )}
        <ul className="mt-3 divide-y divide-line">
          {kinds.map((u) => (
            <li key={u.kind} data-kind={u.kind} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 text-[0.85rem]">
              <span className="text-ink-1">
                {capitalize(u.label)}
                {u.costCredits > 0 && <span className="text-ink-3"> · {nf.format(u.costCredits)} crédit{u.costCredits >= 2 ? "s" : ""}</span>}
              </span>
              {u.allowed ? (
                <span className="text-ink-2">
                  <span className="font-data font-semibold tabular text-ink-1">{remainingText(u)}</span>
                  {u.limitedBy === "credits" && <span className="text-ink-3"> avec ton solde</span>}
                  {u.remaining !== null && u.resetAt && u.limitedBy !== "credits" && (
                    <span className="text-ink-3"> · remise à 0 {formatReset(u.resetAt, data.now)}</span>
                  )}
                </span>
              ) : u.blockedBy === "credits" ? (
                <span className="text-right text-warning">
                  Il te faut {nf.format(u.costCredits)} crédit{u.costCredits >= 2 ? "s" : ""} ·{" "}
                  <a href="#credits" className="font-medium text-ink-1 underline underline-offset-2">Recharger</a>
                </span>
              ) : (
                <span className="max-w-md text-right text-warning">{u.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {data.limits.length > 0 && (
        <div className="px-5 py-4">
          <h3 className="text-base font-semibold text-ink-1">Tes limites</h3>
          <dl className="mt-3 divide-y divide-line">
            {data.limits.map((l) => {
              const reset = resetText(l, data.now);
              const full = l.remaining !== null && l.remaining <= 0;
              return (
                <div key={l.key} data-limit={l.key} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 text-[0.85rem]">
                  <dt className="text-ink-2">{l.label}</dt>
                  <dd className="text-right">
                    <span className={cn("font-data font-semibold tabular", full ? "text-warning" : "text-ink-1")}>{limitValue(l)}</span>
                    {reset && <span className="text-ink-3"> · {reset}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-3 text-[0.78rem] leading-relaxed text-ink-4">
            {data.limits.some((l) => l.key === "daily_compute") && "Le calcul du jour borne la génération par compte et par jour ; il n’entame pas tes crédits. "}
            Les heures sont à l’heure de Lausanne.
          </p>
        </div>
      )}
    </Panel>
  );
}

export function UsagePanel() {
  const [data, setData] = useState<UsageLimits | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<UsageLimits>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setData(d); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const unwatch = watchPageRestore(load);
    return () => { window.removeEventListener("focus", onFocus); unwatch(); };
  }, [load]);

  return (
    <section id="usage" className="flex scroll-mt-24 flex-col gap-4" aria-labelledby="usage-title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="usage-title" className="text-xl font-semibold text-ink-1">Mon usage</h2>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">Combien de générations il te reste, et quand chaque limite se remet à zéro.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} aria-label="Actualiser mon usage">
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </Button>
      </div>
      {failed ? (
        <Panel className="px-5 py-4 text-[0.85rem] text-ink-2">Impossible de lire ton usage pour l’instant. Réessaie dans un instant.</Panel>
      ) : data ? (
        <UsageView data={data} />
      ) : (
        <div className="skeleton h-40 rounded-lg" role="status" aria-busy="true" aria-label="Chargement de ton usage" />
      )}
    </section>
  );
}
