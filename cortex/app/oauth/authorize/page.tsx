import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/shell/Logo";
import { OWNER_USER } from "@/db/context";
import { auth, authEnabled } from "@/lib/auth";
import { SCOPE_GENERATE, SCOPE_WRITE } from "@/lib/oauth/config";
import { prepareConsent } from "@/lib/oauth/routes";
import { NOINDEX } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { ...NOINDEX, title: "Connecter une application · cortex" };

/**
 * ÉCRAN DE CONSENTEMENT du connecteur MCP (docs/MCP.md, § Flux OAuth). Derrière
 * la session de l'app : un visiteur sans session est passé par /login (proxy)
 * et revient ici. Aucun JavaScript : un formulaire classique, qui ne porte qu'un
 * ticket opaque lié au compte connecté. Même direction artistique que /login.
 */

// Jetons --bare-* de globals.css : la DA sombre de /login, et son équivalent en thème clair.
// faint : #8a8798 en sombre (5,2:1 sur la surface), #5f6b7e en clair (5,4:1).
const C = {
  bg: "var(--bare-bg)",
  ink: "var(--bare-ink)",
  muted: "var(--bare-muted)",
  faint: "var(--bare-faint)",
  line: "var(--bare-line)",
  surface: "var(--bare-surface)",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ background: C.bg, color: C.ink }} className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <div className="flex justify-center"><Wordmark markSize={30} /></div>
        {children}
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const h = await headers();
  const userId = h.get("x-cortex-user") ?? OWNER_USER;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const view = await prepareConsent(new Request(`${proto}://${host}/oauth/authorize`), params, userId);
  // Hors de tout try : redirect() lève une exception de contrôle que Next doit voir passer.
  if (view.kind === "redirect") redirect(view.url);

  if (view.kind === "error") {
    return (
      <Shell>
        <h1 className="mt-8 text-center text-[1.25rem] font-semibold tracking-tight">Connexion impossible</h1>
        <p role="alert" className="mt-5 rounded-lg px-4 py-3 text-[0.88rem] leading-relaxed"
          style={{ background: "var(--bare-error-bg)", border: "1px solid var(--bare-error-line)", color: "var(--error-ink)" }}>
          {view.message}
        </p>
        <p className="mt-6 text-center text-[0.85rem]" style={{ color: C.muted }}>
          <Link href="/" className="underline underline-offset-4">Retour à Cortex</Link>
        </p>
      </Shell>
    );
  }

  const email = authEnabled() ? (await auth())?.user?.email ?? null : null;
  const name = view.clientName ?? view.clientHost;
  const canGenerate = view.scopes.includes(SCOPE_GENERATE);
  const canWrite = view.scopes.includes(SCOPE_WRITE);

  return (
    <Shell>
      <h1 className="mt-8 text-center text-[1.3rem] font-semibold leading-snug tracking-tight">
        {name} demande l’accès à ton compte Cortex
      </h1>

      <dl className="mt-6 rounded-lg px-4 py-3 text-[0.85rem] leading-relaxed" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
        <div className="flex justify-between gap-4">
          <dt style={{ color: C.muted }}>{view.verifiedDomain ? "Domaine vérifié" : "Nom déclaré par l’application"}</dt>
          <dd className="text-right font-medium">{view.verifiedDomain ? view.clientHost : name}</dd>
        </div>
        <div className="mt-2 flex justify-between gap-4 border-t pt-2" style={{ borderColor: C.line }}>
          <dt style={{ color: C.muted }}>Retour vers</dt>
          <dd className="text-right font-medium">{view.localRedirect ? `cet ordinateur (${view.redirectHost})` : view.redirectHost}</dd>
        </div>
        {view.localRedirect ? (
          <p className="mt-2 text-[0.78rem]" style={{ color: "var(--warn-ink)" }}>
            La connexion revient vers un programme de cet ordinateur. N’accepte que si tu viens de la lancer toi-même (par exemple depuis Claude Code).
          </p>
        ) : !view.verifiedDomain && (
          <p className="mt-2 text-[0.78rem]" style={{ color: C.faint }}>
            Le nom « {name} » n’est pas vérifié. N’accepte que si tu viens d’ajouter cette application.
          </p>
        )}
        {email && (
          <div className="mt-2 flex justify-between gap-4 border-t pt-2" style={{ borderColor: C.line }}>
            <dt style={{ color: C.muted }}>Compte</dt>
            <dd className="text-right font-medium">{email}</dd>
          </div>
        )}
      </dl>

      <form method="post" action="/oauth/authorize/decision" className="mt-6">
        <input type="hidden" name="ticket" value={view.ticket} />
        <fieldset>
          <legend className="text-[0.9rem] font-semibold">Elle pourra :</legend>
          <ul className="mt-3 flex flex-col gap-3 text-[0.86rem] leading-relaxed">
            <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
              <span className="font-medium">Lire</span>
              <span style={{ color: C.muted }}> tes cours, ton programme, tes points faibles, tes résultats, tes documents de cours et ton solde.</span>
            </li>
            {canGenerate && (
              <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" name="generate" defaultChecked className="mt-1 size-4 accent-primary" />
                  <span>
                    <span className="font-medium">Générer</span>
                    <span style={{ color: C.muted }}> des examens blancs, des questions d’entraînement et des corrections. Ces actions coûtent des crédits : chacune t’annonce son coût et attend ton accord.</span>
                  </span>
                </label>
              </li>
            )}
            {canWrite && (
              <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" name="write" defaultChecked className="mt-1 size-4 accent-primary" />
                  <span>
                    <span className="font-medium">Ajouter des cours et des supports</span>
                    <span style={{ color: C.muted }}> : créer un cours et y ranger un document (adresse web ou texte), gratuitement. Le préparer coûte des crédits : il faut aussi « Générer », et son coût t’est annoncé avant ton accord.</span>
                  </span>
                </label>
              </li>
            )}
          </ul>
          <p className="mt-3 text-[0.8rem] leading-relaxed" style={{ color: C.faint }}>
            {canWrite ? "Jamais : supprimer tes cours ou tes documents, ni toucher à tes paiements." : "Jamais : modifier ou supprimer tes cours, ni toucher à tes paiements."}
            {" "}Tu peux couper cet accès à tout moment dans Mon compte → Applications connectées.
          </p>
        </fieldset>

        <div className="mt-6 flex flex-col gap-3">
          <button type="submit" name="decision" value="approve"
            className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-primary text-[0.92rem] font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover active:bg-primary-active">
            Autoriser
          </button>
          <button type="submit" name="decision" value="deny"
            // Couleurs en classes : un `style` inline l'emporterait sur le survol.
            className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-[var(--bare-field-line)] bg-[var(--bare-surface)] text-[0.92rem] font-medium text-[var(--bare-ink)] transition-colors duration-150 hover:bg-[var(--bare-surface-hover)]">
            Refuser
          </button>
        </div>
      </form>
    </Shell>
  );
}
