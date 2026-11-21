import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * RENDU DE PAGES PDF EN PNG (pdftoppm), pour les images-étalon et l'index des annales.
 * Le PDF vient de l'utilisateur : une page géante (jusqu'à 5 m de côté) ou un fichier qui
 * fait boucler poppler faisait manquer de mémoire le seul conteneur, ou bloquait le worker
 * (audit du 14/11/2026, 🟠 18). Chaque rendu a donc un délai, tué par SIGKILL, et une
 * taille plafonnée.
 */

/**
 * Côté long d'une page rendue, en pixels. `-scale-to` remplace la résolution (`-r`) : 1 400 px
 * est la taille d'une page A4 à 120 dpi, celle d'avant le plafond. Plus grand ne sert pas le
 * modèle de vision et grossirait les images, qui comptent dans le quota du volume.
 */
export const PAGE_MAX_PX = 1400;
const TIMEOUT_MS = 60_000;

/**
 * Le premier binaire de `names` qui répond à `versionArgs`, ou null. Un binaire qui sort en erreur
 * sur sa version (pdftoppm -v sur certaines versions) compte s'il existe à ce chemin absolu.
 */
export function findBinary(names: string[], versionArgs: string[]): string | null {
  for (const bin of names) {
    try {
      execFileSync(bin, versionArgs, { stdio: "ignore", timeout: 10_000 });
      return bin;
    } catch {
      if (bin.includes("/") && fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

/** Un binaire pdftoppm est-il disponible ? */
export function findPdftoppm(): string | null {
  return findBinary(["pdftoppm", "/usr/bin/pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"], ["-v"]);
}

/** Rend les pages `firstPage` (1 par défaut) à `lastPage` de `pdf` en `<outPrefix>-<n>.png`. Lève si pdftoppm échoue ou dépasse le délai. */
export function renderPdfPages(bin: string, pdf: string, outPrefix: string, opts: { firstPage?: number; lastPage: number; timeoutMs?: number }): void {
  execFileSync(bin, ["-png", "-scale-to", String(PAGE_MAX_PX), "-f", String(opts.firstPage ?? 1), "-l", String(opts.lastPage), pdf, outPrefix], {
    stdio: "ignore",
    timeout: opts.timeoutMs ?? TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}
