"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

type App = { id: string; name: string | null; host: string | null; scopes: string[]; connectedAt: string; lastUsedAt: string | null };

/** Ce que l'application peut faire, en clair (portées cortex.read / .generate / .write). */
/**
 * Applications connectées au compte par le connecteur MCP (tout assistant) : ce
 * qu'elles peuvent faire, depuis quand, dernière utilisation, et « Révoquer »
 * qui coupe immédiatement tous leurs jetons. Affiché seulement si le
 * connecteur est activé sur l'instance (MCP_ENABLED=1).
 */
export function ConnectedApps() {
  const t = useTranslations("account.connectedApps");
  const f = useFmt();
  const accessLabel = (scopes: string[]) => {
    const generate = scopes.includes("cortex.generate");
    const write = scopes.includes("cortex.write");
    return t(generate && write ? "accessAll" : generate ? "accessGenerate" : write ? "accessWrite" : "accessRead");
  };
  const formatDate = (s: string | null) => s ? f.date(s) : t("never");
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/account/connected-apps", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ apps: App[] }>) : Promise.reject(new Error(String(res.status)))))
      .then((d) => { if (alive) setApps(d.apps); })
      .catch(() => { if (alive) setError(t("loadFailed")); });
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
      setError(t("revokeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="apps-title">
      <h2 id="apps-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
        {t("description")} {" "}
        <Link href="/compte/assistants" className="text-ink-1 underline underline-offset-4">{t("connect")}</Link>
      </p>
      {error && <p role="alert" className="mt-3 text-[0.85rem] text-[var(--error-ink)]">{error}</p>}
      {!apps && !error && <div className="skeleton mt-4 h-20 rounded-xl" role="status" aria-label={t("loading")} aria-busy="true" />}
      {apps && apps.length === 0 && <p className="mt-3 text-[0.88rem] text-ink-3">{t("empty")}</p>}
      {apps && apps.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {apps.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/40 px-4 py-4">
              <div className="min-w-0">
                <div className="text-[0.92rem] font-medium text-ink-1">
                  {a.name ?? a.host ?? t("application")}
                  {a.host && a.name && <span className="ml-2 text-[0.8rem] font-normal text-ink-3">{a.host}</span>}
                </div>
                <div className="mt-0.5 text-[0.8rem] text-ink-3">
                  {t("meta", { access: accessLabel(a.scopes), connected: formatDate(a.connectedAt), used: a.lastUsedAt ? t("onDate", { date: formatDate(a.lastUsedAt) }) : t("never") })}
                </div>
              </div>
              <Button size="sm" variant="subtle" loading={busy === a.id} onClick={() => void revoke(a)} aria-label={t("revokeNamed", { name: a.name ?? a.host ?? t("theApplication") })}>
                {t("revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
