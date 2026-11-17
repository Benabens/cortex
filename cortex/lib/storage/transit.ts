import fs from "node:fs";
import path from "node:path";
import { relativeToRoot } from "@/lib/storage/keys";

/**
 * REPÈRES DE TRANSIT (PutOptions.localOnly, lib/originals). Un fichier écrit en transit laisse un
 * repère vide à `<dossier de données>/.transit/<même chemin>`. Le repère est sur le disque : tous
 * les process du conteneur le voient (serveur web qui reçoit l'envoi, worker dont le job tient
 * withLocalDir sur le même cours). Ainsi :
 *  - withLocalDir ne renvoie jamais au seau un fichier repéré, même écrit PENDANT le job ;
 *  - la migration du volume vers le seau et la sauvegarde du volume le sautent.
 * Le repère part avec le fichier (`remove`) ou quand le fichier est réécrit hors transit (Premium).
 * Hypothèse : serveur web et workers partagent le disque (un seul conteneur, cf. DEPLOY.md).
 */
export const TRANSIT_DIR = ".transit";

function markerOf(root: string, file: string): string | null {
  const rel = relativeToRoot(root, file);
  return rel && !rel.startsWith(`${TRANSIT_DIR}/`) ? path.join(root, TRANSIT_DIR, ...rel.split("/")) : null;
}

export function inTransit(root: string, file: string): boolean {
  const m = markerOf(root, file);
  return !!m && fs.existsSync(m);
}

export function markTransit(root: string, file: string): void {
  const m = markerOf(root, file);
  if (!m) return;
  fs.mkdirSync(path.dirname(m), { recursive: true });
  fs.writeFileSync(m, "");
}

/** Retire le repère d'un fichier, ou ceux de tout un dossier. */
export function clearTransit(root: string, target: string): void {
  const m = markerOf(root, target);
  if (m) fs.rmSync(m, { recursive: true, force: true });
}

/** Chemins relatifs (séparateur `/`) des fichiers en transit sous `root`. */
export function transitFiles(root: string): Set<string> {
  const base = path.join(root, TRANSIT_DIR);
  const out = new Set<string>();
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.add(r);
    }
  };
  walk(base, "");
  return out;
}
