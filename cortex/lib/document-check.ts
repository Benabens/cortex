/**
 * Contrôle d'un document AU DÉPÔT : il doit s'ouvrir. Un PDF abîmé ou chiffré rangé dans le
 * cours n'apprenait rien à personne, et une annale de ce genre faisait échouer chaque ingestion
 * suivante (audit ingestion du 16/11/2026). Même consigne que le rapport d'ingestion.
 */
import { currentLocale } from "@/lib/i18n/current";
import { getDocumentProxy } from "unpdf";
import { extractOfficeText, OfficeDocumentError } from "@/lib/office-documents";
import { failureStatus } from "@/lib/ingest-report";
import { pdfMaxPages } from "@/lib/ingest-limits";
import { errorText, userError, type UserError } from "@/lib/i18n/user-error";

export type DocumentProblem = { status: 413 | 422; message: string; error: UserError };

function documentProblem(status: 413 | 422, error: UserError): DocumentProblem {
  return { status, error, message: errorText(currentLocale(), error) };
}

function officeProblem(error: OfficeDocumentError): UserError {
  const max = error.message.match(/^Document Office trop volumineux une fois décompressé \(maximum (\d+) Mo\)\.$/);
  if (max) return userError("office_document_uncompressed_too_large", { maxMb: Number(max[1]) });
  if (error.message === "Document Office vide ou sans texte exploitable.") return userError("office_document_empty");
  const format = error.message.match(/^([A-Z0-9]+) corrompu ou illisible\.$/);
  if (format) return userError("office_format_corrupt", { format: format[1] });
  return userError("office_document_corrupt");
}

/** null si le document s'ouvre (ou n'est ni PDF ni Office) ; sinon le refus à rendre. */
export async function unreadableDocument(data: Buffer, extension: string): Promise<DocumentProblem | null> {
  const ext = extension.toLowerCase();
  if (ext === ".pdf") {
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return documentProblem(422, userError("document_unreadable"));
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const pages = pdf.numPages;
      await pdf.destroy().catch(() => {});
      // Audit fuites I9 : un PDF démesuré (ou piégé) tiendrait l'import, dans le conteneur du site.
      const max = pdfMaxPages();
      if (pages > max) return documentProblem(413, userError("pdf_page_limit", { pages, max }));
      return null;
    } catch (error) {
      return documentProblem(422, userError(failureStatus(error) === "encrypted" ? "document_encrypted" : "document_unreadable"));
    }
  }
  if (ext === ".docx" || ext === ".pptx") {
    try {
      await extractOfficeText(data, ext);
      return null;
    } catch (error) {
      if (error instanceof OfficeDocumentError) return documentProblem(error.status, officeProblem(error));
      return documentProblem(422, userError("document_unreadable"));
    }
  }
  return null;
}
