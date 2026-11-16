import { Gunzip, Unzip, UnzipInflate } from "fflate";

export const MiB = 1024 * 1024;
export const SOURCE_FILE_MAX_BYTES = 30 * MiB;
export const ZIP_TOTAL_MAX_BYTES = 1024 * MiB;
export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_RATIO = 200;

export const FOLDER_EXTENSIONS = [
  "pdf", "docx", "pptx", "txt", "md", "html", "htm", "tex", "c", "h",
] as const;

const allowed = new RegExp(`\\.(${FOLDER_EXTENSIONS.join("|")})$`, "i");

/**
 * Photos et images : refusées avec une consigne. Cortex n'en lit pas le texte (pas d'OCR) ; elles
 * étaient envoyées, comptées dans le quota, puis jamais lues (audit ingestion du 16/11/2026).
 */
export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?)$/i;
/** Anciens formats Office et formats voisins : refusés avec la consigne de ré-enregistrement. */
export const LEGACY_FILE = /\.(doc|ppt|xls|odt|odp|ods|rtf|epub|key|pages|numbers)$/i;
export const LEGACY_REFUSAL = "ancien format ou format non lu : enregistre-le en .docx, .pptx ou .pdf, puis dépose-le de nouveau.";

/**
 * Archives développées dans le navigateur : zip, export Canvas (.imscc, un zip) et sauvegarde
 * Moodle (.mbz : tar.gz, ou zip pour les anciennes, dont les fichiers sont rangés par empreinte et
 * nommés dans files.xml). Les exports étaient refusés en bloc (audit ingestion du 16/11/2026).
 */
export const ARCHIVE_FILE = /\.(zip|imscc|mbz)$/i;
/** Fichiers de description d'un export de plateforme (manifeste, réglages) : écartés sans bruit. */
const PLATFORM_METADATA = /\.(xml|qti|dat|json|css|js)$/i;

export const IMAGE_REFUSAL = "photo ou image : Cortex n’en lit pas le texte. Dépose le document d’origine, ou un PDF au texte sélectionnable (scan avec reconnaissance de texte).";

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
    if (IMAGE_FILE.test(file.name)) { reject(IMAGE_REFUSAL); continue; }
    if (LEGACY_FILE.test(file.name)) { reject(LEGACY_REFUSAL); continue; }
    if (!allowed.test(file.name)) { reject("format non pris en charge"); continue; }
    if (!file.size) { reject("fichier vide"); continue; }
    if (file.size > SOURCE_FILE_MAX_BYTES) { reject("30 Mo maximum par fichier"); continue; }
    // Le même chemin deux fois (archive mal formée) ; un même nom dans deux dossiers reste deux
    // fichiers, et le serveur reconnaît un vrai doublon à son contenu (empreinte).
    const signature = rel.toLocaleLowerCase();
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
  return relativePath(file).replace(/\\/g, "/").replace(ARCHIVE_FILE, "");
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

/** Sauvegarde Moodle : tar.gz (Moodle ≥ 2.6) ou zip, puis chaque fichier reprend le nom donné par files.xml. */
async function expandMoodleBackup(file: File, limits: ZipImportLimits, budget: ExtractionBudget): Promise<ExpandedArchive> {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
  const extracted = gzip ? await extractTarGz(file, limits, budget) : await extractArchive(file, limits, budget);
  if (extracted.fatal) return extracted;
  const root = archiveRoot(file);
  const index = extracted.files.find((f) => relativePath(f) === `${root}/files.xml`);
  if (!index) return { files: [], rejected: [...extracted.rejected, { name: relativePath(file), reason: "sauvegarde Moodle sans files.xml : dépose plutôt les fichiers du cours, ou un zip" }] };
  const names = moodleFileNames(await index.text());
  const files: File[] = [];
  const rejected = [...extracted.rejected];
  for (const f of extracted.files) {
    const hash = relativePath(f).match(/\/files\/[0-9a-f]{2}\/([0-9a-f]+)$/i)?.[1];
    const target = hash ? names.get(hash.toLowerCase()) : undefined;
    if (!target) continue;
    const safe = safeArchivePath(target);
    if (!safe) { rejected.push({ name: `${root}/${target}`, reason: "chemin dangereux refusé" }); continue; }
    const renamed = new File([f], safe.split("/").at(-1)!);
    Object.defineProperty(renamed, "webkitRelativePath", { configurable: true, value: `${root}/${safe}` });
    files.push(renamed);
  }
  return { files, rejected };
}

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/&amp;/g, "&");

/** files.xml d'une sauvegarde Moodle : empreinte du contenu → chemin et nom d'origine (premier rencontré). */
function moodleFileNames(xml: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const block of xml.matchAll(/<file\b[^>]*>([\s\S]*?)<\/file>/g)) {
    const tag = (t: string) => xmlText(block[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? "");
    const hash = tag("contenthash").toLowerCase();
    const name = tag("filename");
    if (!hash || !name || name === "." || names.has(hash)) continue;
    names.set(hash, `${tag("filepath")}${name}`.replace(/^\/+/, ""));
  }
  return names;
}

