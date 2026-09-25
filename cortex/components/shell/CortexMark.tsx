import { cn } from "@/lib/ux/cn";

/**
 * CortexMark « Dissolution » (placeholder officiel en attendant le logo final).
 * Un « C » formé de 19 points le long d'un cercle, ouvert sur la droite
 * (entre ~1 h 40 et ~4 h 40). Le point de tête (haut-droite) est le plus gros
 * et le plus clair ; en tournant en antihoraire les points rapetissent et
 * s'estompent (violet #8b7bff → clair, opacité décroissante) : lecture
 * « signal qui se dissout » — un C, un neurone.
 *
 * - SVG pur, paramétrable (`size`), net à toute taille, swappable.
 * - `spinning` : rotation lente → spinner de chargement signature
 *   (statique si prefers-reduced-motion, via la règle globale).
 */

const DOTS = 19;
const SWEEP = 270; // degrés couverts par les points → ouverture de 90° côté droit
const START = 50; // position du point de tête : 50° horaire depuis 12 h (~1 h 40)
const R = 11.5; // rayon du cercle porteur (viewBox 32)
const R_MAX = 2.7; // rayon du point de tête
const R_MIN = 0.75; // rayon du dernier point de la queue

/** Interpole #f2efff (tête, quasi blanc violet) → #8b7bff (marque). */
function dotColor(t: number): string {
  const from = [0xf2, 0xef, 0xff];
  const to = [0x8b, 0x7b, 0xff];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * Math.min(1, t * 1.6)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/* Points précalculés une fois, coordonnées FIGÉES en chaînes (toFixed) :
   valeurs identiques côté serveur et client → zéro mismatch d'hydratation. */
const MARK_DOTS = Array.from({ length: DOTS }, (_, i) => {
  const t = i / (DOTS - 1); // 0 = tête, 1 = queue
  const angle = ((START - i * (SWEEP / (DOTS - 1))) * Math.PI) / 180; // antihoraire
  return {
    x: (16 + R * Math.sin(angle)).toFixed(3),
    y: (16 - R * Math.cos(angle)).toFixed(3),
    r: (R_MAX - (R_MAX - R_MIN) * Math.pow(t, 0.92)).toFixed(3),
    fill: dotColor(t),
    opacity: (1 - 0.78 * Math.pow(t, 1.15)).toFixed(3),
  };
});

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
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", spinning && "mark-spin", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {MARK_DOTS.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.fill} opacity={d.opacity} />
      ))}
    </svg>
  );
}
