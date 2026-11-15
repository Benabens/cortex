import fs from "node:fs";
import { Readable } from "node:stream";
import type { ByteRange } from "@/lib/storage/bucket";

/**
 * Plage demandée par l'en-tête Range, pour un fichier de `size` octets.
 *  - absente, multiple ou d'une autre unité → null (fichier entier, 200) ;
 *  - hors du fichier → "unsatisfiable" (416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // « bytes=-N » : les N derniers octets.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** Réponse 200 / 206 / 416 pour un corps déjà découpé à `range`. */
export function rangedResponse(body: Readable | null, size: number, range: ByteRange | null | "unsatisfiable", headers: Record<string, string>): Response {
  const base = { ...headers, "accept-ranges": "bytes" };
  if (range === "unsatisfiable") {
    body?.destroy();
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  const web = body ? (Readable.toWeb(body) as ReadableStream<Uint8Array>) : null;
  if (!range) return new Response(web, { status: 200, headers: { ...base, "content-length": String(size) } });
  return new Response(web, {
    status: 206,
    headers: { ...base, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
  });
}

/** Diffuse un fichier du disque (en flux : jamais lu en entier en mémoire). */
export function serveLocalFile(file: string, size: number, req: Request, headers: Record<string, string>): Response {
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") return rangedResponse(null, size, range, headers);
  if (req.method === "HEAD") return rangedResponse(null, size, range, headers);
  const body = size === 0 ? null : fs.createReadStream(file, range ? { start: range.start, end: range.end } : {});
  return rangedResponse(body, size, range, headers);
}
