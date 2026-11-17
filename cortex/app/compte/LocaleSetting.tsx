"use client";

import { useTranslations } from "use-intl/react";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";

/** Langue de l'interface et des e-mails, enregistrée sur le compte quand il y en a un. */
export function LocaleSetting({ persist }: { persist: boolean }) {
  const t = useTranslations("locale");
  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="locale-title">
      <h2 id="locale-title" className="text-xl font-semibold text-ink-1">{t("title")}</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">{t("hint")}</p>
      <LocaleSwitcher persist={persist} className="mt-3" />
    </section>
  );
}
