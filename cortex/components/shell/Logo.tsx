import { cn } from "@/lib/ux/cn";
import { CortexMark } from "./CortexMark";

/** Couleur du point du wordmark (décision typo 2026-09-28 : violet plus franc). */
export const WORDMARK_DOT = "#7a5cff";

/**
 * Wordmark « cortex. » (décision typo 2026-09-28) : Funnel Display 700, approche
 * -0.04em, suivi d'un point ROND (pastille CSS ~0.17em, plus présent que le point du
 * texte) en #7a5cff. Le mark reste le « C » en points (CortexMark, placeholder
 * « Dissolution »), posé directement sur le fond. Les réglages fixes sont en styles
 * inline pour survivre aux pages d'erreur sans CSS global.
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
