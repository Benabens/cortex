import { cn } from "@/lib/ux/cn";

/**
 * CortexMark « Dissolution v2 » : logo définitif, validé le 28/09/2026.
 * Un anneau ouvert en « C » ; l'ouverture (haut-droite) se prolonge en points
 * décroissants, dont le premier, violet, est le nœud actif.
 * Masters hors dépôt : ~/Projects/brand-logos/cortex/favori/01r-v2-*.svg.
 *
 * - Encre = text-ink-1 (via `currentColor`) ; seul le nœud est violet. #7a5cff
 *   est une décision de marque, volontairement distincte du token --color-violet.
 * - À 24 px et moins, coupe 16 px : les deux petits points du master tombent
 *   sous le pixel, donc le dernier est retiré et les autres grossissent.
 * - `spinning` : rotation lente → spinner de chargement (statique si
 *   prefers-reduced-motion, via la règle globale). L'anneau est centré dans le
 *   viewBox : la rotation reste concentrique.
 */

export const MARK_NODE = "#7a5cff";

type Dot = { cx: number; cy: number; r: number };
type Geometry = { viewBox: string; ring: string; node: Dot; dots: Dot[] };

const FULL: Geometry = {
  viewBox: "0 0 256 256",
  ring: "M235.9 158A112 112 0 1 1 128 16L128 58A70 70 0 1 0 191.2 158Z",
  node: { cx: 162.1, cy: 43.6, r: 20 },
  dots: [
    { cx: 198.7, cy: 70.7, r: 14 },
    { cx: 215, cy: 101.4, r: 9 },
  ],
};

/* Grille de 16 : coupes de l'anneau sur x = 8 et y = 10 (bords nets au pixel),
   blancs égaux (1,64 px) entre nœud, point et extrémité de l'anneau. */
const SMALL: Geometry = {
  viewBox: "0 0 16 16",
  ring: "M14.708 10A7 7 0 1 1 8 1L8 3.75A4.25 4.25 0 1 0 11.75 10Z",
  node: { cx: 11, cy: 3.242, r: 1.75 },
  dots: [{ cx: 13.555, cy: 7.113, r: 1.25 }],
};

const SMALL_MAX = 24;

export function CortexMark({
  size = 28,
  spinning = false,
  className,
  title,
}: {
  size?: number;
  spinning?: boolean;
  className?: string;
  title?: string;
}) {
  const g = size <= SMALL_MAX ? SMALL : FULL;
  return (
    <svg
      width={size}
      height={size}
      viewBox={g.viewBox}
      fill="currentColor"
      className={cn("shrink-0 text-ink-1", spinning && "mark-spin", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={g.ring} />
      <circle cx={g.node.cx} cy={g.node.cy} r={g.node.r} fill={MARK_NODE} />
      {g.dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} />
      ))}
    </svg>
  );
}
