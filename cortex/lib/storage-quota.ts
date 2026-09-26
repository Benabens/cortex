import fs from "node:fs";
import path from "node:path";
import { userSlug } from "@/db/context";
import { dataRoot } from "@/lib/courses";
import { intLimit } from "@/lib/billing/env";

/**
 * QUOTA DE STOCKAGE PAR UTILISATEUR + GARDE D'ESPACE LIBRE DU VOLUME.
 *
 * Les fichiers d'un compte vivent sous data/u/<slug>/ (cours créés depuis
 * l'interface : annales, sources, examens, captures ; artefacts personnels des
 * cours historiques). Le total y est plafonné par STORAGE_QUOTA_MB (défaut
 * 200 ; « unlimited » lève ; hors déploiement gardé, aucun plafond). Et quel
 * que soit le compte, aucun envoi n'est accepté si le volume garde moins de
 * 10 % d'espace libre : un conteneur unique dont le disque est plein tombe
 * pour tout le monde. Contrôlé AVANT de lire ou d'écrire, sur la taille
 * annoncée (Content-Length) — la lecture réelle reste bornée par
 * lib/upload-limit.
 */

export const MiB = 1024 * 1024;
export const MIN_FREE_RATIO = 0.10;

export function storageQuotaBytes(): number | null {
  const mb = intLimit("STORAGE_QUOTA_MB", 200);
  return mb === null ? null : mb * MiB;
}

type StatFs = (p: string) => { free: number; total: number };
let _statfs: StatFs | null = null;
/** (tests) remplace la mesure du disque ; null = mesure réelle. */
export function setStatfsForTests(fn: StatFs | null): void { _statfs = fn; }

function diskSpace(p: string): { free: number; total: number } | null {
  if (_statfs) return _statfs(p);
  try {
    const s = fs.statfsSync(p);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

/** Taille totale (octets) des fichiers d'un utilisateur sous data/u/<slug>/. */
export async function userStorageBytes(userId: string): Promise<number> {
  const root = path.join(dataRoot(), "u", userSlug(userId));
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* disparu entre-temps */ } }
    }
  };
  walk(root);
  return total;
}

export type StorageRefusal = { status: 413; error: string };

/**
 * Peut-on accepter `incomingBytes` de plus pour cet utilisateur ? null = oui ;
 * sinon un refus 413 avec la raison (quota du compte, ou volume presque plein).
 */
export async function checkStorage(userId: string, incomingBytes: number): Promise<StorageRefusal | null> {
  const root = dataRoot();
  const disk = diskSpace(fs.existsSync(root) ? root : path.dirname(root));
  if (disk && disk.total > 0) {
    const freeAfter = disk.free - Math.max(0, incomingBytes);
    if (freeAfter / disk.total < MIN_FREE_RATIO) {
      return { status: 413, error: "Espace disque insuffisant sur le serveur pour accepter ce fichier. Réessaie plus tard ; l'équipe est prévenue." };
    }
  }
  const quota = storageQuotaBytes();
  if (quota !== null) {
    const used = await userStorageBytes(userId);
    if (used + Math.max(0, incomingBytes) > quota) {
      const mb = (n: number) => Math.round(n / MiB);
      return {
        status: 413,
        error: `Quota de stockage atteint : ${mb(used)} Mo utilisés sur ${mb(quota)} Mo. Supprime des annales ou des fichiers importés (page Sources) pour libérer de la place.`,
      };
    }
  }
  return null;
}

/** Taille annoncée d'une requête (Content-Length), 0 si absente. */
export function declaredBytes(req: Request): number {
  const raw = req.headers.get("content-length");
  return raw && /^\d+$/.test(raw.trim()) ? Number(raw) : 0;
}
