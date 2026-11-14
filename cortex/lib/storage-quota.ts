import fs from "node:fs";
import path from "node:path";
import { userSlug } from "@/db/context";
import { dataRoot } from "@/lib/courses";
import { floatLimit, guardsActive, intLimit } from "@/lib/billing/env";

/**
 * QUOTA DE STOCKAGE PAR UTILISATEUR + GARDE D'ESPACE LIBRE DU VOLUME.
 *
 * Les fichiers d'un compte vivent sous data/u/<slug>/ (cours créés depuis
 * l'interface : annales, sources, examens, captures ; artefacts personnels des
 * cours historiques). Les images de pages rendues n'y sont plus (lib/page-cache).
 *
 * Quota d'un compte, lié à ce qu'il a payé (audit du 14/11/2026, axe 2) :
 *  - base modeste pour un compte gratuit : STORAGE_QUOTA_MB (défaut 150 ;
 *    « unlimited » lève tout quota ; hors déploiement gardé, aucun plafond), au
 *    plus STORAGE_FREE_VOLUME_PERCENT (défaut 5) % du volume ;
 *  - + STORAGE_QUOTA_MB_PER_USD (défaut 100) Mo par dollar de revenu net sur 12
 *    mois glissants (lib/billing/revenue) ;
 *  - plafonné à STORAGE_QUOTA_MAX_MB (défaut 3072), que le propriétaire a d'office ;
 *  - jamais plus que la place utile du volume (hors marge d'espace libre).
 * Revenu illisible (base indisponible) : la base s'applique.
 *
 * Et quel que soit le compte, aucun envoi n'est accepté si le volume garde moins
 * de 10 % d'espace libre : un conteneur unique dont le disque est plein tombe
 * pour tout le monde. Contrôlé AVANT de lire ou d'écrire, sur la taille
 * annoncée (Content-Length) — la lecture réelle reste bornée par
 * lib/upload-limit.
 */

export const MiB = 1024 * 1024;
export const MIN_FREE_RATIO = 0.10;

export function storageMinFreeRatio(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.STORAGE_MIN_FREE_PERCENT;
  if (raw == null || raw.trim() === "") return MIN_FREE_RATIO;
  const percent = Number(raw);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent / 100 : MIN_FREE_RATIO;
}

/** Base du quota (compte gratuit, avant la borne du volume) ; null = aucun quota. */
export function storageQuotaBytes(): number | null {
  const mb = intLimit("STORAGE_QUOTA_MB", 150);
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

function volume(): { free: number; total: number } | null {
  const root = dataRoot();
  const disk = diskSpace(fs.existsSync(root) ? root : path.dirname(root));
  return disk && disk.total > 0 ? disk : null;
}

/** Marge d'espace libre exigée d'un envoi (fraction du volume). */
function minFreeRatio(): number {
  return _statfs ? MIN_FREE_RATIO : storageMinFreeRatio();
}

/**
 * Quota de stockage de CE compte (octets), lié à son revenu net — cf. l'en-tête.
 * null = aucun quota (STORAGE_QUOTA_MB=unlimited, ou dev sans garde-fous).
 */
export async function storageQuotaBytesFor(userId: string): Promise<number | null> {
  const base = storageQuotaBytes();
  if (base === null) return null;
  const disk = volume();
  const usable = disk ? Math.floor((1 - minFreeRatio()) * disk.total) : Infinity;
  const maxMb = intLimit("STORAGE_QUOTA_MAX_MB", 3072);
  const max = maxMb === null ? Infinity : Math.max(base, maxMb * MiB);
  const { isOwner } = await import("@/lib/billing/owner");
  let quota: number;
  if (await isOwner(userId)) quota = max;
  else {
    const percent = floatLimit("STORAGE_FREE_VOLUME_PERCENT", 5);
    const freeBase = disk && percent !== null ? Math.min(base, Math.floor((percent / 100) * disk.total)) : base;
    let netUsd = 0;
    if (guardsActive()) {
      try {
        const { accountRevenue } = await import("@/lib/billing/revenue");
        netUsd = Math.max(0, (await accountRevenue(userId)).netUsd);
      } catch { /* revenu illisible : la base s'applique */ }
    }
    const perUsd = floatLimit("STORAGE_QUOTA_MB_PER_USD", 100);
    const growth = netUsd <= 0 ? 0 : perUsd === null ? Infinity : Math.floor(perUsd * netUsd * MiB);
    quota = Math.min(max, freeBase + growth);
  }
  quota = Math.min(quota, usable);
  return Number.isFinite(quota) ? quota : null;
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
 * Marge absolue exigée pour une GÉNÉRATION (quelques artefacts : PDF d'examen,
 * corrigé, figures). La règle des 10 % convient à un ENVOI — on refuse d'ajouter
 * un gros fichier sur un volume qui se remplit — mais l'appliquer à la
 * génération bloquerait tout le monde, y compris un compte qui vient de payer,
 * dès que le volume est rempli par l'usage normal (5 Go / 200 Mo par compte =
 * une vingtaine de comptes suffisent). Ici : refuser seulement quand il n'y a
 * vraiment plus de place pour écrire.
 */
export const GENERATION_MIN_FREE_BYTES = 64 * 1024 * 1024;

/**
 * Peut-on accepter `incomingBytes` de plus pour cet utilisateur ? null = oui ;
 * sinon un refus 413 avec la raison (quota du compte, ou volume presque plein).
 */
export async function checkStorage(
  userId: string,
  incomingBytes: number,
  opts: { minFreeBytes?: number; what?: string } = {},
): Promise<StorageRefusal | null> {
  const disk = volume();
  if (disk) {
    const freeAfter = disk.free - Math.max(0, incomingBytes);
    // Envoi : 10 % du volume (on protège la marge). Génération : une marge
    // ABSOLUE (cf. GENERATION_MIN_FREE_BYTES) — sinon un volume rempli par
    // l'usage payé priverait tous les comptes de génération.
    const tooFull = opts.minFreeBytes != null
      ? freeAfter < opts.minFreeBytes
      : freeAfter / disk.total < minFreeRatio();
    if (tooFull) {
      return {
        status: 413,
        error: `Espace disque insuffisant sur le serveur pour ${opts.what ?? "accepter ce fichier"}. Réessaie plus tard ; l'équipe est prévenue.`,
      };
    }
  }
  const quota = await storageQuotaBytesFor(userId);
  if (quota !== null) {
    const used = await userStorageBytes(userId);
    if (used + Math.max(0, incomingBytes) > quota) {
      const mb = (n: number) => Math.round(n / MiB);
      return {
        status: 413,
        error: `Quota de stockage atteint : ${mb(used)} Mo utilisés sur ${mb(quota)} Mo. Supprime des annales ou des fichiers importés (page Sources) pour libérer de la place ; le quota grandit aussi avec tes achats.`,
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
