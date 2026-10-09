/**
 * ENVOI D'E-MAIL de notification (Resend) : accusé de rétractation, alertes de
 * dépense, rappel de reconduction de l'abonnement annuel. Ne lève jamais : un envoi impossible (clé absente, refus, panne
 * réseau) revient comme un résultat, et l'appelant décide quoi en faire.
 *
 * `idempotencyKey` : Resend retient la clé 24 h et n'envoie qu'une fois. Un
 * nouvel essai sous la même clé reçoit la réponse d'origine, ou un 409 :
 * « contenu différent » est pris pour un premier essai accepté, donc un
 * e-mail parti (leur doc ne dit pas si un essai refusé retient sa clé : ne
 * réutiliser une clé qu'après une issue inconnue, jamais après un refus vu) ;
 * « premier essai encore en cours » ne dit rien.
 *
 * `html` : version mise en forme, en plus du texte (qui reste la version de
 * repli des messageries sans HTML).
 *
 * `uncertain` : on ne sait pas si l'e-mail est parti (pas de réponse, délai
 * dépassé, premier essai en cours). Sans ce drapeau, un échec est un refus
 * net : rien n'est parti. `status` porte alors la réponse HTTP de Resend : un
 * 4xx (clé, expéditeur, destinataire) ne se répare pas en réessayant.
 *
 * Le lien magique de connexion garde son propre envoi (lib/auth-providers) :
 * lui doit échouer bruyamment, et il a un second transport (AUTH_EMAIL_ENDPOINT).
 */
export type EmailOutcome = { ok: true } | { ok: false; reason: string; uncertain?: true; status?: number };

export async function sendEmail(mail: { to: string; subject: string; text: string; html?: string; idempotencyKey?: string }): Promise<EmailOutcome> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: "RESEND_API_KEY absente" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`, "content-type": "application/json",
        ...(mail.idempotencyKey ? { "idempotency-key": mail.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM ?? "Cortex <onboarding@resend.dev>", to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }),
      // Une panne de Resend ne doit pas retenir l'appelant (une génération, une demande de rétractation).
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 409 && mail.idempotencyKey) {
      const name: unknown = await res.json().then((b) => (b as { name?: unknown } | null)?.name, () => undefined);
      if (name === "invalid_idempotent_request") return { ok: true };
      return { ok: false, reason: "Resend a répondu HTTP 409 (premier essai encore en cours)", uncertain: true };
    }
    return { ok: false, reason: `Resend a répondu HTTP ${res.status}`, status: res.status };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 160) : String(e), uncertain: true };
  }
}
