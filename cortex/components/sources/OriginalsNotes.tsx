import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { OriginalsInfo } from "@/lib/ux/sources";

/**
 * Textes des originaux d'un compte gratuit (décision du 17/11/2026, lib/originals) : ses fichiers
 * restent sur son ordinateur, Cortex n'en garde que l'index. Mêmes mots partout : « sur ton
 * ordinateur », « index », « Premium » (abonnement en cours, ou achat dans l'année).
 */

const PREMIUM_HREF = "/compte#credits";

const day = (s: string) =>
  new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** Sous la zone d'import : ce que devient le fichier déposé. */
export function LocalImportNote() {
  return (
    <div data-testid="originals-local-note" className="flex gap-3 rounded-lg border border-line bg-surface-2/30 px-3.5 py-3">
      <HardDrive className="mt-0.5 size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
      <div className="text-[0.8rem] leading-relaxed text-ink-2">
        <p>
          Ton fichier reste sur ton ordinateur : Cortex lit son texte, puis le retire de ses serveurs. Seul
          l’index est gardé, pour la recherche et tes examens blancs.
        </p>
        <p className="mt-1 text-ink-3">
          <a href={PREMIUM_HREF} className="font-medium text-accent-hi underline underline-offset-4">Passe Premium</a>{" "}
          pour le garder dans le cloud et y accéder partout.
        </p>
      </div>
    </div>
  );
}

/** Dans la liste des fichiers : l'original n'est plus sur le serveur. */
export function OnComputerBadge() {
  return (
    <span
      title="Cortex garde son index, pas le fichier."
      className="ml-2 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[0.68rem] text-ink-3"
    >
      <HardDrive className="size-3" strokeWidth={2} aria-hidden="true" />
      sur ton ordinateur
    </span>
  );
}

/** Fichiers encore dans le cloud d'un compte qui n'est plus (ou pas) Premium : le jour où ils partent. */
export function CloudRetentionBanner({ originals }: { originals: OriginalsInfo }) {
  if (originals.home !== "local" || !originals.purgeOn || originals.cloudFiles <= 0) return null;
  const date = day(originals.purgeOn);
  const n = originals.cloudFiles;
  const files = `${n} fichier${n > 1 ? "s" : ""}`;
  return (
    <div role="status" data-testid="originals-retention" className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm text-ink-1">
      <p className="font-semibold">
        {originals.wasPremium ? "Ton Premium a pris fin" : "Les comptes gratuits ne gardent plus leurs fichiers dans le cloud"}
      </p>
      <p className="mt-1 text-ink-2">
        Tes {files} déjà dans le cloud y {n > 1 ? "restent" : "reste"} jusqu’au {date}. Ensuite, Cortex ne garde que
        leur index : tes examens blancs ne changent pas, et tu pourras renvoyer un fichier depuis ton ordinateur.
      </p>
      <Button variant="primary" size="md" href={PREMIUM_HREF} className="mt-3">
        {originals.wasPremium ? "Reprendre Premium" : "Passer Premium"}
      </Button>
    </div>
  );
}

/**
 * Devenu Premium avec des fichiers restés sur l'ordinateur : les renvoyer les remet dans le cloud
 * (même empreinte : l'index ne change pas). Un dossier réimporté les renvoie tous d'un coup.
 */
export function BackToCloudNote({ originals }: { originals: OriginalsInfo }) {
  const n = originals.onComputer.length;
  if (originals.home !== "cloud" || n === 0) return null;
  return (
    <div role="status" data-testid="originals-back-to-cloud" className="rounded-xl border border-line bg-surface-2/30 p-4 text-sm text-ink-1">
      <p className="font-semibold">{n} fichier{n > 1 ? "s sont restés" : " est resté"} sur ton ordinateur</p>
      <p className="mt-1 text-ink-2">
        Tu es Premium : réimporte le dossier de ce cours pour {n > 1 ? "les" : "le"} remettre dans le cloud. Cortex
        reconnaît chaque fichier à son empreinte, son index ne change pas.
      </p>
    </div>
  );
}
