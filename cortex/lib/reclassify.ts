import path from "node:path";
import { q } from "@/db/q";
import { getCourse } from "@/lib/courses";
import { UserFacingError } from "@/lib/i18n/user-error";
import { absoluteOf } from "@/lib/originals/intake";
import { localOriginal } from "@/lib/originals/registry";
import { purgePdfPages } from "@/lib/page-cache";
import { storage } from "@/lib/storage";

/**
 * RECLASSER UN FICHIER MAL RANGÉ (audit ingestion du 16/11/2026, P1-2 ; décision du 21/11) : une
 * annale déposée en support de cours, ou l'inverse. Le fichier change de dossier, comme s'il avait
 * été déposé dans la bonne zone : une annale vit dans refs/ (vision des pages, format, annales de
 * référence), un support dans lectures/. L'année et le type d'épreuve choisis sont gardés dans
 * `exam_labels` : ils priment sur ce que le nom du fichier laisse deviner, à chaque ingestion.
 *
 * Ce module ne fait que ranger et noter en base ; la route lance ensuite le job d'ingestion du
 * cours (gratuit), qui réindexe le corpus depuis les fichiers : l'ancien chemin disparaît, sans
 * doublon. Un original resté sur l'ordinateur d'un compte gratuit (lib/originals) n'est plus sur
 * le serveur : son index est reclassé sur place, et l'ingestion le garde tel quel.
 */

export type ExamKind = "final" | "midterm";
export type Classification = { as: "exam"; kind: ExamKind; year: number | null } | { as: "support" };

const MIN_YEAR = 1950;
export const maxExamYear = () => new Date().getUTCFullYear() + 1;
const SUPPORT_DIR = "lectures";
const EXAM_TYPES = new Set(["final", "midterm"]);

/** Le corps de la requête, validé ; null s'il ne décrit pas un classement possible. */
export function parseClassification(body: unknown): Classification | null {
  const b = (body ?? {}) as { as?: unknown; kind?: unknown; year?: unknown };
  if (b.as === "support") return { as: "support" };
  if (b.as !== "exam" || (b.kind !== "final" && b.kind !== "midterm")) return null;
  if (b.year === null || b.year === undefined || b.year === "") return { as: "exam", kind: b.kind, year: null };
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > maxExamYear()) return null;
  return { as: "exam", kind: b.kind, year };
}

/** Ce que la route doit faire après le classement : rien (déjà ainsi), ou réindexer. */
export type Reclassified = { path: string; changed: boolean };

/**
 * Reclasse le fichier `srcPath` du cours `course` (cours courant). Lève une UserFacingError
 * (404 inconnu, 409 contenu en lecture seule). `beforeWrite` part une fois la demande validée,
 * avant la première écriture (la route y réserve le job d'ingestion). N'écrit rien en base avant
 * que le fichier soit rangé.
 */
export async function reclassifySource(
  course: string, srcPath: string, c: Classification,
  opts: { beforeWrite?: () => Promise<void> } = {},
): Promise<Reclassified> {
  const cfg = getCourse(course);
  if (cfg.paths?.contentRel === "..") throw new UserFacingError({ code: "course_content_read_only", params: { name: cfg.name } }, 409);
  await q.ensureTable("sources");
  const row = await q.get<{ type: string }>(`SELECT type FROM sources WHERE path = ? ORDER BY id LIMIT 1`, srcPath);
  const from = absoluteOf(course, srcPath);
  if (!row || !from || srcPath.startsWith("uploads/")) throw new UserFacingError({ code: "classify_not_found" }, 404);

  const inRefs = srcPath.startsWith("refs/");
  const base = path.basename(srcPath);
  // Déjà dans le bon dossier : seule l'étiquette change (annale), ou rien du tout (support déjà support).
  const sameFolder = c.as === "exam" ? inRefs : !inRefs && !EXAM_TYPES.has(row.type);
  if (sameFolder && c.as === "support") return { path: srcPath, changed: false };

  const original = await localOriginal(srcPath);
  const onDisk = (await storage().stat(from)) != null;
  if (!onDisk && original?.state !== "local") throw new UserFacingError({ code: "classify_not_found" }, 404);

  await opts.beforeWrite?.();
  const target = sameFolder ? srcPath : await freePath(course, c.as === "exam" ? "refs" : SUPPORT_DIR, base);
  const to = absoluteOf(course, target)!;
  // Original en transit d'un compte gratuit : il reste sur ce disque, jamais dans le seau.
  const putOpts = { exclusive: true, localOnly: original?.state === "transit" };
  const moved = target !== srcPath && onDisk;
  if (moved) {
    const data = await storage().read(from);
    if (!data) throw new UserFacingError({ code: "classify_not_found" }, 404);
    if (!(await storage().put(to, data, putOpts))) throw new UserFacingError({ code: "classify_name_taken" }, 409);
    await storage().remove(from);
  }

  try {
    await recordClassification(srcPath, target, base, c, onDisk, original != null);
  } catch (e) {
    // La base n'a rien gardé : le fichier revient à sa place, l'index d'avant reste juste.
    if (moved) {
      const data = await storage().read(to);
      if (data && (await storage().put(from, data, putOpts))) await storage().remove(to);
    }
    throw e;
  }
  // Images des pages rendues pour l'ancien emplacement (lib/page-cache) : refaites à la demande.
  if (target !== srcPath) purgePdfPages(course, base);
  return { path: target, changed: true };
}

