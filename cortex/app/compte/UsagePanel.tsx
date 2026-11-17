"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { formatReset, type KindUsage, type LaunchKind, type UsageLimit, type UsageLimits } from "@/lib/billing/limits-text";
import { watchPageRestore } from "@/lib/ux/bfcache";
import { cn } from "@/lib/ux/cn";
import { useLocale, useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

/**
 * MON USAGE — ce qu'on peut encore lancer, type par type, et chaque limite qui
 * peut bloquer, avec sa remise à zéro. Les chiffres viennent de GET /api/usage,
 * c'est-à-dire de la fonction qui décide aussi au lancement (lib/billing/limits) :
 * ce qui est écrit ici est ce que la génération appliquera.
 */

const ORDER: LaunchKind[] = ["exam", "qcm", "exercise", "prepare", "check", "drill"];
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function UsageView({ data }: { data: UsageLimits }) {
  const t = useTranslations("account.usage");
  const locale = useLocale();
  const f = useFmt();
  const remainingText = (u: KindUsage) => u.remaining === null ? t("unlimited") : t("remaining", { count: u.remaining, formatted: f.number(u.remaining) });
  const limitValue = (l: UsageLimit) => l.key === "credits" ? t("creditValue", { value: f.number(l.remaining ?? 0), unit: l.unit })
    : l.unit === "%" ? t("percentUsed", { value: f.number(l.used ?? 0) }) : t("limitValue", { used: f.number(l.used ?? 0), limit: f.number(l.limit ?? 0), unit: l.unit });
  const resetText = (l: UsageLimit) => !l.resetAt ? null : t(l.key === "credits" ? "recharge" : "reset", { when: formatReset(l.resetAt, data.now, locale) });
  const kinds = ORDER.map((k) => data.generations[k]).filter(Boolean);
  return (
    <Panel className="overflow-hidden divide-y divide-line p-0">
      <div className="px-5 py-4">
        <h3 className="text-base font-semibold text-ink-1">{t("remainingTitle")}</h3>
        {data.owner && (
          <p className="mt-1 text-[0.8rem] text-ink-3">{t("owner")}</p>
        )}
        <ul className="mt-3 divide-y divide-line">
          {kinds.map((u) => (
            <li key={u.kind} data-kind={u.kind} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 text-[0.85rem]">
              <span className="text-ink-1">
                {capitalize(u.label)}
                {u.costCredits > 0 && <span className="text-ink-3">{t("cost", { count: u.costCredits, formatted: f.number(u.costCredits) })}</span>}
              </span>
              {u.allowed ? (
                <span className="text-ink-2">
                  <span className="font-data font-semibold tabular text-ink-1">{remainingText(u)}</span>
                  {u.limitedBy === "credits" && <span className="text-ink-3">{t("withBalance")}</span>}
                  {u.remaining !== null && u.resetAt && u.limitedBy !== "credits" && (
                    <span className="text-ink-3">{t("resetSuffix", { when: formatReset(u.resetAt, data.now, locale) })}</span>
                  )}
                </span>
              ) : u.blockedBy === "credits" ? (
                <span className="text-right text-warning">
                  {t.rich("needed", { count: u.costCredits, formatted: f.number(u.costCredits), link: (chunks) => <a href="#credits" className="font-medium text-ink-1 underline underline-offset-2">{chunks}</a> })}
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
          <h3 className="text-base font-semibold text-ink-1">{t("limitsTitle")}</h3>
          <dl className="mt-3 divide-y divide-line">
            {data.limits.map((l) => {
              const reset = resetText(l);
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
            {data.limits.some((l) => l.key === "daily_compute") && t("dailyCompute")}{t("timezone")}
          </p>
        </div>
      )}
    </Panel>
  );
}

export function UsagePanel() {
  const t = useTranslations("account.usage");
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
          <h2 id="usage-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">{t("description")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} aria-label={t("refresh")}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </Button>
      </div>
      {failed ? (
        <Panel className="px-5 py-4 text-[0.85rem] text-ink-2">{t("failed")}</Panel>
      ) : data ? (
        <UsageView data={data} />
      ) : (
        <div className="skeleton h-40 rounded-lg" role="status" aria-busy="true" aria-label={t("loading")} />
      )}
    </section>
  );
}
