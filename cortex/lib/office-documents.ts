import * as cheerio from "cheerio";
import mammoth from "mammoth";
import path from "node:path";
import yauzl from "yauzl";
import JSZip from "jszip";

export const MAX_OFFICE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 10_000;

export class OfficeDocumentError extends Error {
  constructor(message: string, public readonly status: 413 | 422) {
    super(message);
    this.name = "OfficeDocumentError";
  }
}

function checkArchive(buffer: Buffer, maxUncompressedBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new OfficeDocumentError("Document Office corrompu ou illisible.", 422));
        return;
      }
      let total = 0;
      let entries = 0;
      const fail = (error: OfficeDocumentError) => {
        zip.close();
        reject(error);
      };
      zip.on("error", () => fail(new OfficeDocumentError("Document Office corrompu ou illisible.", 422)));
      zip.on("entry", (entry) => {
        entries++;
        total += entry.uncompressedSize;
        if (entries > MAX_OFFICE_ENTRIES || total > maxUncompressedBytes) {
          fail(new OfficeDocumentError(`Document Office trop volumineux une fois décompressé (maximum ${Math.round(maxUncompressedBytes / 1024 / 1024)} Mo).`, 413));
          return;
        }
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.readEntry();
    });
  });
}

async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]));
  const texts: string[] = [];
  for (const slide of slides) {
    const xml = await zip.file(slide)!.async("string");
    const $ = cheerio.load(xml, { xmlMode: true });
    const text = $("a\\:t, t").map((_, node) => $(node).text()).get().join(" ").trim();
    if (text) texts.push(text);
  }
  return texts.join("\n\n");
}

/** Extrait uniquement le texte Office ; les images embarquées sont volontairement ignorées. */
export async function extractOfficeText(
  buffer: Buffer,
  extension: string,
  options: { maxUncompressedBytes?: number } = {},
): Promise<string> {
  const ext = extension.toLowerCase();
  const max = options.maxUncompressedBytes ?? MAX_OFFICE_UNCOMPRESSED_BYTES;
  try {
    await checkArchive(buffer, max);
    const text = ext === ".docx"
      ? (await mammoth.extractRawText({ buffer })).value
      : ext === ".pptx"
        ? await extractPptx(buffer)
        : "";
    const clean = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) throw new OfficeDocumentError("Document Office vide ou sans texte exploitable.", 422);
    return clean;
  } catch (error) {
    if (error instanceof OfficeDocumentError) throw error;
    throw new OfficeDocumentError(`${path.extname(`f${ext}`).slice(1).toUpperCase()} corrompu ou illisible.`, 422);
  }
}
