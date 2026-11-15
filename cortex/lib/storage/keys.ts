import path from "node:path";

/**
 * Fichiers du dossier de données qui ne sont PAS des fichiers de cours, donc
 * jamais dans le seau : bases SQLite (dev), caches régénérables, temporaires.
 * `rel` : chemin relatif au dossier de données, séparateur `/`.
 */
export function isObjectStored(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (parts[0] === ".page-cache" || parts[0] === ".export-tmp" || parts[0] === "backups") return false;
  const name = parts[parts.length - 1];
  if (name === ".DS_Store" || name.includes(".cortex-dl-")) return false;
  return !/\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(name);
}

/** Chemin local → chemin relatif au dossier de données (`/`), ou null s'il en sort. */
export function relativeToRoot(root: string, file: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
