import { getDocumentProxy } from "unpdf";
import { freeToolLimits } from "./config";

/** Refus d'un dépôt, AVANT l'admission : un fichier invalide ne consomme ni quota ni appel. */
export type UploadRefusal = "no_file" | "too_many_files" | "file_too_large" | "not_pdf" | "too_many_pages";

/** PDF reconnu à ses octets (l'en-tête peut être précédé de quelques octets), jamais au nom. */
function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

export async function validateUploads(files: Uint8Array[]): Promise<UploadRefusal | null> {
  const limits = freeToolLimits();
  if (!files.length) return "no_file";
  if (files.length > limits.maxFiles) return "too_many_files";
  for (const f of files) {
    if (f.byteLength > limits.maxFileBytes) return "file_too_large";
    if (!looksLikePdf(f)) return "not_pdf";
  }
  for (const f of files) {
    let pages: number;
    try { pages = (await getDocumentProxy(new Uint8Array(f))).numPages; } catch { return "not_pdf"; }
    if (pages > limits.maxPagesPerFile) return "too_many_pages";
  }
  return null;
}
