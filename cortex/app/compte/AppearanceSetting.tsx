"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { useTheme } from "@/lib/ux/use-theme";
import type { ThemePref } from "@/lib/ux/theme";

const OPTIONS: SegmentedOption<ThemePref>[] = [
  { value: "system", label: "Système", Icon: Monitor },
  { value: "light", label: "Clair", Icon: Sun },
  { value: "dark", label: "Sombre", Icon: Moon },
];

/** Apparence : thème sombre, clair, ou celui du système (défaut). Gardé sur cet appareil. */
export function AppearanceSetting() {
  const { pref, setPref } = useTheme();

  return (
    <section className="rounded-lg border border-line bg-surface-2/40 p-5" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="text-[1.05rem] font-semibold text-ink-1">Apparence</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
        Par défaut, Cortex suit le réglage clair ou sombre de ton appareil. Ton choix est gardé dans ce navigateur.
      </p>
      <Segmented
        className="mt-3"
        label="Thème de l’interface"
        options={OPTIONS}
        value={pref}
        onChange={setPref}
      />
    </section>
  );
}
