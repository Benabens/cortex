import { cn } from "@/lib/ux/cn";
import { CortexMark, MARK_NODE } from "./CortexMark";

/** Couleur du point du wordmark : le violet du nœud du mark (un seul violet dans le lockup). */
export const WORDMARK_DOT = MARK_NODE;

/**
 * Lockup : mark Dissolution v2 (CortexMark, logo définitif validé le 28/09) + wordmark
 * « cortex. » selon la décision typo du 28/09 : Funnel Display 700, approche -0.04em,
 * suivi d'un point ROND (pastille CSS ~0.17em, plus présent que le point du texte) en
 * #7a5cff, le violet du nœud. Le mark est posé directement sur le fond, sans tuile.
 * Les réglages fixes sont en styles inline pour survivre aux pages d'erreur sans CSS global.
 */
export function Wordmark({
  className,
  markSize = 30,
  textSize = "1.35rem",
}: {
  className?: string;
  markSize?: number;
  /** Taille du texte « cortex » ; la pastille suit en em. */
  textSize?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <CortexMark size={markSize} />
      <span
        className="font-display inline-flex items-baseline leading-none text-ink-1"
        style={{ fontSize: textSize, fontWeight: 700, letterSpacing: "-0.04em" }}
      >
        cortex
        <span
          aria-hidden="true"
          className="inline-block rounded-full"
          style={{ width: "0.17em", height: "0.17em", marginLeft: "0.035em", background: WORDMARK_DOT }}
        />
      </span>
    </span>
  );
}
