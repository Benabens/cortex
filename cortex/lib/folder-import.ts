export const MiB = 1024 * 1024;
export const SOURCE_FILE_MAX_BYTES = 30 * MiB;

export const FOLDER_EXTENSIONS = [
  "pdf", "docx", "pptx", "txt", "md", "html", "htm",
  "png", "jpg", "jpeg", "webp", "tex", "c", "h",
] as const;

const allowed = new RegExp(`\\.(${FOLDER_EXTENSIONS.join("|")})$`, "i");

export type FolderImportEntry = { file: File; relativePath: string };
export type FolderImportRefusal = { name: string; reason: string };

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
