import { authGet, authRun } from "@/db/auth-store";
import { isLocale, type Locale } from "./locale";

/**
 * Langue enregistrée du compte (users.locale). C'est la source de vérité de ce qui part
 * sans navigateur (e-mails, connecteur MCP) et elle prime sur le navigateur à l'écran :
 * un compte retrouve sa langue sur un nouvel appareil.
 */
export async function accountLocale(userId: string): Promise<Locale | null> {
  const row = await authGet<{ locale: string | null }>(`SELECT locale FROM users WHERE id = ?`, userId);
  return isLocale(row?.locale) ? row.locale : null;
}

export async function setAccountLocale(userId: string, locale: Locale): Promise<void> {
  await authRun(`UPDATE users SET locale = ? WHERE id = ?`, locale, userId);
}

/** Première visite d'un compte qui n'a rien choisi : la langue négociée devient la sienne
 *  (ses e-mails partent ensuite dans la langue où il a découvert l'app). Jamais d'écrasement. */
export async function adoptLocaleOnce(userId: string, locale: Locale): Promise<void> {
  await authRun(`UPDATE users SET locale = ? WHERE id = ? AND locale IS NULL`, locale, userId);
}
