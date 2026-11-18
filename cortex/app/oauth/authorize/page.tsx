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
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("oauthAuthorize");
  return { ...NOINDEX, title: t("metadata") };
}

/**
 * ÉCRAN DE CONSENTEMENT du connecteur MCP (docs/MCP.md, § Flux OAuth). Derrière
 * la session de l'app : un visiteur sans session est passé par /login (proxy)
 * et revient ici. Aucun JavaScript : un formulaire classique, qui ne porte qu'un
 * ticket opaque lié au compte connecté. Même direction artistique que /login.
 */

// Jetons --bare-* de globals.css : la DA sombre de /login, et son équivalent en thème clair.
// faint : ink-3 en sombre (#9295a0, 6,1:1 sur la surface), #5f6b7e en clair (5,4:1).
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
      <div className="d2-card w-full max-w-[32rem] p-6 sm:p-9">
        <div className="flex justify-center"><Wordmark markSize={30} /></div>
        {children}
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getT("oauthAuthorize");
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
        <h1 className="mt-8 text-center text-[1.25rem] font-semibold tracking-tight">{t("failed")}</h1>
        <p role="alert" className="mt-5 rounded-lg px-4 py-3 text-[0.88rem] leading-relaxed"
          style={{ background: "var(--bare-error-bg)", border: "1px solid var(--bare-error-line)", color: "var(--error-ink)" }}>
          {view.message}
        </p>
        <p className="mt-6 text-center text-[0.85rem]" style={{ color: C.muted }}>
          <Link href="/" className="underline underline-offset-4">{t("back")}</Link>
        </p>
      </Shell>
    );
  }

  const email = authEnabled() ? (await auth())?.user?.email ?? null : null;
  const name = view.clientName ?? view.clientHost;
  // Reconnu (client_id CIMD ou URL de retour https connue) : on nomme d'après l'identité, pas le nom déclaré.
  // Nom qui imite un client connu : l'hôte de retour est accolé, le titre ne lui prête aucun crédit.
  const shownName = view.recognized?.label ?? (view.impersonates ? `${name} (${view.redirectHost})` : name);
  const canGenerate = view.scopes.includes(SCOPE_GENERATE);
  const canWrite = view.scopes.includes(SCOPE_WRITE);

  return (
    <Shell>
      <h1 className="mt-8 text-center text-[1.3rem] font-semibold leading-snug tracking-tight">
        {t("requestTitle", { name: shownName })}
      </h1>

      <dl className="mt-6 rounded-lg px-4 py-3 text-[0.85rem] leading-relaxed" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
        <div className="flex justify-between gap-4">
          <dt style={{ color: C.muted }}>{view.recognized ? t("recognized") : view.verifiedDomain ? t("verifiedDomain") : t("declaredName")}</dt>
          <dd className="text-right font-medium">{view.recognized ? `${view.recognized.label} · ${view.recognized.domain}` : view.verifiedDomain ? view.clientHost : name}</dd>
        </div>
        <div className="mt-2 flex justify-between gap-4 border-t pt-2" style={{ borderColor: C.line }}>
          <dt style={{ color: C.muted }}>{t("redirectTo")}</dt>
          <dd className="text-right font-medium">{view.localRedirect ? t("thisComputer", { host: view.redirectHost }) : view.redirectHost}</dd>
        </div>
        {view.impersonates && (
          <p role="alert" className="mt-2 text-[0.78rem]" style={{ color: "var(--error-ink)" }}>
            {t("impersonates", { name, domain: view.impersonates })}
          </p>
        )}
        {view.localRedirect ? (
          <p className="mt-2 text-[0.78rem]" style={{ color: "var(--warn-ink)" }}>
            {t("localWarning")}
          </p>
        ) : !view.verifiedDomain && !view.recognized && !view.impersonates && (
          <p className="mt-2 text-[0.78rem]" style={{ color: C.faint }}>
            {t("unverified", { name })}
          </p>
        )}
        {email && (
          <div className="mt-2 flex justify-between gap-4 border-t pt-2" style={{ borderColor: C.line }}>
            <dt style={{ color: C.muted }}>{t("account")}</dt>
            <dd className="text-right font-medium">{email}</dd>
          </div>
        )}
      </dl>

      <form method="post" action="/oauth/authorize/decision" className="mt-6">
        <input type="hidden" name="ticket" value={view.ticket} />
        <fieldset>
          <legend className="text-[0.9rem] font-semibold">{t("can")}</legend>
          <ul className="mt-3 flex flex-col gap-3 text-[0.86rem] leading-relaxed">
            <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
              <span className="font-medium">{t("read")}</span>
              <span style={{ color: C.muted }}>{t("readScope")}</span>
            </li>
            {canGenerate && (
              <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" name="generate" defaultChecked className="mt-1 size-4 accent-accent" />
                  <span>
                    <span className="font-medium">{t("generate")}</span>
                    <span style={{ color: C.muted }}>{t("generateScope")}</span>
                  </span>
                </label>
              </li>
            )}
            {canWrite && (
              <li className="rounded-lg px-4 py-3" style={{ border: `1px solid ${C.line}` }}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" name="write" defaultChecked className="mt-1 size-4 accent-accent" />
                  <span>
                    <span className="font-medium">{t("write")}</span>
                    <span style={{ color: C.muted }}>{t("writeScope")}</span>
                  </span>
                </label>
              </li>
            )}
          </ul>
          <p className="mt-3 text-[0.8rem] leading-relaxed" style={{ color: C.faint }}>
            {t(canWrite ? "neverWrite" : "neverRead")} {t("revoke")}
          </p>
          <p className="mt-2 text-[0.8rem]" style={{ color: C.faint }}>
            <Link href="/compte/assistants" target="_blank" rel="noopener" className="underline underline-offset-4">{t("howTo")}</Link>
          </p>
        </fieldset>

        <div className="mt-6 flex flex-col gap-3">
          <button type="submit" name="decision" value="approve"
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-primary text-[0.92rem] font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover active:bg-primary-active">
            {t("approve")}
          </button>
          <button type="submit" name="decision" value="deny"
            // Couleurs en classes : un `style` inline l'emporterait sur le survol.
            className="inline-flex h-12 w-full items-center justify-center rounded-full border border-[var(--bare-field-line)] bg-[var(--bare-surface)] text-[0.92rem] font-medium text-[var(--bare-ink)] transition-colors duration-150 hover:bg-[var(--bare-surface-hover)]">
            {t("deny")}
          </button>
        </div>
      </form>
    </Shell>
  );
}
