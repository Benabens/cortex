/** Passage du rapport d'ingestion entre le script (enfant) et le worker : un fichier temporaire. */
import fs from "node:fs";
import { INGEST_REPORT_ENV, type IngestReport } from "@/lib/ingest-report";

export function writeIngestReport(report: IngestReport, file = process.env[INGEST_REPORT_ENV]): void {
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify(report));
}

export function readIngestReport(file: string): IngestReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IngestReport;
    return Array.isArray(parsed?.files) ? parsed : null;
  } catch {
    return null;
  }
}
