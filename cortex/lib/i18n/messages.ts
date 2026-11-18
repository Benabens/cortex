import en from "@/messages/en.json";
import fr from "@/messages/fr.json";
import type { Locale } from "./locale";

/**
 * Dictionnaires de l'interface. Le français est la référence de typage (AppConfig dans
 * lib/i18n/types.d.ts) : une clé absente ou mal tapée casse `tsc` ; la parité des deux
 * fichiers (mêmes clés, mêmes arguments ICU) est vérifiée par tests/i18n-messages.test.ts.
 */
export type Messages = typeof fr;

export const MESSAGES: Record<Locale, Messages> = { fr, en };

/** Fuseau de l'app : les heures affichées sont celles de Zurich, et l'écran le dit. */
export const APP_TIME_ZONE = "Europe/Zurich";
