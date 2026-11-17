import { NextResponse } from "next/server";
import { clientErrorTrackingConfig } from "@/lib/observability";
import { readBodyBounded, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Un événement nettoyé pèse quelques Ko ; au-delà, ce n'est pas une erreur à signaler. */
const ENVELOPE_MAX_BYTES = 200_000;

type Dsn = { key: string; host: string; project: string };

function parseDsn(raw: string | undefined): Dsn | null {
  try {
    const u = new URL(raw ?? "");
    const project = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(project)) return null;
    return { key: u.username, host: u.host, project };
  } catch {
    return null;
  }
}

/**
 * Configuration du suivi d'erreurs du navigateur (components/ErrorTracking),
 * lue à chaque chargement de page : 204 sans SENTRY_DSN, et le SDK n'est alors
 * jamais téléchargé. Rien de secret : un DSN de navigateur est public par nature.
 */
export function GET() {
  const config = clientErrorTrackingConfig();
  if (!config) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  return NextResponse.json(config, { headers: { "cache-control": "no-store" } });
}

/**
 * TUNNEL SENTRY (lib/observability-browser) — le navigateur poste ses
 * enveloppes ici, à sa propre origine : la CSP garde connect-src 'self', donc
 * une XSS ne peut rien exfiltrer, pas même vers un projet Sentry à elle. Le
 * tunnel ne relaie qu'au projet du SENTRY_DSN configuré (l'en-tête de
 * l'enveloppe doit le nommer) ; 404 sans SENTRY_DSN. Public (erreurs de la page
 * de connexion comprises), soumis au rate-limit du proxy.
 */
export const POST = withBodyLimit(async function POST(req: Request) {
  const target = parseDsn(process.env.SENTRY_DSN?.trim());
  if (!target) return new NextResponse("Not found", { status: 404 });
  const body = new TextDecoder().decode(await readBodyBounded(req, ENVELOPE_MAX_BYTES));
  const eol = body.indexOf("\n");
  let header: { dsn?: string } = {};
  try {
    header = JSON.parse(eol < 0 ? body : body.slice(0, eol)) as { dsn?: string };
  } catch {
    return NextResponse.json({ error: "enveloppe illisible" }, { status: 400 });
  }
  const sent = parseDsn(header.dsn);
  if (!sent || sent.host !== target.host || sent.project !== target.project || sent.key !== target.key) {
    return NextResponse.json({ error: "projet inconnu" }, { status: 400 });
  }
  try {
    const upstream = await fetch(`https://${target.host}/api/${target.project}/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return new NextResponse(null, { status: upstream.ok ? 200 : upstream.status });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
});