/**
 * Archive tar.gz lue en flux, mêmes bornes que les zip (nombre de fichiers, taille par fichier et
 * totale, ratio). Seuls files.xml et files/ d'une sauvegarde Moodle sont gardés en mémoire.
 */
async function extractTarGz(file: File, limits: ZipImportLimits, budget: ExtractionBudget): Promise<ExpandedArchive> {
  const files: File[] = [];
  const rejected: FolderImportRefusal[] = [];
  const root = archiveRoot(file);
  const text = new TextDecoder();
  let fatal = "";
  let ended = false;
  let longName: string | null = null;
  let pending: Uint8Array = new Uint8Array(0);
  type Entry = { path: string; kind: string; remaining: number; pad: number; chunks: Uint8Array[]; keep: boolean };
  let current: Entry | null = null;

  const finish = (e: Entry) => {
    if (e.kind === "L") { longName = text.decode(concatBytes(e.chunks)).replace(/\0[\s\S]*$/, ""); return; }
    if (!e.keep) return;
    const safe = safeArchivePath(e.path);
    if (safe) files.push(extractedFile(e.chunks, safe.split("/").at(-1)!, `${root}/${safe}`));
  };
  const consume = (data: Uint8Array) => {
    pending = concatBytes([pending, data]);
    let off = 0;
    while (!fatal && !ended) {
      if (current) {
        const n = Math.min(current.remaining, pending.length - off);
        if (current.keep && n > 0) current.chunks.push(pending.slice(off, off + n));
        current.remaining -= n;
        off += n;
        if (current.remaining > 0 || pending.length - off < current.pad) break;
        off += current.pad;
        finish(current);
        current = null;
        continue;
      }
      if (pending.length - off < 512) break;
      const h = pending.subarray(off, off + 512);
      off += 512;
      if (h.every((b) => b === 0)) { ended = true; break; }
      const field = (a: number, b: number) => text.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, "");
      const prefix = field(257, 262) === "ustar" ? field(345, 500) : "";
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      const size = parseInt(field(124, 136).trim() || "0", 8);
      if (!Number.isFinite(size) || size < 0) { fatal = "archive illisible : en-tête tar invalide"; break; }
      const kind = String.fromCharCode(h[156] || 48);
      const regular = kind === "0" || kind === "7";
      // Toute entrée compte dans les bornes, métadonnées tar comprises (nom long L, en-têtes pax x/g).
      budget.entries++;
      budget.total += size;
      if (budget.entries > limits.maxEntries) fatal = `archive refusée : trop de fichiers (${limits.maxEntries} maximum)`;
      if (budget.total > limits.maxTotalBytes) fatal = `archive refusée : taille décompressée totale supérieure à ${Math.round(limits.maxTotalBytes / MiB)} Mo`;
      if (file.size > 0 && budget.total / file.size > limits.maxRatio) fatal = `archive refusée : ratio de décompression supérieur à ${limits.maxRatio}`;
      if (kind === "L" && size > 4096) fatal = "archive illisible : nom de fichier tar trop long";
      let keep = kind === "L";
      if (regular) {
        const wanted = name === "files.xml" || name.startsWith("files/");
        if (wanted && size > limits.maxEntryBytes) rejected.push({ name: `${root}/${name}`, reason: `${limits.maxEntryBytes} octets maximum par fichier extrait` });
        keep = wanted && size <= limits.maxEntryBytes;
      }
      current = { path: name, kind, remaining: size, pad: (512 - (size % 512)) % 512, chunks: [], keep };
    }
    pending = pending.slice(off);
  };

  const gunzip = new Gunzip((chunk) => consume(chunk));
  try {
    const reader = file.stream().getReader();
    while (!fatal && !ended) {
      const { done, value } = await reader.read();
      if (done) { gunzip.push(new Uint8Array(), true); break; }
      gunzip.push(value, false);
    }
    await reader.cancel().catch(() => undefined);
  } catch (error) {
    fatal = `archive illisible : ${(error as Error).message}`;
  }
  if (fatal) return { files: [], rejected: [{ name: relativePath(file), reason: fatal }], fatal };
  return { files, rejected };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
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
    if (!ARCHIVE_FILE.test(file.name)) { expanded.push(file); continue; }
    const budget = { entries: 0, total: 0 };
    const result = /\.mbz$/i.test(file.name)
      ? await expandMoodleBackup(file, limits, budget)
      : await expandArchive(file, limits, 0, budget);
    const platform = !/\.zip$/i.test(file.name);
    expanded.push(...(platform ? result.files.filter((f) => !PLATFORM_METADATA.test(f.name)) : result.files));
    archiveRefusals.push(...result.rejected);
  }
  const filtered = prepareFolderImport(expanded);
  return { accepted: filtered.accepted, rejected: [...archiveRefusals, ...filtered.rejected] };
}
