/**
 * Le cadre des e-mails de Cortex : fond sombre, carte centrée, mot-symbole « cortex. ». Styles en
 * ligne (les clients de messagerie ignorent les feuilles de style). Repris des e-mails de
 * renouvellement (lib/billing/renewal-reminders), dont le rendu ne change pas d'un octet
 * (empreintes dans tests/i18n-magic-link). Module pur.
 */
export const emailEsc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Un paragraphe ; `body` est du HTML déjà échappé. */
export const emailP = (body: string, style = "") => `<p style="margin:0 0 14px;${style}">${body}</p>`;

export const emailLink = (href: string, label: string) => `<a href="${emailEsc(href)}" style="color:#c4b5fd">${emailEsc(label)}</a>`;

/**
 * Bouton d'action, en lien stylé (un <button> ne s'ouvre dans aucun client). Bleu de l'accent de
 * l'app (refonte D2, 04/11/2026), blanc dessus : contraste ≈ 5:1.
 */
export const emailButton = (href: string, label: string) =>
  `<a href="${emailEsc(href)}" style="display:inline-block;padding:12px 22px;background:#2764ec;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${emailEsc(label)}</a>`;

/** Le document complet autour de `inner` (HTML), dans la langue `lang`. */
export function emailFrame(lang: string, inner: string): string {
  return `<!doctype html><html lang="${emailEsc(lang)}"><body style="margin:0;padding:24px 12px;background:#0d0b14;color:#e7e5ef;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">`
    + `<div style="max-width:560px;margin:0 auto;padding:28px;background:#15121f;border:1px solid #2b2640;border-radius:12px">`
    + emailP("cortex.", "font-size:19px;font-weight:600;color:#ffffff")
    + inner
    + `</div></body></html>`;
}
