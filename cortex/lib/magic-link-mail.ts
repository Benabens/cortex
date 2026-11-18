import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";

/**
 * Contenu de l'e-mail de connexion, dans la langue du destinataire. Pur (pas d'envoi) : le
 * transport reste dans lib/auth-providers. Le lien est celui d'Auth.js, inséré tel quel.
 */
export function magicLinkMail(locale: Locale, url: string): { subject: string; html: string } {
  const t = translator(locale);
  return {
    subject: t("magicLink.subject"),
    html: `<p>${t("magicLink.intro")}</p><p><a href="${url}">${t("magicLink.button")}</a></p><p style="color:#888">${t("magicLink.ignore")}</p>`,
  };
}
