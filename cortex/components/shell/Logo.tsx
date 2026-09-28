import { cn } from "@/lib/ux/cn";
import { CortexMark, MARK_NODE } from "./CortexMark";

/**
 * Wordmark « cortex. » — le mark est le logo Dissolution v2 (CortexMark). Posé
 * directement sur le fond : le C est le héros, pas de tuile carrée derrière.
 */
export function Wordmark({
  className,
  markSize = 30,
}: {
  className?: string;
  markSize?: number;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <CortexMark size={markSize} />
      <span className="font-display text-[1.35rem] font-semibold leading-none tracking-tight text-ink-1">
        cortex<span style={{ color: MARK_NODE }}>.</span>
      </span>
    </span>
  );
}
