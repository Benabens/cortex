import { Unzip, UnzipInflate } from "fflate";

export const MiB = 1024 * 1024;
export const SOURCE_FILE_MAX_BYTES = 30 * MiB;
export const ZIP_TOTAL_MAX_BYTES = 1024 * MiB;
export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_RATIO = 200;

export const FOLDER_EXTENSIONS = [
  "pdf", "docx", "pptx", "txt", "md", "html", "htm",
  "png", "jpg", "jpeg", "webp", "tex", "c", "h",
] as const;

const allowed = new RegExp(`\\.(${FOLDER_EXTENSIONS.join("|")})$`, "i");

export type FolderImportEntry = { file: File; relativePath: string };
export type FolderImportRefusal = { name: string; reason: string };
export type ZipImportLimits = {
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxRatio: number;
};

const DEFAULT_ZIP_LIMITS: ZipImportLimits = {
  maxEntryBytes: SOURCE_FILE_MAX_BYTES,
  maxTotalBytes: ZIP_TOTAL_MAX_BYTES,
  maxEntries: ZIP_MAX_ENTRIES,
  maxRatio: ZIP_MAX_RATIO,
};

function relativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function isHidden(value: string): boolean {
  return value.split("/").some((part) => part.startsWith("."));
}

/** Filtrage navigateur purement ergonomique ; le serveur applique les mêmes bornes. */
export function prepareFolderImport(files: Iterable<File>): {
  accepted: FolderImportEntry[];
  rejected: FolderImportRefusal[];
} {
  const accepted: FolderImportEntry[] = [];
  const rejected: FolderImportRefusal[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const rel = relativePath(file);
    const reject = (reason: string) => rejected.push({ name: rel, reason });
    if (isHidden(rel)) { reject("fichier caché ignoré"); continue; }
    if (!allowed.test(file.name)) { reject("format non pris en charge"); continue; }
    if (!file.size) { reject("fichier vide"); continue; }
    if (file.size > SOURCE_FILE_MAX_BYTES) { reject("30 Mo maximum par fichier"); continue; }
    const signature = `${file.name.toLocaleLowerCase()}\0${file.size}`;
    if (seen.has(signature)) { reject("doublon ignoré"); continue; }
    seen.add(signature);
    accepted.push({ file, relativePath: rel });
  }
  return { accepted, rejected };
}

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´≡±‗¾¶§÷¸°¨·¹³²■ ";

/** fflate expose les noms non-UTF-8 comme des octets Latin-1 ; CP437 est le défaut ZIP historique. */
function decodeZipName(value: string): string {
  if (![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x80 && code <= 0x9f;
  })) return value;
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x80 && code <= 0xff ? CP437_HIGH[code - 0x80] : character;
  }).join("");
}

function safeArchivePath(raw: string): string | null {
  if (!raw || raw.includes("\0")) return null;
  const slash = raw.replace(/\\/g, "/");
  if (slash.startsWith("/") || slash.startsWith("//") || /^[a-zA-Z]:\//.test(slash)) return null;
  const parts = slash.split("/");
  if (parts.some((part) => part === "..")) return null;
  const clean = parts.filter((part) => part && part !== ".");
  return clean.length ? clean.join("/") : null;
}

function archiveRoot(file: File): string {
  return relativePath(file).replace(/\\/g, "/").replace(/\.zip$/i, "");
}

function extractedFile(data: Uint8Array[], name: string, path: string): File {
  const file = new File(data.map((chunk) => chunk.slice().buffer as ArrayBuffer), name);
  Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path });
  return file;
}

type ExpandedArchive = { files: File[]; rejected: FolderImportRefusal[]; fatal?: string };
type ExtractionBudget = { entries: number; total: number };

