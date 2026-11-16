import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowLeft, ChevronDown, ExternalLink } from "lucide-react";
import styles from "@/app/secondary.module.css";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { MCP_WEBSITE_URL, mcpUrl } from "@/lib/mcp/identity";
import { assistantPrompt, clientGuides, type ClientGuide } from "@/lib/mcp/install-guide";
import { TOOLS } from "@/lib/mcp/registry";
import { issuerFor } from "@/lib/oauth/config";
import { CopyButton } from "./CopyButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connecter ton assistant · Cortex" };

/** Origine de la requête, pour un poste local sans AUTH_URL (issuerFor préfère toujours AUTH_URL). */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${h.get("x-forwarded-proto") ?? (local ? "http" : "https")}://${host}`;
}

function Snippet({ id, code, label }: { id: string; code: string; label: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2/60 p-2 pl-3">
      <pre id={id} className="min-w-0 flex-1 whitespace-pre-wrap break-all py-1.5 font-mono text-[0.8rem] leading-relaxed text-ink-1"><code>{code}</code></pre>
      <CopyButton text={code} label={label} selectId={id} />
    </div>
  );
}

function ClientBlock({ guide, open }: { guide: ClientGuide; open: boolean }) {
  return (
    <details className="group border-t border-line first:border-t-0" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors duration-150 hover:bg-surface-2/50 sm:px-6 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[0.98rem] font-medium text-ink-1">{guide.name}</span>
          <span className="block text-[0.8rem] text-ink-3">{guide.where}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180" strokeWidth={2} aria-hidden="true" />
      </summary>
      <div className="px-5 pb-5 sm:px-6">
        <ol className="flex flex-col gap-3">
          {guide.steps.map((s, i) => (
            <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 text-[0.88rem] leading-relaxed text-ink-2">
              <span className="pt-px font-mono text-[0.78rem] text-ink-4" aria-hidden="true">{i + 1}.</span>
              <div className="min-w-0">
                <p>{s.text}</p>
                {s.code && <Snippet id={`${guide.id}-${i}`} code={s.code} label={`Copier : ${guide.name}, étape ${i + 1}`} />}
                {s.link && (
                  <Button size="sm" variant="secondary" href={s.link.href} className="mt-2" target={s.link.href.startsWith("https://") ? "_blank" : undefined} rel="noopener noreferrer">
                    {s.link.label}
                    {s.link.href.startsWith("https://") && <ExternalLink className="size-3.5" strokeWidth={2.25} aria-hidden="true" />}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {guide.note && <p className="mt-4 text-[0.8rem] leading-relaxed text-ink-3">{guide.note}</p>}
      </div>
    </details>
  );
}

/** Ce que fait chaque outil, lu dans le registre du serveur (jamais recopié à la main). */
function ToolList() {
  const groups = [
    { title: "Lire", hint: "Gratuit, ne change rien à ton compte.", tools: TOOLS.filter((t) => t.kind === "read") },
    { title: "Ajouter et organiser", hint: "Gratuit.", tools: TOOLS.filter((t) => t.kind === "write" && !t.spends) },
    { title: "Générer", hint: "Payant en crédits : l’assistant t’annonce le coût et attend ton accord.", tools: TOOLS.filter((t) => t.kind === "generate" || t.spends) },
  ];
  return (
    <div className="mt-5 grid gap-6 md:grid-cols-3 md:gap-5">
      {groups.map((g) => (
        <div key={g.title} className="min-w-0">
          <h3 className="text-[0.95rem] font-semibold text-ink-1">{g.title}</h3>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">{g.hint}</p>
          <ul className="mt-3 flex flex-col gap-2.5">
            {g.tools.map((t) => (
              <li key={t.name} className="text-[0.86rem] leading-snug text-ink-2">
                <span className="block">{t.userSummary}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[0.74rem] text-ink-4">{t.name}</code>
                  {(t.kind === "generate" || t.spends) && <Badge size="xs" tone="warning">Crédits</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default async function AssistantsPage() {
  const issuer = issuerFor(new Request(await requestOrigin()));
  const url = issuer ? mcpUrl(issuer) : null;

  return (
    <div className={styles.page}>
      <div>
        <Link href="/compte" className="inline-flex items-center gap-1.5 text-[0.85rem] text-ink-3 transition-colors duration-150 hover:text-ink-1">
          <ArrowLeft className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
          Mon compte
        </Link>
        <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Connecter ton assistant</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">
          Branche Claude, ChatGPT ou ton éditeur de code sur ton compte Cortex : il lit tes cours, tes résultats et tes points faibles,
          et lance un examen blanc ou un exercice quand tu le lui demandes.
        </p>
      </div>

      {!url ? (
        <section className="d2-card p-5 sm:p-6">
          <h2 className="text-xl font-semibold text-ink-1">Connecteur non activé</h2>
          <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
            Le connecteur pour assistants n’est pas activé sur cette instance de Cortex.
          </p>
        </section>
      ) : (
        <>
          <section className="d2-card p-5 sm:p-6" aria-labelledby="address-title">
            <h2 id="address-title" className="text-xl font-semibold text-ink-1">Adresse du connecteur</h2>
            <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
              La même pour tous les assistants. Aucune clé à copier : tu te connectes à Cortex et tu choisis ce que l’assistant peut faire.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div id="mcp-url" className="min-w-0 flex-1 break-all rounded-lg border border-line-strong bg-surface-2 px-3.5 py-2.5 font-mono text-[0.92rem] text-ink-1">{url}</div>
              <CopyButton text={url} label="Copier l’adresse du connecteur" selectId="mcp-url" className="h-10 self-start px-3.5 text-[0.85rem] sm:self-auto" />
            </div>
            <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-[0.82rem] sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-ink-3">Transport</dt><dd className="text-ink-2">HTTP (Streamable HTTP)</dd>
              <dt className="text-ink-3">Connexion</dt><dd className="text-ink-2">OAuth 2.1 : l’assistant s’enregistre seul, sans identifiant client ni secret</dd>
            </dl>
          </section>

          <section className="d2-card overflow-hidden" aria-labelledby="clients-title">
            <div className="px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
              <h2 id="clients-title" className="text-xl font-semibold text-ink-1">Étape par étape</h2>
              <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">Choisis ton assistant.</p>
            </div>
            <div className="border-t border-line">
              {clientGuides(url).map((g, i) => <ClientBlock key={g.id} guide={g} open={i === 0} />)}
            </div>
          </section>

          <section className="d2-card p-5 sm:p-6" aria-labelledby="prompt-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="prompt-title" className="text-xl font-semibold text-ink-1">Demande à ton assistant</h2>
                <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
                  Colle ce message dans n’importe quel assistant : il a tout pour se brancher, ou pour te dire où cliquer.
                </p>
              </div>
              <CopyButton text={assistantPrompt(url)} label="Copier le message pour l’assistant" selectId="assistant-prompt" className="h-10 px-3.5 text-[0.85rem]" />
            </div>
            <pre id="assistant-prompt" className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2/60 p-4 font-sans text-[0.88rem] leading-relaxed text-ink-2">{assistantPrompt(url)}</pre>
          </section>

          <section className="d2-card p-5 sm:p-6" aria-labelledby="tools-title">
            <h2 id="tools-title" className="text-xl font-semibold text-ink-1">Ce que l’assistant peut faire</h2>
            <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
              Seulement sur ton compte, et seulement ce que tu autorises à la connexion. Il ne voit ni ton mot de passe ni ton moyen de paiement.
            </p>
            <ToolList />
          </section>

          <section className="flex flex-col gap-2 text-[0.85rem] text-ink-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <span>
              Couper l’accès d’un assistant : <Link href="/compte#apps-title" className="text-ink-2 underline underline-offset-4 hover:text-ink-1">Mon compte → Applications connectées</Link>
            </span>
            <a href={MCP_WEBSITE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-2 underline underline-offset-4 hover:text-ink-1">
              Présentation du connecteur
              <ExternalLink className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            </a>
          </section>
        </>
      )}
    </div>
  );
}
