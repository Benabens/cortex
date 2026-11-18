"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "use-intl/react";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { LOCALE_NAMES, LOCALES, localeCookie, type Locale } from "@/lib/i18n/locale";

const OPTIONS: SegmentedOption<Locale>[] = LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l], lang: l }));

/**
 * Sélecteur de langue de l'interface. Le cookie suffit avant la connexion (/login) et sans
 * auth ; `persist` l'enregistre aussi sur le compte, qui prime ensuite sur tout appareil.
 */
export function LocaleSwitcher({ persist, className }: { persist: boolean; className?: string }) {
  const t = useTranslations("locale");
  const locale = useLocale();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  async function choose(next: Locale) {
    if (next === locale) return;
    setFailed(false);
    if (persist) {
      // La route enregistre le compte ET pose le cookie : en cas d'échec, rien ne change
      // (cookie compris), sinon le cookie dirait une langue que l'écran n'affiche pas.
      const res = await fetch("/api/account/locale", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }),
      }).catch(() => null);
      if (!res?.ok) { setFailed(true); return; }
    } else {
      document.cookie = localeCookie(next);
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className={className}>
      <Segmented label={t("label")} options={OPTIONS} value={locale} onChange={choose} />
      {failed && <p role="alert" className="mt-2 text-[0.85rem] text-danger-hi">{t("error")}</p>}
    </div>
  );
}
