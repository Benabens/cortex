import { cookies, headers } from "next/headers";
import { cache } from "react";
import { createTranslator } from "use-intl/core";
import { log } from "@/lib/metrics";
import { accountLocale, adoptLocaleOnce } from "./account-locale";
import { isLocale, LOCALE_COOKIE, resolveLocale, type Locale } from "./locale";
import { APP_TIME_ZONE, MESSAGES } from "./messages";

export type RequestLocale = {
  locale: Locale;
  /** true quand la langue vient du compte : le navigateur doit la recopier dans son
   *  cookie, pour que les routes API (qui ne lisent pas la base) parlent la même langue. */
  fromAccount: boolean;
};

/**
 * Langue de la requête en cours (Server Components, une seule lecture par rendu).
 * L'id du compte est l'en-tête interne posé par proxy.ts (jamais celui du client).
 */
export const getRequestLocale = cache(async (): Promise<RequestLocale> => {
  const h = await headers();
  const userId = h.get("x-cortex-user");
  let account: Locale | null = null;
  if (userId) {
    try {
      account = await accountLocale(userId);
    } catch (e) {
      // Base indisponible : l'écran s'affiche quand même, dans la langue du navigateur.
      log("warn", "i18n.account_locale_failed", { message: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    }
  }
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value ?? null;
  const locale = resolveLocale({ account, cookie, acceptLanguage: h.get("accept-language") });
  if (userId && !account) {
    adoptLocaleOnce(userId, locale).catch(() => {}); // e-mails et MCP : la langue où le compte a découvert l'app
  }
  return { locale, fromAccount: isLocale(account) };
});

export async function getLocale(): Promise<Locale> {
  return (await getRequestLocale()).locale;
}

/** `t` d'un Server Component : `const t = await getT("login")`. */
export async function getT<N extends keyof typeof MESSAGES.fr>(namespace: N) {
  const locale = await getLocale();
  return createTranslator({ locale, messages: MESSAGES[locale], namespace, timeZone: APP_TIME_ZONE });
}
