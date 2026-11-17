"use client";

import { useEffect } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n/locale";
import { APP_TIME_ZONE, type Messages } from "@/lib/i18n/messages";

/**
 * Contexte de traduction des Client Components (`useTranslations`). La langue et le
 * dictionnaire sont choisis côté serveur (lib/i18n/server) et transmis une fois, par le
 * layout racine.
 */
export function IntlProvider({ locale, messages, syncCookie, children }: {
  locale: Locale;
  messages: Messages;
  /** Langue venue du compte : on la recopie dans le cookie lu par les routes API. */
  syncCookie: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!syncCookie) return;
    if (document.cookie.split("; ").includes(`${LOCALE_COOKIE}=${locale}`)) return;
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  }, [locale, syncCookie]);
  return (
    <UseIntlProvider locale={locale} messages={messages} timeZone={APP_TIME_ZONE}>
      {children}
    </UseIntlProvider>
  );
}
