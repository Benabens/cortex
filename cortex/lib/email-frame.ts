/**
 * Le cadre des e-mails à la marque Cortex, repris du reçu (./billing/receipt-email, #179) :
 * thème sombre de l'app (refonte D2, un seul accent bleu), mot-symbole « cortex. », une carte,
 * une ligne de pied. Tableaux et styles en ligne : les messageries ignorent les feuilles de style
 * et une partie de la mise en page CSS. Le rendu du reçu ne change pas d'un octet (empreintes dans
 * tests/i18n-magic-link). Module pur.
 */

export const emailEsc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Palette de l'e-mail : tokens sombres de l'app figés en hex (pas de CSS global dans une messagerie). */
export const EMAIL_PALETTE = { bg: "#080c14", card: "#10151f", line: "#232b3a", ink: "#ececee", muted: "#a7adbb", accent: "#2764ec", link: "#9ebcff" } as const;

/** Bouton d'action : un lien dans une cellule colorée (un <button> ne s'ouvre dans aucune messagerie). */
export function emailButton(href: string, label: string, margin = "24px 0 0"): string {
  const C = EMAIL_PALETTE;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${margin}"><tr><td style="border-radius:8px;background:${C.accent}">`
    + `<a href="${emailEsc(href)}" style="display:inline-block;padding:11px 18px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${emailEsc(label)}</a></td></tr></table>`;
}

/** Le document complet. `card` et `footer` sont du HTML déjà échappé ; `title` est du texte. */
export function emailShell(o: { lang: string; title: string; card: string; footer: string }): string {
  const C = EMAIL_PALETTE;
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${emailEsc(o.title)}</title></head>`
    + `<body style="margin:0;padding:32px 12px;background:${C.bg};color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">`
    + `<tr><td style="padding:0 4px 20px;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${C.ink}">cortex<span style="color:${C.accent}">.</span></td></tr>`
    + `<tr><td style="padding:28px;background:${C.card};border:1px solid ${C.line};border-radius:12px">`
    + o.card
    + `</td></tr>`
    + `<tr><td style="padding:20px 4px 0;font-size:13px;color:${C.muted}">${o.footer}</td></tr>`
    + `</table></body></html>`;
}
