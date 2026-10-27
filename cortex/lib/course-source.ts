import fs from "node:fs";
import path from "node:path";
import { currentUser } from "@/db/context";
import { coursePaths, getCourse } from "@/lib/courses";
import { classifyFile } from "@/lib/import-folder";
import { PublicFetchError, readPublicHttps, type PublicFetcher } from "@/lib/public-https";
import { checkStorage } from "@/lib/storage-quota";

/**
 * AJOUT D'UN SUPPORT À UN COURS sans passer par le navigateur : une adresse https
 * publique (PDF, page web, texte) ou un texte collé. Mêmes garde-fous que l'import
 * de l'app (POST /api/sources/import) : plafond par fichier, types sans rien
 * d'exécutable, quota de stockage, chemin confiné au cours, contenu d'un cours
 * historique en lecture seule. L'adresse est lue par la lecture durcie commune
 * (lib/public-https : https seulement, adresses publiques seulement, sans
 * redirection). Le fichier est seulement rangé : la préparation du cours
 * (job « prepare ») l'ingère avec le reste.
 */

export const SOURCE_CATEGORIES = ["past_exam", "lecture", "exercises", "notes"] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** Catégorie → dossier du cours (mêmes dossiers que le classifieur de l'import). */
const BUCKET: Record<SourceCategory, string> = { past_exam: "refs", lecture: "lectures", exercises: "series", notes: "notes" };

/** Même plafond par fichier que l'import de l'app. */
export const SOURCE_MAX_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export class SourceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export type SavedSource = { name: string; folder: string; bytes: number; contentType: string };

const ACCEPT = "application/pdf, text/html, application/xhtml+xml, text/markdown, text/plain;q=0.9";

/** Type annoncé + premiers octets → extension acceptée, ou null. Un « PDF » sans signature PDF est refusé. */
function extensionFor(contentType: string | null, body: Buffer): ".pdf" | ".html" | ".md" | ".txt" | null {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const isPdf = body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "application/pdf") return isPdf ? ".pdf" : null;
  if (ct === "text/html" || ct === "application/xhtml+xml") return ".html";
  if (ct === "text/markdown") return ".md";
  if (ct === "text/plain") return ".txt";
  return null;
}

/** Nom de fichier sûr : titre donné, sinon dernier segment de l'URL ; sans extension d'origine, borné. */
function fileName(title: string | undefined, url: string | null, ext: string): string {
  let base = title?.trim() ?? "";
  if (!base && url) {
    try { base = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? ""); } catch { base = ""; }
  }
  base = base.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 80);
  return `${base || "support"}${ext}`;
}

/** Range `data` dans le dossier du cours, sans jamais écraser un fichier existant. */
async function store(courseId: string, name: string, category: SourceCategory | undefined, data: Buffer, contentType: string): Promise<SavedSource> {
  const folder = category ? BUCKET[category] : classifyFile(name).bucket;
  // Un cours HISTORIQUE lit son contenu à la racine du dépôt, en lecture seule (comme l'import de l'app).
  if (folder !== "refs" && getCourse(courseId).paths?.contentRel === "..") {
    throw new SourceError(409, "Le contenu de ce cours est en lecture seule : seules des annales (category past_exam) peuvent y être ajoutées.");
  }
  const storage = await checkStorage(currentUser(), data.length);
  if (storage) throw new SourceError(storage.status, storage.error);

  const { refsDir, contentRoot } = coursePaths(courseId);
  const dir = path.resolve(folder === "refs" ? refsDir : path.join(contentRoot, folder));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const abs = path.join(dir, candidate);
    if (!abs.startsWith(dir + path.sep)) break;
    try {
      fs.writeFileSync(abs, data, { flag: "wx" });
      return { name: candidate, folder, bytes: data.length, contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new SourceError(409, "Trop de fichiers du même nom dans ce cours : donne un autre titre.");
}

export async function addTextSource(courseId: string, a: { text: string; title?: string; category?: SourceCategory }): Promise<SavedSource> {
  const data = Buffer.from(a.text, "utf8");
  if (!a.text.trim()) throw new SourceError(400, "Texte vide.");
  if (data.length > SOURCE_MAX_BYTES) throw new SourceError(413, "Texte trop volumineux.");
  return store(courseId, fileName(a.title ?? "notes", null, ".md"), a.category, data, "text/markdown");
}

export async function addUrlSource(
  courseId: string, a: { url: string; title?: string; category?: SourceCategory }, fetcher: PublicFetcher = readPublicHttps,
): Promise<SavedSource> {
  let res;
  try {
    res = await fetcher(a.url, { maxBytes: SOURCE_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, accept: ACCEPT, userAgent: "Cortex-Sources/1.0" });
  } catch (e) {
    if (!(e instanceof PublicFetchError)) throw e;
    if (e.reason === "too_large") throw new SourceError(413, `Document trop volumineux (maximum ${SOURCE_MAX_BYTES / 1024 / 1024} Mo).`);
    if (e.reason === "redirect") {
      throw new SourceError(400, `Cette adresse redirige${e.location ? ` vers ${e.location.slice(0, 300)}` : ""} : redonne directement l'adresse finale (https).`);
    }
    if (e.reason === "blocked" || e.reason === "invalid_url") {
      throw new SourceError(400, "Adresse refusée : seules les adresses https publiques sont lues (pas de réseau interne ni d'adresse locale).");
    }
    throw new SourceError(400, `Lecture impossible (${e.message}).`);
  }
  const ext = extensionFor(res.contentType, res.body);
  if (!ext) {
    throw new SourceError(415, `Type de document non pris en charge (${(res.contentType ?? "inconnu").slice(0, 60)}) : PDF, page web ou texte seulement.`);
  }
  if (!res.body.length) throw new SourceError(400, "Document vide.");
  return store(courseId, fileName(a.title, a.url, ext), a.category, res.body, (res.contentType ?? "").split(";")[0].trim());
}
