import fs from "node:fs";
import path from "node:path";
import type { CourseFiles, FileEntry, FileStat, PutOptions, ServeOptions } from "@/lib/storage";
import { serveLocalFile } from "@/lib/storage/http";
import { clearTransit, markTransit } from "@/lib/storage/transit";

/** Fichiers sous `dir`, récursivement, sans suivre les liens symboliques. */
/** Jamais des données de cours : un contenu de cours tiré d'un dépôt peut en contenir. */
const NEVER_WALKED = new Set(["node_modules", ".git", ".next"]);

export function walkFiles(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!NEVER_WALKED.has(e.name)) stack.push(p); }
      else if (e.isFile()) {
        try { const s = fs.statSync(p); out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs }); } catch { /* disparu entre-temps */ }
      }
    }
  }
  return out;
}

export function statLocal(file: string): FileStat | null {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch { return null; }
}

export function writeLocal(file: string, body: Buffer | Uint8Array | string, exclusive = false): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, body, exclusive ? { flag: "wx" } : undefined);
    return true;
  } catch (e) {
    if (exclusive && (e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Le disque, tel quel : le comportement d'avant la couture, sans aucune variable. */
export class LocalFsStore implements CourseFiles {
  readonly kind = "local" as const;
  constructor(readonly root: string) {}

  /**
   * Sur le disque, `localOnly` ne change que le repère de transit (lib/storage/transit) : une
   * migration du volume vers un seau, ou sa sauvegarde, saute ce fichier.
   */
  async put(file: string, body: Buffer | Uint8Array | string, opts: PutOptions = {}) {
    const ok = writeLocal(file, body, opts.exclusive);
    if (ok) (opts.localOnly ? markTransit : clearTransit)(this.root, file);
    return ok;
  }

  async read(file: string) {
    try { return fs.readFileSync(file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EISDIR") return null;
      throw e;
    }
  }

  async stat(file: string) {
    return statLocal(file);
  }

  async list(dir: string) {
    return walkFiles(dir);
  }

  async remove(target: string) {
    fs.rmSync(target, { recursive: true, force: true });
    clearTransit(this.root, target);
  }

  async serve(file: string, req: Request, opts: ServeOptions) {
    const s = statLocal(file);
    if (!s) return null;
    return serveLocalFile(file, s.size, req, { ...opts.headers, "content-type": opts.contentType });
  }

  async usageBytes(dir: string) {
    return walkFiles(dir).reduce((n, f) => n + f.size, 0);
  }

  async withLocalDir<T>(_paths: string[], fn: () => Promise<T>) {
    return fn();
  }
}
