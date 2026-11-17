/**
 * RETROUVER UN ORIGINAL SUR L'ORDINATEUR (compte gratuit, lib/originals) — côté navigateur.
 *
 * File System Access (Chrome et Edge sur ordinateur) : l'étudiant choisit UNE fois le dossier du
 * cours, son accès est gardé dans IndexedDB (par cours), et Cortex y cherche le fichier par son nom,
 * puis le confirme par sa taille et son empreinte SHA-256 — celle relevée à l'import. Ailleurs
 * (Safari, Firefox, téléphone), `localFilesSupported()` est faux : la page dit d'ouvrir le fichier
 * depuis l'ordinateur. Rien n'est envoyé : la recherche et l'empreinte se font dans le navigateur.
 */

export type WantedFile = { name: string; rel: string | null; path: string; size: number; sha256: string };

/** Ce que l'API File System Access expose ici (types minimaux, sans dépendre de lib.dom). */
export type DirHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
};
export type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };

export type Found =
  | { status: "found"; file: File; where: string }
  | { status: "changed"; where: string }
  | { status: "missing" };

const MAX_DEPTH = 8;
const MAX_ENTRIES = 20_000;
const SKIP = new Set(["node_modules", ".git", "Library", "$RECYCLE.BIN"]);

export function localFilesSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/** Noms sous lesquels le fichier peut se trouver : celui d'origine, et celui rangé par Cortex. */
export function candidateNames(w: WantedFile): Set<string> {
  return new Set([w.name, w.rel ?? "", w.path].map(base).filter(Boolean));
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cherche le fichier dans `root` (sous-dossiers compris, bornés) : même nom, même taille, même
 * empreinte → trouvé ; même nom mais contenu différent → `changed` (modifié depuis l'import).
 */
export async function findLocalFile(root: DirHandle, wanted: WantedFile): Promise<Found> {
  const names = candidateNames(wanted);
  let seen = 0;
  let changed: string | null = null;
  const walk = async (dir: DirHandle, prefix: string, depth: number): Promise<{ file: File; where: string } | null> => {
    for await (const h of dir.values()) {
      if (++seen > MAX_ENTRIES) return null;
      if (h.kind === "directory") {
        if (depth >= MAX_DEPTH || h.name.startsWith(".") || SKIP.has(h.name)) continue;
        const hit = await walk(h, `${prefix}${h.name}/`, depth + 1);
        if (hit) return hit;
        continue;
      }
      if (!names.has(h.name.toLowerCase())) continue;
      const file = await h.getFile();
      const where = `${prefix}${h.name}`;
      if (file.size === wanted.size && (await sha256Hex(await file.arrayBuffer())) === wanted.sha256) return { file, where };
      changed ??= where;
    }
    return null;
  };
  const hit = await walk(root, "", 0);
  if (hit) return { status: "found", ...hit };
  return changed ? { status: "changed", where: changed } : { status: "missing" };
}

/* ---------------------------------------------------- dossier mémorisé (IndexedDB, par cours) */

const DB = "cortex-local-files";
const STORE = "dirs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savedFolder(courseId: string): Promise<DirHandle | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(courseId);
      req.onsuccess = () => resolve((req.result as DirHandle | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveFolder(courseId: string, dir: DirHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dir, courseId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* navigation privée : le dossier sera redemandé */ }
}

/** Fenêtre de choix du dossier (geste de l'utilisateur requis). null si annulé. */
export async function pickFolder(): Promise<DirHandle | null> {
  try {
    const pick = (window as unknown as { showDirectoryPicker: (o: { mode: "read"; id?: string }) => Promise<DirHandle> }).showDirectoryPicker;
    return await pick({ mode: "read", id: "cortex-cours" });
  } catch {
    return null;
  }
}

/** Le navigateur a-t-il encore l'accès ? `ask` : le redemander (geste de l'utilisateur requis). */
export async function folderAccess(dir: DirHandle, ask: boolean): Promise<boolean> {
  const opts = { mode: "read" as const };
  if ((await dir.queryPermission?.(opts)) === "granted") return true;
  return ask ? (await dir.requestPermission?.(opts)) === "granted" : false;
}

/**
 * Type sous lequel le fichier trouvé est ouvert. Ouvert dans l'origine de Cortex : seuls les PDF,
 * images et textes s'affichent ; une page HTML ou un document Office n'est jamais rendu ici (il
 * s'ouvre depuis l'ordinateur), pour qu'aucun script d'un fichier importé ne tourne dans l'app.
 */
export function viewableType(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", tex: "text/plain; charset=utf-8",
  };
  return types[ext] ?? null;
}
