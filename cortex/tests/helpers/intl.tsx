/**
 * Rendu statique d'un composant traduit (`useTranslations`) hors de l'app : sans ce contexte,
 * use-intl lève « No intl context found ». Français par défaut, la langue des tests existants.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "use-intl/react";
import type { Locale } from "../../lib/i18n/locale";
import { APP_TIME_ZONE, MESSAGES } from "../../lib/i18n/messages";

export function withIntl(el: ReactElement, locale: Locale = "fr"): ReactElement {
  return <IntlProvider locale={locale} messages={MESSAGES[locale]} timeZone={APP_TIME_ZONE}>{el}</IntlProvider>;
}

export function renderIntl(el: ReactElement, locale: Locale = "fr"): string {
  return renderToStaticMarkup(withIntl(el, locale));
}
