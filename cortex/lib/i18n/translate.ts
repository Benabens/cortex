import { createTranslator } from "use-intl/core";
import { type Locale } from "./locale";
import { APP_TIME_ZONE, MESSAGES } from "./messages";

/**
 * Traducteur HORS rendu React : routes API, e-mails, tâches de fond. Même dictionnaire et
 * même syntaxe ICU que `useTranslations`, sans contexte de requête.
 */
export function translator(locale: Locale) {
  return createTranslator({ locale, messages: MESSAGES[locale], timeZone: APP_TIME_ZONE });
}
