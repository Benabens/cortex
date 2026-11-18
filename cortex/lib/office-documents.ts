import * as cheerio from "cheerio";
import mammoth from "mammoth";
import path from "node:path";
import yauzl from "yauzl";
import JSZip from "jszip";
import { ommlToLatex, topLevelMath } from "@/lib/omml";

export const MAX_OFFICE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 10_000;
export type OfficeExtension = ".docx" | ".pptx";

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
      let streamed = 0;
      let entries = 0;
      let settled = false;
      const fail = (error: OfficeDocumentError) => {
        if (settled) return;
        settled = true;
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
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new OfficeDocumentError("Document Office corrompu ou illisible.", 422));
            return;
          }
          stream.on("data", (chunk: Buffer) => {
            streamed += chunk.length;
            if (streamed > maxUncompressedBytes) {
              stream.destroy();
              fail(new OfficeDocumentError(`Document Office trop volumineux une fois décompressé (maximum ${Math.round(maxUncompressedBytes / 1024 / 1024)} Mo).`, 413));
            }
          });
          stream.on("error", () => fail(new OfficeDocumentError("Document Office corrompu ou illisible.", 422)));
          stream.on("end", () => { if (!settled) zip.readEntry(); });
          stream.resume();
        });
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** DOCX : chaque formule devient un passage de texte `$…$`, que mammoth lit ensuite à sa place. */
async function docxWithMathAsText(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file("word/document.xml");
  const xml = doc ? await doc.async("string") : "";
  if (!xml.includes("m:oMath")) return buffer;
  const $ = cheerio.load(xml, { xmlMode: true });
  topLevelMath($).each((_, el) => {
    $(el).replaceWith(`<w:r><w:t xml:space="preserve">${escapeXml(`$${ommlToLatex($, el)}$`)}</w:t></w:r>`);
  });
  zip.file("word/document.xml", $.xml());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Relations d'une partie OPC : identifiant → { type (fin de l'URI), cible résolue dans le paquet }. */
async function partRels(zip: JSZip, part: string): Promise<Map<string, { type: string; target: string }>> {
  const out = new Map<string, { type: string; target: string }>();
  const file = zip.file(path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`));
  if (!file) return out;
  const $ = cheerio.load(await file.async("string"), { xmlMode: true });
  $("Relationship").each((_, el) => {
    const id = $(el).attr("Id");
    const target = $(el).attr("Target");
    if (!id || !target || $(el).attr("TargetMode") === "External") return;
    const resolved = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(part), target));
    out.set(id, { type: ($(el).attr("Type") ?? "").split("/").at(-1) ?? "", target: resolved });
  });
  return out;
}

/**
 * Diapositives dans l'ordre de la présentation (p:sldIdLst de presentation.xml) : l'ordre des
 * fichiers internes (slideN.xml) est celui de leur création, pas celui où on les montre.
 * Sans liste lisible, repli sur l'ordre des numéros de fichier.
 */
async function slideOrder(zip: JSZip): Promise<string[]> {
  const presentation = zip.file("ppt/presentation.xml");
  if (presentation) {
    const rels = await partRels(zip, "ppt/presentation.xml");
    const $ = cheerio.load(await presentation.async("string"), { xmlMode: true });
    // Une entrée sans relation, ou vers une partie absente (paquet abîmé), est sautée.
    const ordered = $("p\\:sldIdLst > p\\:sldId").toArray().flatMap((el) => {
      const rel = rels.get($(el).attr("r:id") ?? "");
      return rel?.type === "slide" && zip.file(rel.target) ? [rel.target] : [];
    });
    if (ordered.length) return [...new Set(ordered)];
  }
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]));
}

/** Formes d'une page de notes qui ne sont pas les notes : aperçu de la diapositive, numéro, en-tête, pied, date. */
const NOTES_FURNITURE = new Set(["sldImg", "sldNum", "hdr", "ftr", "dt"]);

/** Texte d'une partie PowerPoint. `notesOnly` : sans les formes annexes d'une page de notes. */
function pptxText(xml: string, notesOnly = false): string {
  const $ = cheerio.load(xml, { xmlMode: true });
  // Formules en LaTeX, à leur place ; la copie image de secours (mc:Fallback) n'est pas lue en double.
  topLevelMath($).each((_, el) => { $(el).replaceWith(`<a:t>${escapeXml(`$${ommlToLatex($, el)}$`)}</a:t>`); });
  let nodes = $("a\\:t, t").filter((_, node) => $(node).parents("mc\\:Fallback").length === 0);
  if (notesOnly) nodes = nodes.filter((_, node) => !NOTES_FURNITURE.has($(node).closest("p\\:sp").find("p\\:nvPr > p\\:ph").attr("type") ?? ""));
  return nodes.map((_, node) => $(node).text()).get().join(" ").trim();
}

async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const texts: string[] = [];
  for (const slide of await slideOrder(zip)) {
    const text = pptxText(await zip.file(slide)!.async("string"));
    // Les notes portent souvent l'explication de l'enseignant : elles suivent leur diapositive.
    const notesPart = [...(await partRels(zip, slide)).values()].find((rel) => rel.type === "notesSlide")?.target;
    const notesFile = notesPart ? zip.file(notesPart) : null;
    const notes = notesFile ? pptxText(await notesFile.async("string"), true) : "";
    const block = [text, notes && `Notes: ${notes}`].filter(Boolean).join("\n");
    if (block) texts.push(block);
  }
  return texts.join("\n\n");
}

/** Extrait uniquement le texte Office ; les images embarquées sont volontairement ignorées. */
export async function extractOfficeText(
  buffer: Buffer,
  extension: OfficeExtension,
  options: { maxUncompressedBytes?: number } = {},
): Promise<string> {
  const ext = extension.toLowerCase();
  const max = options.maxUncompressedBytes ?? MAX_OFFICE_UNCOMPRESSED_BYTES;
  try {
    await checkArchive(buffer, max);
    const text = ext === ".docx"
      ? (await mammoth.extractRawText({ buffer: await docxWithMathAsText(buffer) })).value
      : await extractPptx(buffer);
    const clean = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) throw new OfficeDocumentError("Document Office vide ou sans texte exploitable.", 422);
    return clean;
  } catch (error) {
    if (error instanceof OfficeDocumentError) throw error;
    throw new OfficeDocumentError(`${path.extname(`f${ext}`).slice(1).toUpperCase()} corrompu ou illisible.`, 422);
  }
}
