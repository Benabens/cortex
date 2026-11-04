import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Portabilité : un lien direct vers l'archive (le serveur répond en pièce
 * jointe, en flux). Pas d'état client : le navigateur gère le téléchargement.
 */
export function ExportData() {
  return (
    <section className="d2-card p-5 sm:p-6" aria-labelledby="export-title">
      <h2 id="export-title" className="text-xl font-semibold text-ink-1">Mes données</h2>
      <p className="mt-1 max-w-2xl text-[0.9rem] text-ink-2">
        Télécharge une archive de tout ce que Cortex garde sur toi : profil, cours, corpus importé, examens générés,
        faiblesses, historique de crédits et fichiers. Format tar.gz, JSON par table.
      </p>
      <Button size="sm" variant="secondary" className="mt-3" href="/api/account/export">
        <Download className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
        Exporter mes données
      </Button>
    </section>
  );
}
