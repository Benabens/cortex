import { emailButton, emailEsc, emailFrame, emailLink, emailP } from "@/lib/email-frame";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";

/**
 * Contenu de l'e-mail de connexion, dans la langue du destinataire, au cadre des autres e-mails de
 * Cortex (lib/email-frame) : bouton, le même lien en clair pour les clients qui n'affichent pas les
 * boutons, et une version texte. Pur (pas d'envoi) : le transport reste dans lib/auth-providers. Le
 * lien est celui d'Auth.js, inséré tel quel (échappé dans le HTML). Durée : `maxAge` du fournisseur.
 */
export function magicLinkMail(locale: Locale, url: string): { subject: string; html: string; text: string } {
  const t = translator(locale);
  const html = emailFrame(locale, [
    emailP(emailEsc(t("magicLink.intro"))),
    `<p style="margin:22px 0">${emailButton(url, t("magicLink.button"))}</p>`,
    emailP(emailEsc(t("magicLink.validity"))),
    emailP(`${emailEsc(t("magicLink.fallback"))}<br><span style="word-break:break-all">${emailLink(url, url)}</span>`, "color:#a9a4bd;font-size:13px"),
    emailP(emailEsc(t("magicLink.ignore")), "color:#a9a4bd;font-size:13px"),
  ].join(""));
  const text = [t("magicLink.intro"), `${t("magicLink.button")}${locale === "fr" ? " :" : ":"} ${url}`, t("magicLink.validity"), t("magicLink.ignore")].join("\n\n");
  return { subject: t("magicLink.subject"), html, text };
}
