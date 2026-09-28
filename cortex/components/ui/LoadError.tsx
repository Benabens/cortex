import { RotateCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";

/**
 * ÉTAT D'ERREUR DE CHARGEMENT, partagé par les écrans de données : un écran qui
 * échoue doit le DIRE et offrir une reprise — jamais rester en squelette (audit
 * de pré-lancement : l'écran de révision avalait l'erreur et chargeait à l'infini).
 * Sans `onRetry` (erreur définitive), le message reste, sans bouton.
 */
export function LoadError({ title, hint, onRetry }: { title: string; hint?: string; onRetry?: () => void }) {
  return (
    <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center" role="alert">
      <WifiOff className="size-6 text-danger-hi" strokeWidth={2} aria-hidden="true" />
      <p className="text-[0.95rem] font-medium text-ink-1">{title}</p>
      {hint && <p className="max-w-xs text-[0.85rem] leading-relaxed text-ink-3">{hint}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
          Réessayer
        </Button>
      )}
    </Panel>
  );
}
