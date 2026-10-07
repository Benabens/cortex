/**
 * ENVOI D'E-MAIL de notification (Resend) : accusé de rétractation, alertes de
 * dépense. Ne lève jamais : un envoi impossible (clé absente, refus, panne
 * réseau) revient comme un résultat, et l'appelant décide quoi en faire.
 *
 * Le lien magique de connexion garde son propre envoi (lib/auth-providers) :
 * lui doit échouer bruyamment, et il a un second transport (AUTH_EMAIL_ENDPOINT).
 */
export type EmailOutcome = { ok: true } | { ok: false; reason: string };

export async function sendEmail(mail: { to: string; subject: string; text: string }): Promise<EmailOutcome> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: "RESEND_API_KEY absente" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM ?? "Cortex <onboarding@resend.dev>", to: mail.to, subject: mail.subject, text: mail.text }),
      // Une panne de Resend ne doit pas retenir l'appelant (une génération, une demande de rétractation).
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `Resend a répondu HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
}
