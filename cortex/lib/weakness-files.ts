import { uploadsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * PIÈCES JOINTES D'UNE FAIBLESSE — une seule zone de dépôt accepte une capture (PNG, JPG,
 * GIF, WEBP) ou un PDF. Le type se reconnaît aux PREMIERS OCTETS, jamais au nom ni au type
 * MIME annoncés par le navigateur : un fichier inattendu est refusé au lieu d'être rangé en
 * « .png ». Le texte d'un PDF est extrait sur le serveur (unpdf, comme les annales).
 */

export type AttachmentKind = "png" | "jpg" | "gif" | "webp" | "pdf";

/** Poids maximal d'une pièce jointe (l'enveloppe multipart est bornée par UPLOAD_LIMITS.image). */
export const ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;

export const ATTACHMENT_FORMATS_LABEL = "PDF, PNG, JPG, GIF ou WEBP";

const startsWith = (buf: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => buf[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Type réel d'après la signature binaire ; null si ce n'est ni une image acceptée ni un PDF. */
export function sniffAttachment(buf: Uint8Array): AttachmentKind | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(buf, ascii("GIF87a")) || startsWith(buf, ascii("GIF89a"))) return "gif";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "webp";
  // La norme tolère quelques octets avant l'en-tête « %PDF- » : on le cherche dans le premier Kio.
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 1024));
  if (head.includes("%PDF-")) return "pdf";
  return null;
}

export const isImage = (k: AttachmentKind | null): k is Exclude<AttachmentKind, "pdf"> => !!k && k !== "pdf";

/** Texte d'un PDF, espaces normalisés et plafonné. Chaîne vide si le PDF n'a pas de couche texte (scan). */
export async function pdfText(buf: Uint8Array, maxChars: number): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Range la pièce jointe dans le dossier d'uploads du compte ; renvoie le nom de fichier stocké. */
export function saveAttachment(buf: Uint8Array, kind: AttachmentKind): string {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${kind}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}