/** Le classement en base, d'un bloc : étiquette, annale déposée, index d'un original resté sur l'ordinateur. */
async function recordClassification(
  srcPath: string, target: string, base: string, c: Classification, onDisk: boolean, hasOriginal: boolean,
): Promise<void> {
  await q.tx(async () => {
    await q.ensureTable("exam_labels");
    await q.ensureTable("exam_refs");
    if (target !== srcPath) {
      if (hasOriginal) await q.run(`UPDATE local_originals SET path = ? WHERE path = ?`, target, srcPath);
      await q.run(`DELETE FROM exam_labels WHERE path = ?`, srcPath);
      await q.run(`DELETE FROM exam_refs WHERE path = ?`, srcPath);
    }
    const title = base.replace(/\.[^.]+$/, "");
    if (c.as === "exam") {
      await q.run(
        `INSERT INTO exam_labels (path, kind, year) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, year = excluded.year`,
        target, c.kind, c.year,
      );
      // Rangée par l'étudiant depuis l'app : retirable comme une annale déposée.
      await q.run(
        `INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,1)
         ON CONFLICT(path) DO UPDATE SET year = excluded.year, kind = excluded.kind`,
        target, title, c.year, c.kind,
      );
    }
    // Index seul (original sur l'ordinateur) : l'ingestion le réécrit tel quel, il est donc
    // reclassé ici. Un fichier sur le disque est réindexé par le job, depuis son nouveau chemin.
    if (!onDisk) await retypeIndex(srcPath, target, c);
  });
}

/** Un nom libre dans le dossier visé (`nom-2.pdf`…) : ni fichier rangé, ni source indexée. */
async function freePath(course: string, dir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 50; i++) {
    const candidate = `${dir}/${i === 1 ? base : `${stem}-${i}${ext}`}`;
    const abs = absoluteOf(course, candidate);
    if (!abs) break;
    const taken = (await storage().stat(abs)) != null
      || !!(await q.get(`SELECT 1 AS one FROM sources WHERE path = ? LIMIT 1`, candidate))
      || !!(await localOriginal(candidate));
    if (!taken) return candidate;
  }
  throw new UserFacingError({ code: "classify_name_taken" }, 409);
}

async function retypeIndex(srcPath: string, target: string, c: Classification): Promise<void> {
  const type = c.as === "exam" ? c.kind : "course_pdf";
  const year = c.as === "exam" ? c.year : null;
  const ids = (await q.all<{ id: number }>(`SELECT id FROM sources WHERE path = ?`, srcPath)).map((r) => r.id);
  await q.run(`UPDATE sources SET path = ?, type = ?, year = ? WHERE path = ?`, target, type, year, srcPath);
  for (const id of ids) {
    const items = await q.all<{ id: number; anchor: string | null }>(`SELECT id, anchor FROM items WHERE source_id = ?`, id);
    for (const it of items) {
      if (it.anchor?.startsWith(srcPath)) await q.run(`UPDATE items SET anchor = ? WHERE id = ?`, target + it.anchor.slice(srcPath.length), it.id);
    }
  }
}
