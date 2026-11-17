/**
 * Contrôle d'un document AU DÉPÔT : il doit s'ouvrir. Un PDF abîmé ou chiffré rangé dans le
 * cours n'apprenait rien à personne, et une annale de ce genre faisait échouer chaque ingestion
 * suivante (audit ingestion du 16/11/2026). Même consigne que le rapport d'ingestion.
 */
import { getDocumentProxy } from "unpdf";
import { extractOfficeText, OfficeDocumentError } from "@/lib/office-documents";
import { failureStatus, problemMessage } from "@/lib/ingest-report";
import { pdfMaxPages } from "@/lib/ingest-limits";

export type DocumentProblem = { status: 413 | 422; message: string };

/** null si le document s'ouvre (ou n'est ni PDF ni Office) ; sinon le refus à rendre. */
export async function unreadableDocument(data: Buffer, extension: string): Promise<DocumentProblem | null> {
  const ext = extension.toLowerCase();
  if (ext === ".pdf") {
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return { status: 422, message: problemMessage("unreadable") };
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const pages = pdf.numPages;
      await pdf.destroy().catch(() => {});
      // Audit fuites I9 : un PDF démesuré (ou piégé) tiendrait l'import, dans le conteneur du site.
      const max = pdfMaxPages();
      if (pages > max) return { status: 413, message: `Ce PDF a ${pages} pages, au-delà des ${max} permises : découpe-le (par chapitre, par exemple) avant de l'envoyer.` };
      return null;
    } catch (error) {
      return { status: 422, message: problemMessage(failureStatus(error)) };
    }
  }
  if (ext === ".docx" || ext === ".pptx") {
    try {
      await extractOfficeText(data, ext);
      return null;
    } catch (error) {
      if (error instanceof OfficeDocumentError) return { status: error.status, message: error.message };
      return { status: 422, message: problemMessage("unreadable") };
    }
  }
  return null;
}
