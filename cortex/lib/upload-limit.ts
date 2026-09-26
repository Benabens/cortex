import { NextResponse } from "next/server";

/**
 * BORNE DES CORPS DE REQUÊTE.
 *
 * `req.formData()` / `req.json()` tamponnent tout le corps en mémoire : un
 * plafond vérifié après coup ne protège de rien — un seul client pouvait
 * faire tomber le conteneur unique. Deux barrières :
 *  1. Content-Length déclaré (rapide) : au-delà du plafond → 413, absent sur
 *     un multipart → 411 (les navigateurs l'envoient toujours) ;
 *  2. les octets RÉELS : le flux est lu morceau par morceau et la lecture
 *     s'arrête dès que le cumul dépasse le plafond (PayloadTooLarge → 413),
 *     qu'un client mente sur Content-Length ou envoie en chunked.
 * Les routes enveloppent leur handler dans `withBodyLimit` pour traduire
 * PayloadTooLarge en 413 ; le plafond par fichier reste contrôlé après parsing.
 */

/** Corps au-delà du plafond, détecté PENDANT la lecture. */
export class PayloadTooLarge extends Error {
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`Corps de requête trop volumineux (maximum ${Math.round(maxBytes / 1e6)} Mo).`);
    this.name = "PayloadTooLarge";
  }
}

/** Plafond par défaut d'un corps JSON/texte (1 Mio). */
export const JSON_MAX_BYTES = 1024 * 1024;

export const MiB = 1024 * 1024;

/** Plafonds par route (octets). Env : UPLOAD_MAX_MB relève/abaisse le défaut « refs ». */
export const UPLOAD_LIMITS = {
  /** Annales (plusieurs PDF par envoi). */
  refs: (Number(process.env.UPLOAD_MAX_MB) > 0 ? Number(process.env.UPLOAD_MAX_MB) : 64) * MiB,
  /** Un fichier de source (30 Mo max côté fichier) + enveloppe multipart. */
  source: 32 * MiB,
  /** Une photo (12 Mo max côté fichier) + champs texte. */
  image: 16 * MiB,
} as const;

/** À appeler AVANT `req.formData()`. Renvoie une réponse 411/413 à retourner telle quelle, sinon null. */
export function rejectOversizedBody(req: Request, maxBytes: number): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (raw == null || raw === "") {
    return NextResponse.json({ error: "Content-Length requis pour un envoi de fichier." }, { status: 411 });
  }
  // Entier décimal strict : Number() accepterait « 1e3 », « 0x10 » ou des espaces.
  if (!/^\d{1,15}$/.test(raw.trim())) {
    return NextResponse.json({ error: "Content-Length invalide." }, { status: 400 });
  }
  const declared = Number(raw.trim());
  if (declared > maxBytes) {
    return NextResponse.json(
      { error: `Envoi trop volumineux (${Math.round(declared / 1e6)} Mo, maximum ${Math.round(maxBytes / 1e6)} Mo).` },
      { status: 413 },
    );
  }
  return null;
}

/**
 * Lit le corps en comptant les octets réels ; s'arrête et lève PayloadTooLarge
 * dès que le cumul dépasse `maxBytes`. Ne fait pas confiance à Content-Length
 * (sauf pour refuser plus tôt quand il annonce déjà trop).
 */
export async function readBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw new PayloadTooLarge(maxBytes);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Multipart borné : pré-contrôle Content-Length (411/413) puis octets réels, puis parsing. */
export async function readFormData(req: Request, maxBytes: number): Promise<FormData> {
  const early = rejectOversizedBody(req, maxBytes);
  if (early) throw new EarlyReject(early);
  const bytes = await readBodyBounded(req, maxBytes);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    return await new Request(req.url, { method: req.method, headers: req.headers, body }).formData();
  } catch {
    throw new EarlyReject(NextResponse.json({ error: "Envoi multipart attendu." }, { status: 400 }));
  }
}

/** JSON borné : PayloadTooLarge au-delà du plafond ; JSON invalide ou vide → `fallback`.
 *  Rend `any` comme `req.json()` : les routes valident elles-mêmes chaque champ. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(req: Request, fallback: unknown, maxBytes = JSON_MAX_BYTES): Promise<any> {
  const bytes = await readBodyBounded(req, maxBytes);
  if (!bytes.byteLength) return fallback;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return fallback; }
}

/** Texte brut borné (corps de webhook à vérifier par signature). */
export async function readText(req: Request, maxBytes = JSON_MAX_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBodyBounded(req, maxBytes));
}

/** Refus du pré-contrôle (411/413/400) porté comme exception jusqu'à withBodyLimit. */
export class EarlyReject extends Error {
  readonly response: NextResponse;
  constructor(response: NextResponse) { super("corps refusé"); this.name = "EarlyReject"; this.response = response; }
}

type Handler<R extends Request, A extends unknown[]> = (req: R, ...args: A) => Promise<Response>;

/** Enveloppe un handler : PayloadTooLarge → 413, pré-contrôle → sa réponse (411/413). Le reste remonte. */
export function withBodyLimit<R extends Request, A extends unknown[]>(handler: Handler<R, A>): Handler<R, A> {
  return async (req, ...args) => {
    try {
      return await handler(req, ...args);
    } catch (e) {
      if (e instanceof PayloadTooLarge) return NextResponse.json({ error: e.message }, { status: 413 });
      if (e instanceof EarlyReject) return e.response;
      throw e;
    }
  };
}
