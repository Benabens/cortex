import { createHash } from "node:crypto";
import path from "node:path";
import { storage as fileStore } from "@/lib/storage";

/**
 * NOM ET ÉCRITURE D'UN FICHIER DÉPOSÉ dans un cours (import de dossier, zone Annales). Les noms
 * restent en ASCII (les routes qui servent les fichiers n'acceptent que lui) : les accents sont
 * retirés (« Prüfung » → « Prufung »), le reste devient « _ ». Deux noms qui se confondent alors
 * (« 期末考试2023 » et « 期中考试2023 ») ne s'écrasent plus : l'écriture est exclusive, avec un
 * suffixe -2, -3… (audit ingestion du 16/11/2026).
 */
export function storedFileName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Range `data` dans `dir` sous `name`, ou `nom-2`, `nom-3`… si un fichier DIFFÉRENT le porte
 * déjà (export rangé par semaine : Week1/slides.pdf et Week3/slides.pdf). Seul un contenu
 * identique (empreinte sha256, jamais la taille) est un doublon : rien n'est écrit et son nom est
 * rendu. null : trop de fichiers du même nom, ou nom qui sortirait du dossier.
 */
export async function storeUnique(dir: string, name: string, data: Buffer): Promise<{ name: string; duplicate: boolean } | null> {
  const root = path.resolve(dir);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const digest = sha256(data);
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const abs = path.join(root, candidate);
    if (!abs.startsWith(root + path.sep)) return null;
    if (await fileStore().put(abs, data, { exclusive: true })) return { name: candidate, duplicate: false };
    const existing = await fileStore().read(abs);
    if (existing && sha256(existing) === digest) return { name: candidate, duplicate: true };
  }
  return null;
}
