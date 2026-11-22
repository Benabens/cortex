import { EMAIL_PALETTE, emailButton, emailEsc, emailShell } from "@/lib/email-frame";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";

/**
 * Contenu de l'e-mail de connexion, dans la langue du destinataire, au cadre des e-mails Cortex
 * (lib/email-frame, celui du reçu) : bouton, durée du lien, le même lien en clair pour une
 * messagerie qui n'affiche pas le bouton, et une version texte. Vouvoiement, comme les autres
 * e-mails. Pur (pas d'envoi) : le transport reste dans lib/auth-providers. Le lien est celui
 * d'Auth.js, inséré tel quel (échappé dans le HTML). Durée : `maxAge` du fournisseur e-mail.
 */
export function magicLinkMail(locale: Locale, url: string): { subject: string; html: string; text: string } {
  const t = translator(locale);
  const C = EMAIL_PALETTE;
  const subject = t("magicLink.subject");
  const html = emailShell({
    lang: locale,
    title: subject,
    card: `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;font-weight:600;color:${C.ink}">${emailEsc(t("magicLink.title"))}</h1>`
      + `<p style="margin:0;color:${C.muted}">${emailEsc(t("magicLink.intro"))}</p>`
      + emailButton(url, t("magicLink.button"))
      + `<p style="margin:16px 0 0;font-size:14px;color:${C.muted}">${emailEsc(t("magicLink.validity"))}</p>`
      + `<p style="margin:16px 0 0;font-size:13px;color:${C.muted}">${emailEsc(t("magicLink.fallback"))}<br>`
      + `<a href="${emailEsc(url)}" style="color:${C.link};word-break:break-all">${emailEsc(url)}</a></p>`,
    footer: emailEsc(t("magicLink.ignore")),
  });
  const text = [t("magicLink.title"), t("magicLink.intro"), `${t("magicLink.button")}${locale === "fr" ? " :" : ":"} ${url}`, t("magicLink.validity"), t("magicLink.ignore")].join("\n\n");
  return { subject, html, text };
}