async function extractArchive(file: File, limits: ZipImportLimits, budget: ExtractionBudget): Promise<ExpandedArchive> {
  const files: File[] = [];
  const rejected: FolderImportRefusal[] = [];
  const root = archiveRoot(file);
  let archiveTotal = 0;
  let fatal = "";
  const active: Array<{ terminate(): void }> = [];

  const unzip = new Unzip((entry) => {
    const decoded = decodeZipName(entry.name);
    const safe = safeArchivePath(decoded);
    const isDirectory = decoded.endsWith("/");
    if (isDirectory) return;
    budget.entries++;
    if (budget.entries > limits.maxEntries) fatal = `archive refusée : trop de fichiers (${limits.maxEntries} maximum)`;
    if (entry.originalSize != null && entry.originalSize > limits.maxEntryBytes && !/\.zip$/i.test(decoded)) {
      rejected.push({ name: safe ? `${root}/${safe}` : `${root}/${decoded}`, reason: `${limits.maxEntryBytes} octets maximum par fichier extrait` });
    }
    if (entry.originalSize != null && budget.total + entry.originalSize > limits.maxTotalBytes) {
      fatal = `archive refusée : taille décompressée totale supérieure à ${Math.round(limits.maxTotalBytes / MiB)} Mo`;
    }
    if (entry.size != null && entry.size > 0 && entry.originalSize != null && entry.originalSize / entry.size > limits.maxRatio) {
      fatal = `archive refusée : ratio de décompression supérieur à ${limits.maxRatio}`;
    }
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    let oversized = entry.originalSize != null && entry.originalSize > limits.maxEntryBytes && !/\.zip$/i.test(decoded);
    entry.ondata = (error, chunk, final) => {
      if (error) { fatal = `archive illisible : ${error.message}`; return; }
      if (chunk) {
        entryBytes += chunk.byteLength;
        archiveTotal += chunk.byteLength;
        budget.total += chunk.byteLength;
        if (budget.total > limits.maxTotalBytes) fatal = `archive refusée : taille décompressée totale supérieure à ${Math.round(limits.maxTotalBytes / MiB)} Mo`;
        if ((entry.size != null && entry.size > 0 && entryBytes / entry.size > limits.maxRatio)
          || (file.size > 0 && archiveTotal / file.size > limits.maxRatio)) {
          fatal = `archive refusée : ratio de décompression supérieur à ${limits.maxRatio}`;
        }
        if (entryBytes <= limits.maxEntryBytes || /\.zip$/i.test(decoded)) chunks.push(chunk);
      }
      if (!final || fatal) return;
      if (entryBytes > limits.maxEntryBytes && !/\.zip$/i.test(decoded)) {
        if (!oversized) rejected.push({ name: safe ? `${root}/${safe}` : `${root}/${decoded}`, reason: `${limits.maxEntryBytes} octets maximum par fichier extrait` });
        oversized = true;
      }
      if (!safe) {
        rejected.push({ name: `${root}/${decoded}`, reason: "chemin dangereux refusé" });
      } else if (entryBytes <= limits.maxEntryBytes || /\.zip$/i.test(safe)) {
        files.push(extractedFile(chunks, safe.split("/").at(-1)!, `${root}/${safe}`));
      }
    };
    active.push(entry);
    entry.start();
  });
  unzip.register(UnzipInflate);

  try {
    const reader = file.stream().getReader();
    while (!fatal) {
      const { done, value } = await reader.read();
      if (done) { unzip.push(new Uint8Array(), true); break; }
      unzip.push(value, false);
    }
    if (fatal) await reader.cancel().catch(() => undefined);
  } catch (error) {
    fatal = `archive illisible : ${(error as Error).message}`;
  }
  if (fatal) {
    for (const entry of active) entry.terminate();
    return { files: [], rejected: [{ name: relativePath(file), reason: fatal }], fatal };
  }
  return { files, rejected };
}

async function expandArchive(file: File, limits: ZipImportLimits, depth: number, budget: ExtractionBudget): Promise<ExpandedArchive> {
  const extracted = await extractArchive(file, limits, budget);
  if (extracted.fatal) return extracted;
  const files: File[] = [];
  const rejected = [...extracted.rejected];
  for (const child of extracted.files) {
    if (!/\.zip$/i.test(child.name)) { files.push(child); continue; }
    if (depth >= 1) {
      rejected.push({ name: relativePath(child), reason: "archives imbriquées limitées à un niveau" });
      continue;
    }
    const nested = await expandArchive(child, limits, depth + 1, budget);
    if (nested.fatal) rejected.push(...nested.rejected);
    else { files.push(...nested.files); rejected.push(...nested.rejected); }
  }
  return { files, rejected };
}

/** Développe les ZIP côté navigateur, puis applique exactement le filtrage de l'import de dossier. */
export async function prepareCourseImport(
  input: Iterable<File>,
  overrides: Partial<ZipImportLimits> = {},
): Promise<{ accepted: FolderImportEntry[]; rejected: FolderImportRefusal[] }> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  const expanded: File[] = [];
  const archiveRefusals: FolderImportRefusal[] = [];
  for (const file of input) {
    if (!/\.zip$/i.test(file.name)) { expanded.push(file); continue; }
    const result = await expandArchive(file, limits, 0, { entries: 0, total: 0 });
    expanded.push(...result.files);
    archiveRefusals.push(...result.rejected);
  }
  const filtered = prepareFolderImport(expanded);
  return { accepted: filtered.accepted, rejected: [...archiveRefusals, ...filtered.rejected] };
}
