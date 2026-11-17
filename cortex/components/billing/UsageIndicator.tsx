"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useLocale } from "use-intl/react";
import { remainingLine, type KindUsage, type UsageLimits } from "@/lib/billing/limits-text";
import { watchPageRestore } from "@/lib/ux/bfcache";
import { cn } from "@/lib/ux/cn";
import { PaywallNotice } from "./PaywallNotice";

/**
 * INDICATEUR D'USAGE posé à côté d'un bouton de génération. Il lit GET /api/usage
 * pour la composition exacte qu'on s'apprête à lancer : même verdict que la route
 * de génération (lib/billing/limits launchVerdict), donc un bouton désactivé ici
 * l'aurait été au lancement, avec le même message et la même remise à zéro.
 *
 * Une lecture qui échoue ne bloque rien : le serveur reste le seul juge au clic.
 */

export type UsageKind = "exam" | "qcm" | "exercise" | "lab-exercise" | "prepare" | "format" | "drill" | "check";

export type LaunchUsage = {
  usage: KindUsage | null;
  now: string;
  /** false : un lancement maintenant serait refusé (raison dans usage.reason). */
  allowed: boolean;
  refresh: () => void;
};

const REFRESH_MS = 60_000;
/** Plusieurs indicateurs du même type sur un écran (une vérification par question) : une seule lecture. */
const SHARE_MS = 5_000;
const shared = new Map<string, { at: number; p: Promise<UsageLimits | null> }>();

function readUsage(url: string, force: boolean): Promise<UsageLimits | null> {
  const hit = shared.get(url);
  if (!force && hit && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = fetch(url, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<UsageLimits>) : null))
    .catch(() => null); // hors ligne : le serveur tranchera au clic
  shared.set(url, { at: Date.now(), p });
  return p;
}

export function useLaunchUsage(kind: UsageKind, target?: Record<string, unknown> | null): LaunchUsage {
  const [state, setState] = useState<{ usage: KindUsage | null; now: string }>({ usage: null, now: new Date().toISOString() });
  const key = target ? JSON.stringify(target) : "";
  const seq = useRef(0);

  const load = useCallback((force: boolean) => {
    const id = ++seq.current;
    const qs = new URLSearchParams({ kind });
    if (key) qs.set("target", key);
    void readUsage(`/api/usage?${qs}`, force).then((d) => {
      if (d && id === seq.current) setState({ usage: d.check, now: d.now });
    });
  }, [kind, key]);
  /** Relecture forcée : après un lancement, le compteur a bougé. */
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), REFRESH_MS);
    const onFocus = () => load(false);
    window.addEventListener("focus", onFocus);
    const unwatch = watchPageRestore(refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); unwatch(); };
  }, [load, refresh]);

  // Une remise à zéro passée : on relit pour réactiver le bouton sans recharger la page.
  const until = state.usage?.blockedUntil;
  useEffect(() => {
    if (!until) return;
    const wait = new Date(until).getTime() - Date.now();
    if (!(wait > 0) || wait > 6 * 3_600_000) return;
    const t = setTimeout(refresh, wait + 1_000);
    return () => clearTimeout(t);
  }, [until, refresh]);

  return { ...state, allowed: state.usage?.allowed ?? true, refresh };
}

/**
 * La ligne elle-même : « Il te reste 3 examens QCM aujourd'hui · remise à 0 demain à 01:00 »,
 * ou, si le lancement serait refusé, la raison et sa remise à zéro (l'encart d'achat quand
 * c'est le solde). Rien quand rien ne limite.
 */
export function UsageLine({ usage, now, className }: { usage: KindUsage | null; now: string; className?: string }) {
  // Langue de l'écran passée explicitement : côté client, currentLocale() n'a pas de requête.
  const locale = useLocale();
  if (!usage) return null;
  // Solde trop bas : l'encart d'achat dit le prix et mène à l'achat, au lieu du message brut avec son lien.
  if (!usage.allowed && usage.blockedBy === "credits") {
    return <div className={className}><PaywallNotice credits={Math.max(usage.costCredits, 0.01)} /></div>;
  }
  if (!usage.allowed && usage.reason) {
    return (
      <p role="status" data-testid="usage-blocked" className={cn("flex items-start gap-2 text-[0.82rem] leading-relaxed text-warning", className)}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span>{usage.reason}</span>
      </p>
    );
  }
  const line = remainingLine(usage, now, locale);
  if (!line) return null;
  return <p data-testid="usage-remaining" className={cn("text-[0.8rem] text-ink-3", className)}>{line}</p>;
}
