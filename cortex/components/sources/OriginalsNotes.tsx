import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { OriginalsInfo } from "@/lib/ux/sources";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

/**
 * Textes des originaux d'un compte gratuit (décision du 17/11/2026, lib/originals) : ses fichiers
 * restent sur son ordinateur, Cortex n'en garde que l'index. Mêmes mots partout : « sur ton
 * ordinateur », « index », « Premium » (abonnement en cours, ou achat dans l'année).
 */

export const PREMIUM_HREF = "/compte#credits";

/** Sous la zone d'import : ce que devient le fichier déposé. */
export function LocalImportNote({ transitHours }: { transitHours: number }) {
  const t = useTranslations("originals");
  return (
    <div data-testid="originals-local-note" className="flex gap-3 rounded-lg border border-line bg-surface-2/30 px-3.5 py-3">
      <HardDrive className="mt-0.5 size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
      <div className="text-[0.8rem] leading-relaxed text-ink-2">
        <p>
          {t("localNote", { hours: transitHours })}
        </p>
        <p className="mt-1 text-ink-3">
          <a href={PREMIUM_HREF} className="font-medium text-accent-hi underline underline-offset-4">{t("premiumLink")}</a>{" "}
          {t("premiumHint")}
        </p>
      </div>
    </div>
  );
}

/** Dans la liste des fichiers : l'original n'est plus sur le serveur. */
export function OnComputerBadge() {
  const t = useTranslations("originals");
  return (
    <span
      title={t("badgeTitle")}
      className="ml-2 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[0.68rem] text-ink-3"
    >
      <HardDrive className="size-3" strokeWidth={2} aria-hidden="true" />
      {t("onComputer")}
    </span>
  );
}

/** Fichiers encore dans le cloud d'un compte qui n'est plus (ou pas) Premium : le jour où ils partent. */
export function CloudRetentionBanner({ originals }: { originals: OriginalsInfo }) {
  const t = useTranslations("originals");
  const f = useFmt();
  if (originals.home !== "local" || !originals.purgeOn || originals.cloudFiles <= 0) return null;
  const date = f.date(originals.purgeOn);
  const n = originals.cloudFiles;
  return (
    <div role="status" data-testid="originals-retention" className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm text-ink-1">
      <p className="font-semibold">
        {originals.wasPremium ? t("premiumEnded") : t("freeCloudEnded")}
      </p>
      <p className="mt-1 text-ink-2">
        {t("retention", { count: n, date })}
      </p>
      <Button variant="primary" size="md" href={PREMIUM_HREF} className="mt-3">
        {originals.wasPremium ? t("resumePremium") : t("goPremium")}
      </Button>
    </div>
  );
}

/**
 * Devenu Premium avec des fichiers restés sur l'ordinateur : les renvoyer les remet dans le cloud
 * (même empreinte : l'index ne change pas). Un dossier réimporté les renvoie tous d'un coup.
 */
export function BackToCloudNote({ originals }: { originals: OriginalsInfo }) {
  const t = useTranslations("originals");
  const n = originals.onComputer.length;
  if (originals.home !== "cloud" || n === 0) return null;
  return (
    <div role="status" data-testid="originals-back-to-cloud" className="rounded-xl border border-line bg-surface-2/30 p-4 text-sm text-ink-1">
      <p className="font-semibold">{t("backTitle", { count: n })}</p>
      <p className="mt-1 text-ink-2">
        {t("backHint", { replacement: n > 1 ? t("backMany") : t("backOne") })}
      </p>
    </div>
  );
}
