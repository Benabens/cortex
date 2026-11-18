"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { useTheme } from "@/lib/ux/use-theme";
import type { ThemePref } from "@/lib/ux/theme";
import { useTranslations } from "use-intl/react";

/** Apparence : thème sombre, clair, ou celui du système (défaut). Gardé sur cet appareil. */
export function AppearanceSetting() {
  const { pref, setPref } = useTheme();
  const t = useTranslations("account.appearance");
  const options: SegmentedOption<ThemePref>[] = [
    { value: "system", label: t("system"), Icon: Monitor },
    { value: "light", label: t("light"), Icon: Sun },
    { value: "dark", label: t("dark"), Icon: Moon },
  ];

  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
        {t("description")}
      </p>
      <Segmented
        className="mt-3"
        label={t("label")}
        options={options}
        value={pref}
        onChange={setPref}
      />
    </section>
  );
}
